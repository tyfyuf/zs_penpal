import type { VectorChunk, VectorIndex, VectorIndexFileStatus, VectorIndexStatus, VectorIndexSource, VectorSearchHit } from '@shared/types'
import { createHash } from 'node:crypto'
import { buildSnapshot, readDoc, readResource, readVectorIndex, writeVectorIndex } from './file.service'
import { nowIso } from '../util'
import {
  getNeuralEmbedder,
  NEURAL_EMBED_DIM,
  NEURAL_EMBED_MODEL,
  NEURAL_MAX_CONTENT_TOKENS,
  NEURAL_OVERLAP_TOKENS,
  type NeuralEmbedder
} from './neural-embed.service'
import { logVectorEvent } from './log.service'
import { analyzeTextIntegrity } from './text-decoding.service'

// ---------------------------------------------------------------------------
// 本地向量检索（兜底层）：
// - 首选：bge-small-zh-v1.5 ONNX，CLS pooling + L2 normalize，512 维。
// - 兜底：char 1..3-gram 特征哈希，256 维；模型缺失/加载/推理失败时绝不阻断对话。
// - 索引：同一索引只允许一种嵌入后端；模型、schema 或维度变化会原子全量重建。
// ---------------------------------------------------------------------------

const HASH_EMBED_DIM = 256
const HASH_EMBED_MODEL = 'fnv-ngram-256'
const SCHEMA_VERSION = 3
const HASH_CHUNK_TARGET = 800
const HASH_CHUNK_OVERLAP = 100
const MAX_BOUNDARY_SCAN = 240

interface EmbeddingBackend {
  id: string
  dimension: number
  kind: 'neural' | 'hash'
  chunk(text: string): string[]
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(query: string): Promise<number[]>
}

export interface VectorBuildResult {
  ok: boolean
  error?: string
  chunkCount?: number
  embedModel?: string
}

const buildPromises = new Map<string, Promise<VectorBuildResult>>()

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 特征哈希嵌入：char n-gram → 有符号桶。保留导出，供回归测试使用。 */
export function embedText(text: string): number[] {
  const v = new Float64Array(HASH_EMBED_DIM)
  const t = text.toLowerCase()
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i <= t.length - n; i++) {
      const h = fnv1a(t.slice(i, i + n))
      const bucket = h % HASH_EMBED_DIM
      const sign = ((h >>> 31) & 1) === 0 ? 1 : -1
      v[bucket] += sign
    }
  }
  let norm = 0
  for (let i = 0; i < HASH_EMBED_DIM; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  const out = new Array<number>(HASH_EMBED_DIM)
  for (let i = 0; i < HASH_EMBED_DIM; i++) out[i] = v[i] / norm
  return out
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return Number.NEGATIVE_INFINITY
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

const QUERY_SCAFFOLDING = [
  '\u8bf7\u5e2e\u6211', '\u9ebb\u70e6\u5e2e\u6211', '\u5e2e\u6211', '\u8bf7\u95ee', '\u67e5\u4e00\u4e0b', '\u67e5\u627e', '\u67e5\u8be2', '\u641c\u7d22',
  '\u8d44\u6e90\u533a', '\u8bbe\u5b9a\u96c6', '\u539f\u6587\u4e2d', '\u539f\u6587\u91cc', '\u539f\u6587', '\u6587\u6863\u4e2d', '\u6587\u6863\u91cc', '\u6587\u6863',
  '\u6709\u6ca1\u6709\u51fa\u73b0', '\u662f\u5426\u51fa\u73b0', '\u6709\u6ca1\u6709\u63d0\u5230', '\u662f\u5426\u63d0\u5230', '\u51fa\u73b0\u8fc7', '\u63d0\u5230\u8fc7',
  '\u6709\u6ca1\u6709', '\u662f\u5426', '\u5173\u4e8e', '\u76f8\u5173\u7684', '\u5177\u4f53\u7684', '\u5177\u4f53', '\u662f\u4ec0\u4e48', '\u662f\u8c01', '\u4ec0\u4e48\u610f\u601d',
  '\u8fd9\u4e2a', '\u90a3\u4e2a', '\u5185\u5bb9', '\u4fe1\u606f', '\u4e00\u4e0b', '\u8bf7', '\u5417', '\u5462'
]

function normalizeLexicalText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * Extract proper nouns and literal terms without an external segmenter. Common
 * question scaffolding is removed; semantic embedding still handles fuzzy intent.
 */
export function extractLexicalTerms(query: string): string[] {
  const terms: string[] = []
  for (const match of query.matchAll(/[\u201c\u0022\u300c\u300e]([^\u201d\u0022\u300d\u300f]{2,40})[\u201d\u0022\u300d\u300f]/g)) {
    terms.push(match[1])
  }
  for (const match of query.matchAll(/[A-Za-z0-9][A-Za-z0-9_.-]{1,39}/g)) {
    terms.push(match[0])
  }

  let cleaned = query.toLowerCase()
  for (const phrase of QUERY_SCAFFOLDING) cleaned = cleaned.split(phrase).join(' ')
  cleaned = cleaned.replace(/[\p{P}\p{S}\s]+/gu, ' ')
  for (const run of cleaned.match(/[\p{Script=Han}]{2,40}/gu) ?? []) terms.push(run)

  return [...new Set(terms.map(normalizeLexicalText).filter((term) => term.length >= 2))]
}

function lexicalSimilarity(query: string, text: string): number {
  const normalizedText = normalizeLexicalText(text)
  const normalizedQuery = normalizeLexicalText(query)
  if (!normalizedText || !normalizedQuery) return 0
  if (normalizedQuery.length >= 2 && normalizedText.includes(normalizedQuery)) return 1

  const terms = extractLexicalTerms(query)
  if (terms.length === 0) return 0
  let matchedWeight = 0
  let totalWeight = 0
  for (const term of terms) {
    const weight = Math.min(term.length, 16)
    totalWeight += weight
    if (normalizedText.includes(term)) matchedWeight += weight
  }
  return totalWeight > 0 ? matchedWeight / totalWeight : 0
}

function hybridScore(query: string, text: string, semanticScore: number): number {
  const lexicalScore = lexicalSimilarity(query, text)
  if (lexicalScore <= 0) return semanticScore
  // Literal proper-name hits outrank fuzzy semantic-only hits.
  return Math.max(semanticScore, 0.58 + lexicalScore * 0.32 + Math.max(semanticScore, 0) * 0.1)
}

/** 特征哈希路径沿用原有按段落分块：目标 800 字、重叠 100 字。 */
export function chunkText(text: string, target = HASH_CHUNK_TARGET, overlap = HASH_CHUNK_OVERLAP): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.length <= target) return [trimmed]
  const paras = trimmed.split(/\n+/).map((p) => p.trim()).filter(Boolean)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (p.length > target) {
      if (cur) {
        chunks.push(cur)
        cur = ''
      }
      let rest = p
      while (rest.length > target) {
        chunks.push(rest.slice(0, target))
        rest = rest.slice(target - overlap)
      }
      if (rest) cur = rest
    } else if (cur.length + p.length + 1 <= target) {
      cur = cur ? cur + '\n' + p : p
    } else {
      chunks.push(cur)
      cur = p
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

function findMaxTokenEnd(
  source: string,
  start: number,
  maxTokens: number,
  countTokens: (text: string) => number
): number {
  let high = Math.min(source.length, start + 2048)
  while (high < source.length && countTokens(source.slice(start, high)) <= maxTokens) {
    const width = high - start
    high = Math.min(source.length, start + width * 2)
  }
  if (high === source.length && countTokens(source.slice(start, high)) <= maxTokens) return high

  let low = start + 1
  let best = low
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (countTokens(source.slice(start, mid)) <= maxTokens) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return Math.max(best, start + 1)
}

function preferNaturalBoundary(source: string, start: number, hardEnd: number): number {
  if (hardEnd >= source.length) return hardEnd
  const min = Math.max(start + 1, hardEnd - Math.min(MAX_BOUNDARY_SCAN, Math.floor((hardEnd - start) * 0.3)))
  for (let i = hardEnd - 1; i >= min; i--) {
    if (/\n|[。！？!?；;]/.test(source[i])) return i + 1
  }
  return hardEnd
}

function findOverlapStart(
  source: string,
  chunkStart: number,
  chunkEnd: number,
  overlapTokens: number,
  countTokens: (text: string) => number
): number {
  let low = chunkStart
  let high = chunkEnd
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (countTokens(source.slice(mid, chunkEnd)) > overlapTokens) low = mid + 1
    else high = mid
  }
  return low
}

/** 使用 BGE 自己的 tokenizer 限制块大小，并始终返回原文子串。 */
export function chunkTextByTokens(
  text: string,
  countTokens: (text: string) => number,
  maxTokens = NEURAL_MAX_CONTENT_TOKENS,
  overlapTokens = NEURAL_OVERLAP_TOKENS
): string[] {
  const source = text.trim()
  if (!source) return []
  if (countTokens(source) <= maxTokens) return [source]

  const chunks: string[] = []
  let cursor = 0
  while (cursor < source.length) {
    const hardEnd = findMaxTokenEnd(source, cursor, maxTokens, countTokens)
    const end = preferNaturalBoundary(source, cursor, hardEnd)
    const chunk = source.slice(cursor, end).trim()
    if (chunk) chunks.push(chunk)
    if (end >= source.length) break

    const overlapStart = findOverlapStart(source, cursor, end, overlapTokens, countTokens)
    cursor = overlapStart > cursor && overlapStart < end ? overlapStart : end
    while (cursor < source.length && /\s/.test(source[cursor])) cursor++
  }
  return chunks
}

const HASH_BACKEND: EmbeddingBackend = {
  id: HASH_EMBED_MODEL,
  dimension: HASH_EMBED_DIM,
  kind: 'hash',
  chunk: chunkText,
  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map(embedText)
  },
  async embedQuery(query: string): Promise<number[]> {
    return embedText(query)
  }
}

function neuralBackend(embedder: NeuralEmbedder): EmbeddingBackend {
  return {
    id: embedder.id,
    dimension: embedder.dimension,
    kind: 'neural',
    chunk: (text) => chunkTextByTokens(text, (value) => embedder.countTokens(value)),
    embedDocuments: (texts) => embedder.embedDocuments(texts),
    embedQuery: (query) => embedder.embedQuery(query)
  }
}

async function preferredBackend(): Promise<EmbeddingBackend> {
  const embedder = await getNeuralEmbedder()
  return embedder ? neuralBackend(embedder) : HASH_BACKEND
}

function indexMatchesBackend(index: VectorIndex | null, backend: EmbeddingBackend): index is VectorIndex {
  return Boolean(
    index &&
      index.schemaVersion === SCHEMA_VERSION &&
      index.embedModel === backend.id &&
      Array.isArray(index.chunks) &&
      index.chunks.every((chunk) => Array.isArray(chunk.vector) && chunk.vector.length === backend.dimension)
  )
}

async function appendSourceChunks(
  target: VectorChunk[],
  backend: EmbeddingBackend,
  source: { docId: string; kind: 'doc' | 'res'; title: string; content: string }
): Promise<number> {
  const texts = backend.chunk(source.content)
  if (texts.length === 0) return 0
  const vectors = await backend.embedDocuments(texts)
  if (vectors.length !== texts.length) throw new Error('嵌入结果数量与文本分块数量不一致')
  for (let i = 0; i < texts.length; i++) {
    const vector = vectors[i]
    if (!vector || vector.length !== backend.dimension) {
      throw new Error(`嵌入维度不一致：${source.title} #${i}`)
    }
    target.push({
      docId: source.docId,
      kind: source.kind,
      title: source.title,
      index: i,
      text: texts[i],
      vector
    })
  }
  return texts.length
}

function sourceFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

async function buildWithBackend(projectId: string, backend: EmbeddingBackend): Promise<VectorBuildResult> {
  const startedAt = Date.now()
  const tree = (await buildSnapshot()).projects.find((project) => project.project.id === projectId)
  if (!tree) return { ok: false, error: '项目不存在' }

  const chunks: VectorChunk[] = []
  const sources: VectorIndexSource[] = []
  for (const doc of tree.docs) {
    try {
      const { content } = await readDoc(doc.id)
      const integrity = analyzeTextIntegrity(content)
      if (integrity.suspicious) continue
      const chunkCount = await appendSourceChunks(chunks, backend, {
        docId: doc.id,
        kind: 'doc',
        title: doc.title,
        content
      })
      sources.push({ id: doc.id, kind: 'doc', title: doc.title, sourceFingerprint: sourceFingerprint(content), chunkCount })
    } catch (error) {
      if (backend.kind === 'neural') throw error
      // 单个源文件读取失败时跳过；不让损坏文件阻止其余索引构建。
    }
  }
  for (const resource of tree.resources) {
    try {
      const { content, name, encoding } = await readResource(projectId, resource.id)
      if (encoding.suspicious) continue
      const chunkCount = await appendSourceChunks(chunks, backend, {
        docId: resource.id,
        kind: 'res',
        title: name,
        content
      })
      sources.push({ id: resource.id, kind: 'res', title: name, sourceFingerprint: sourceFingerprint(content), chunkCount })
    } catch (error) {
      if (backend.kind === 'neural') throw error
      // 同上，特征哈希兜底路径跳过无法读取的单个资源。
    }
  }

  const index: VectorIndex = {
    schemaVersion: SCHEMA_VERSION,
    embedModel: backend.id,
    chunks,
    updatedAt: nowIso(),
    sources
  }
  await writeVectorIndex(projectId, index)
  logVectorEvent({
    stage: 'build',
    backend: backend.id,
    outcome: 'success',
    durationMs: Date.now() - startedAt,
    chunkCount: chunks.length
  })
  return { ok: true, chunkCount: chunks.length, embedModel: backend.id }
}

async function buildWithFallback(projectId: string, initialBackend: EmbeddingBackend): Promise<VectorBuildResult> {
  try {
    return await buildWithBackend(projectId, initialBackend)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logVectorEvent({
      stage: 'build',
      backend: initialBackend.id,
      outcome: 'failure',
      reason
    })
    if (initialBackend.kind === 'hash') return { ok: false, error: reason }
    const fallbackReason = `神经索引构建失败，改用特征哈希：${reason}`
    try {
      const result = await buildWithBackend(projectId, HASH_BACKEND)
      logVectorEvent({
        stage: 'fallback',
        backend: HASH_EMBED_MODEL,
        outcome: result.ok ? 'success' : 'failure',
        reason: result.ok ? fallbackReason : result.error ?? fallbackReason
      })
      return result
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      logVectorEvent({
        stage: 'fallback',
        backend: HASH_EMBED_MODEL,
        outcome: 'failure',
        reason: fallbackMessage
      })
      return { ok: false, error: fallbackMessage }
    }
  }
}

function runBuild(projectId: string, backend: EmbeddingBackend): Promise<VectorBuildResult> {
  const existing = buildPromises.get(projectId)
  if (existing) return existing
  const promise = buildWithFallback(projectId, backend).finally(() => {
    if (buildPromises.get(projectId) === promise) buildPromises.delete(projectId)
  })
  buildPromises.set(projectId, promise)
  return promise
}

/** 构建项目向量索引；首选神经嵌入，任意模型故障时从头以特征哈希重建。 */
export async function buildVectorIndex(projectId: string): Promise<VectorBuildResult> {
  return runBuild(projectId, await preferredBackend())
}

export async function getVectorIndexStatus(projectId: string): Promise<VectorIndexStatus> {
  const tree = (await buildSnapshot()).projects.find((project) => project.project.id === projectId)
  if (!tree) {
    return { projectId, indexExists: false, chunkCount: 0, files: [] }
  }

  const index = await readVectorIndex(projectId)
  const chunkCounts = new Map<string, number>()
  for (const chunk of index?.chunks ?? []) chunkCounts.set(chunk.docId, (chunkCounts.get(chunk.docId) ?? 0) + 1)
  const sourceMap = new Map((index?.sources ?? []).map((source) => [source.id, source]))
  const incompatible = Boolean(index && (index.schemaVersion !== SCHEMA_VERSION || !index.embedModel))
  const files: VectorIndexFileStatus[] = []

  for (const doc of tree.docs) {
    let status: VectorIndexFileStatus['status'] = 'not-indexed'
    let chunkCount = chunkCounts.get(doc.id) ?? 0
    try {
      const { content } = await readDoc(doc.id)
      const integrity = analyzeTextIntegrity(content)
      if (integrity.suspicious) {
        files.push({ id: doc.id, kind: 'doc', title: doc.title, status: 'encoding-error', chunkCount: 0, issue: integrity.issue })
        continue
      }
      const source = sourceMap.get(doc.id)
      if (source) {
        chunkCount = source.chunkCount
        status = source.title === doc.title && source.sourceFingerprint === sourceFingerprint(content) ? 'indexed' : 'stale'
      } else if (chunkCount > 0) {
        status = incompatible ? 'stale' : 'indexed'
      }
    } catch {
      status = chunkCount > 0 ? 'stale' : 'not-indexed'
    }
    files.push({ id: doc.id, kind: 'doc', title: doc.title, status: index ? status : 'not-indexed', chunkCount })
  }

  for (const resource of tree.resources) {
    let status: VectorIndexFileStatus['status'] = 'not-indexed'
    let chunkCount = chunkCounts.get(resource.id) ?? 0
    try {
      const { content, name, encoding } = await readResource(projectId, resource.id)
      if (encoding.suspicious) {
        files.push({ id: resource.id, kind: 'res', title: name, status: 'encoding-error', chunkCount: 0, issue: encoding.issue })
        continue
      }
      const source = sourceMap.get(resource.id)
      if (source) {
        chunkCount = source.chunkCount
        status = source.title === name && source.sourceFingerprint === sourceFingerprint(content) ? 'indexed' : 'stale'
      } else if (chunkCount > 0) {
        status = incompatible ? 'stale' : 'indexed'
      }
      files.push({ id: resource.id, kind: 'res', title: name, status: index ? status : 'not-indexed', chunkCount })
    } catch {
      files.push({ id: resource.id, kind: 'res', title: resource.name, status: index && chunkCount > 0 ? 'stale' : 'not-indexed', chunkCount })
    }
  }

  return {
    projectId,
    indexExists: Boolean(index),
    schemaVersion: index?.schemaVersion,
    embedModel: index?.embedModel,
    updatedAt: index?.updatedAt,
    chunkCount: index?.chunks.length ?? 0,
    files
  }
}

async function backendForIndex(index: VectorIndex): Promise<EmbeddingBackend | null> {
  if (index.embedModel === HASH_EMBED_MODEL) return HASH_BACKEND
  if (index.embedModel !== NEURAL_EMBED_MODEL) return null
  const embedder = await getNeuralEmbedder()
  return embedder ? neuralBackend(embedder) : null
}

async function ensureSearchIndex(projectId: string): Promise<{ index: VectorIndex; backend: EmbeddingBackend } | null> {
  const preferred = await preferredBackend()
  let index = await readVectorIndex(projectId)
  if (!indexMatchesBackend(index, preferred)) {
    const result = await runBuild(projectId, preferred)
    if (!result.ok) return null
    index = await readVectorIndex(projectId)
  }
  if (!index || index.chunks.length === 0) return null

  let backend = await backendForIndex(index)
  if (!backend || !indexMatchesBackend(index, backend)) {
    const result = await runBuild(projectId, HASH_BACKEND)
    if (!result.ok) return null
    index = await readVectorIndex(projectId)
    backend = index ? await backendForIndex(index) : null
  }
  return index && backend && indexMatchesBackend(index, backend) ? { index, backend } : null
}

/** 余弦检索 top-k 原文分块；神经查询失败时原子切换为特征哈希索引。 */
export async function searchVectorIndex(projectId: string, query: string, topK = 5): Promise<VectorSearchHit[]> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery || topK <= 0) return []
  let prepared = await ensureSearchIndex(projectId)
  if (!prepared) return []

  let queryVector: number[]
  try {
    queryVector = await prepared.backend.embedQuery(normalizedQuery)
  } catch (error) {
    if (prepared.backend.kind === 'hash') return []
    const reason = error instanceof Error ? error.message : String(error)
    logVectorEvent({
      stage: 'search',
      backend: prepared.backend.id,
      outcome: 'failure',
      reason
    })
    const result = await runBuild(projectId, HASH_BACKEND)
    if (!result.ok) return []
    const index = await readVectorIndex(projectId)
    if (!index || !indexMatchesBackend(index, HASH_BACKEND)) return []
    prepared = { index, backend: HASH_BACKEND }
    queryVector = await HASH_BACKEND.embedQuery(normalizedQuery)
  }

  const hits = prepared.index.chunks
    .map((chunk) => {
      const semanticScore = cosine(queryVector, chunk.vector)
      return { chunk, score: hybridScore(normalizedQuery, chunk.text, semanticScore) }
    })
    .filter((item) => Number.isFinite(item.score) && item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  logVectorEvent({
    stage: 'search',
    backend: prepared.backend.id,
    outcome: 'success',
    chunkCount: prepared.index.chunks.length
  })
  return hits.map(({ chunk, score }) => ({
    docId: chunk.docId,
    kind: chunk.kind,
    title: chunk.title,
    index: chunk.index,
    text: chunk.text.slice(0, 1000),
    score: Math.round(score * 1000) / 1000
  }))
}
