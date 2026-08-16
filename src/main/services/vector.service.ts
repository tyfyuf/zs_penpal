import type { VectorChunk, VectorIndex, VectorSearchHit } from '@shared/types'
import { buildSnapshot, readDoc, readResource, readVectorIndex, writeVectorIndex } from './file.service'
import { nowIso } from '../util'

// ---------------------------------------------------------------------------
// 本地向量检索（兜底层）：
// - 嵌入：char 1..3-gram 特征哈希（hashing trick）→ 256 维有符号向量，L2 归一化。
//   零依赖、离线、确定性、无 API 成本、无模型权重下载（沙箱阻断 HuggingFace，无法用神经模型）。
// - 存储：项目内 summaries/vector-index/<id>.json（纯文件，符合隐私红线）。
// - 检索：余弦相似度 top-k，命中返回原文分块。
// ---------------------------------------------------------------------------

const EMBED_DIM = 256
const EMBED_MODEL = 'fnv-ngram-256'
const SCHEMA_VERSION = 1
const CHUNK_TARGET = 800
const CHUNK_OVERLAP = 100

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 特征哈希嵌入：char n-gram → 有符号桶 */
export function embedText(text: string): number[] {
  const v = new Float64Array(EMBED_DIM)
  const t = text.toLowerCase()
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i <= t.length - n; i++) {
      const h = fnv1a(t.slice(i, i + n))
      const bucket = h % EMBED_DIM
      const sign = ((h >>> 31) & 1) === 0 ? 1 : -1
      v[bucket] += sign
    }
  }
  let norm = 0
  for (let i = 0; i < EMBED_DIM; i++) norm += v[i] * v[i]
  norm = Math.sqrt(norm) || 1
  const out = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) out[i] = v[i] / norm
  return out
}

function cosine(a: number[], b: number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** 按段落合并 + 硬切，目标 800 字、重叠 100 字 */
export function chunkText(text: string, target = CHUNK_TARGET, overlap = CHUNK_OVERLAP): string[] {
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

/** 构建项目向量索引（嵌原文分块，全量重建——特征哈希零成本，CPU 即可） */
export async function buildVectorIndex(projectId: string): Promise<{ ok: boolean; error?: string; chunkCount?: number }> {
  const tree = (await buildSnapshot()).projects.find((p) => p.project.id === projectId)
  if (!tree) return { ok: false, error: '项目不存在' }
  const chunks: VectorChunk[] = []
  for (const d of tree.docs) {
    try {
      const { content } = await readDoc(d.id)
      chunkText(content).forEach((t, i) => chunks.push({ docId: d.id, kind: 'doc', title: d.title, index: i, text: t, vector: embedText(t) }))
    } catch {
      /* 读取失败跳过 */
    }
  }
  for (const r of tree.resources) {
    try {
      const { content, name } = await readResource(projectId, r.id)
      chunkText(content).forEach((t, i) => chunks.push({ docId: r.id, kind: 'res', title: name, index: i, text: t, vector: embedText(t) }))
    } catch {
      /* 读取失败跳过 */
    }
  }
  const index: VectorIndex = { schemaVersion: SCHEMA_VERSION, embedModel: EMBED_MODEL, chunks, updatedAt: nowIso() }
  await writeVectorIndex(projectId, index)
  return { ok: true, chunkCount: chunks.length }
}

/** 余弦检索 top-k 原文分块（无索引时自动构建） */
export async function searchVectorIndex(projectId: string, query: string, topK = 5): Promise<VectorSearchHit[]> {
  let idx = await readVectorIndex(projectId)
  if (!idx || idx.chunks.length === 0) {
    await buildVectorIndex(projectId)
    idx = await readVectorIndex(projectId)
  }
  if (!idx || idx.chunks.length === 0) return []
  const qv = embedText(query)
  const scored = idx.chunks
    .map((c) => ({ c, score: cosine(qv, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((x) => x.score > 0)
  return scored.map((x) => ({
    docId: x.c.docId,
    kind: x.c.kind,
    title: x.c.title,
    index: x.c.index,
    text: x.c.text.slice(0, 1000),
    score: Math.round(x.score * 1000) / 1000
  }))
}
