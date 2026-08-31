import type {
  AppConfig,
  ChatMeta,
  ChatRelevanceLearning,
  ChatRelevanceLearningTerm,
  ProjectTree
} from '@shared/types'
import { readChatSummary, readDocSummary, readResource, readResourceSummary } from './services/file.service'

export const RELEVANCE_SAMPLE: Record<'doc' | 'chat' | 'res', number> = { doc: 10, chat: 10, res: 10 }
export const PROJECT_RELEVANCE_SAMPLE: Record<'doc' | 'chat' | 'res', number> = { doc: 5, chat: 5, res: 5 }
export const DYNAMIC_RELEVANCE_SAMPLE: Record<'doc' | 'chat' | 'res', number> = { doc: 10, chat: 10, res: 10 }
export const DYNAMIC_LEARNING_START_ROUNDS = 3
export const DYNAMIC_RELEVANCE_THRESHOLD = 10

const COMMON_TERMS = new Set([
  '这个', '那个', '这些', '那些', '我们', '你们', '他们', '自己', '什么', '如何', '为什么', '是否',
  '可以', '应该', '需要', '可能', '觉得', '认为', '因为', '所以', '如果', '但是', '然后', '现在',
  '问题', '内容', '部分', '方面', '情况', '进行', '一个', '一些', '以及', '关于', '对于', '当前',
  '故事', '文档', '设定', '角色', '回复', '回答', '分析', '说明', '建议', 'please', 'what', 'which',
  'this', 'that', 'with', 'from', 'about', 'would', 'could', 'should', 'have', 'your', 'their'
])

type SummaryKind = 'doc' | 'chat' | 'res'
type SummaryRecord = Record<string, unknown>
type Candidate = {
  key: string
  kind: SummaryKind
  updatedAt: string
  strictTerms: Set<string>
  terms: Map<string, number>
}

function summaryKeyKind(k: string): SummaryKind {
  if (k.startsWith('doc:')) return 'doc'
  if (k.startsWith('chat:')) return 'chat'
  return 'res'
}

function summaryKeyId(k: string, kind: SummaryKind): string {
  return k.slice(kind === 'doc' ? 4 : kind === 'chat' ? 5 : 4)
}

export function normalizeRelevanceTerm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\s\u3000]+/g, ' ')
}

function isUsefulTerm(value: string): boolean {
  const term = normalizeRelevanceTerm(value)
  if (term.length < 2 || term.length > 48) return false
  if (COMMON_TERMS.has(term)) return false
  if (/^[\d\s._-]+$/.test(term)) return false
  return true
}

function segmentText(value: string): string[] {
  const text = normalizeRelevanceTerm(value)
  if (!text) return []
  try {
    const Segmenter = (Intl as typeof Intl & {
      Segmenter?: new (locales?: string | string[], options?: { granularity?: string }) => {
        segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>
      }
    }).Segmenter
    if (Segmenter) {
      const segmenter = new Segmenter(['zh', 'en'], { granularity: 'word' })
      return [...segmenter.segment(text)]
        .map((part) => part.segment)
        .filter((part) => isUsefulTerm(part))
    }
  } catch {
    // Fall back to the regex tokenizer on runtimes without Intl.Segmenter.
  }
  return text.match(/[a-z0-9][a-z0-9_-]{1,}|[\u3400-\u9fff]{2,}/gi)?.filter(isUsefulTerm) ?? []
}

/** Extracts local, low-cost terms from a message; no LLM call is made. */
export function extractConversationTerms(value: string): string[] {
  const direct = normalizeRelevanceTerm(value)
  const tokens = segmentText(direct)
  const result = new Set(tokens)

  // Preserve short compound concepts that Chinese segmentation may split apart.
  for (let i = 0; i < tokens.length; i++) {
    for (let width = 2; width <= 3 && i + width <= tokens.length; width++) {
      const compound = tokens.slice(i, i + width).join('')
      if (isUsefulTerm(compound) && compound.length <= 20) result.add(compound)
    }
  }
  return [...result]
}

function addTerm(terms: Map<string, number>, value: unknown, weight: number): void {
  const term = normalizeRelevanceTerm(value)
  if (!isUsefulTerm(term)) return
  terms.set(term, Math.max(terms.get(term) ?? 0, weight))
}

function addTextTerms(terms: Map<string, number>, value: unknown, weight: number): void {
  if (typeof value !== 'string') return
  for (const term of extractConversationTerms(value)) addTerm(terms, term, weight)
}

function addArrayTextTerms(terms: Map<string, number>, value: unknown, weight: number): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (typeof item === 'string') addTextTerms(terms, item, weight)
    else if (item && typeof item === 'object') {
      for (const field of Object.values(item as SummaryRecord)) addTextTerms(terms, field, weight)
    }
  }
}

/**
 * Strict entity extraction retained for the base relevance algorithm.
 * It intentionally uses names, aliases and structured identifiers only.
 */
export function extractSummaryEntities(s: unknown): string[] {
  if (!s || typeof s !== 'object') return []
  const o = s as SummaryRecord
  const entities = new Set<string>()
  const add = (value: unknown): void => {
    const term = normalizeRelevanceTerm(value)
    if (isUsefulTerm(term)) entities.add(term)
  }
  const addArray = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) add(item)
  }

  if (Array.isArray(o.characters)) {
    for (const character of o.characters as SummaryRecord[]) {
      add(character.name)
      addArray(character.aliases)
    }
  }
  addArray(o.keySettings)
  addArray(o.keyTerms)
  if (Array.isArray(o.entries)) for (const entry of o.entries as SummaryRecord[]) add(entry.name)
  if (Array.isArray(o.terms)) for (const term of o.terms as SummaryRecord[]) add(term.term)

  const knowledge = o.knowledge as SummaryRecord | undefined
  if (Array.isArray(knowledge?.entities)) {
    for (const entity of knowledge.entities as SummaryRecord[]) {
      if (entity.status !== 'confirmed') continue
      add(entity.name)
      addArray(entity.aliases)
    }
  }
  if (Array.isArray(knowledge?.facts)) {
    for (const fact of knowledge.facts as SummaryRecord[]) {
      if (fact.status !== 'confirmed') continue
      add(fact.subject)
      add(fact.object)
    }
  }
  return [...entities]
}

/**
 * Builds the searchable vocabulary for one summary. Named entities receive a
 * high weight; explanatory fields are included with a lower weight so they can
 * help dynamic learning without overwhelming exact entity matches.
 */
export function extractSummaryMatchTerms(summary: unknown, title?: string): Map<string, number> {
  const terms = new Map<string, number>()
  for (const entity of extractSummaryEntities(summary)) addTerm(terms, entity, 6)
  addTerm(terms, title, 7)

  if (!summary || typeof summary !== 'object') return terms
  const o = summary as SummaryRecord
  addTextTerms(terms, o.overview, 1)
  addTextTerms(terms, o.scope, 1)
  addTextTerms(terms, o.structure, 1)
  addArrayTextTerms(terms, o.keyPoints, 1)
  addArrayTextTerms(terms, o.rules, 1)
  addArrayTextTerms(terms, o.relationships, 1)
  addArrayTextTerms(terms, o.timeline, 1)
  addArrayTextTerms(terms, o.constraints, 1)
  addArrayTextTerms(terms, o.keyQuotes, 1)
  addArrayTextTerms(terms, o.plot, 1)
  addArrayTextTerms(terms, o.characters, 1)
  addArrayTextTerms(terms, o.entries, 1)
  addArrayTextTerms(terms, o.terms, 1)

  const knowledge = o.knowledge as SummaryRecord | undefined
  addArrayTextTerms(terms, knowledge?.entities, 2)
  addArrayTextTerms(terms, knowledge?.facts, 1)
  return terms
}

async function buildAnchorEntities(chat: ChatMeta): Promise<Set<string>> {
  const ids = new Set<string>()
  if ((chat.kind === 'doc' || chat.kind === 'context') && chat.docId) {
    const summary = await readDocSummary(chat.projectId, chat.docId)
    for (const entity of extractSummaryEntities(summary)) ids.add(entity)
  }
  return ids
}

async function loadCandidates(
  chat: ChatMeta,
  applicable: string[],
  tree?: ProjectTree
): Promise<Candidate[]> {
  const loaded = await Promise.all(applicable.map(async (key): Promise<Candidate | null> => {
    if (key === 'fulltext') return null
    const kind = summaryKeyKind(key)
    const id = summaryKeyId(key, kind)
    let summary: unknown
    try {
      if (kind === 'res' && (await readResource(chat.projectId, id)).encoding.suspicious) return null
      summary = kind === 'doc'
        ? await readDocSummary(chat.projectId, id)
        : kind === 'chat'
          ? await readChatSummary(chat.projectId, id)
          : await readResourceSummary(chat.projectId, id)
    } catch {
      return null
    }
    if (!summary) return null
    const title = kind === 'doc'
      ? tree?.docs.find((doc) => doc.id === id)?.title
      : kind === 'chat'
        ? tree?.chats.find((item) => item.id === id)?.title
        : tree?.resources.find((resource) => resource.id === id)?.name
    return {
      key,
      kind,
      updatedAt: String((summary as SummaryRecord).updatedAt ?? ''),
      strictTerms: new Set(extractSummaryEntities(summary)),
      terms: extractSummaryMatchTerms(summary, title)
    }
  }))
  return loaded.filter((item): item is Candidate => item !== null)
}

/** Selects the initial base set. Project chats intentionally start with 5 per type. */
export async function selectDefaultKeys(
  chat: ChatMeta,
  applicable: string[],
  tree?: ProjectTree
): Promise<Set<string>> {
  const anchor = await buildAnchorEntities(chat)
  const candidates = await loadCandidates(chat, applicable, tree)
  const limit = chat.kind === 'project' ? PROJECT_RELEVANCE_SAMPLE : RELEVANCE_SAMPLE
  const scored = candidates.map((candidate) => {
    const overlap = [...candidate.terms.keys()].filter((term) => anchor.has(term)).length
    return { ...candidate, overlap }
  })
  const result = new Set<string>()
  for (const kind of ['doc', 'chat', 'res'] as const) {
    scored
      .filter((candidate) => candidate.kind === kind)
      .sort((a, b) => b.overlap - a.overlap || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit[kind])
      .forEach((candidate) => result.add(candidate.key))
  }
  return result
}

/**
 * Selects temporary, conversation-learned additions. The result is never
 * forced: candidates must clear the relevance threshold and are capped per
 * summary type.
 */
export async function selectDynamicKeys(
  chat: ChatMeta,
  applicable: string[],
  tree: ProjectTree | undefined,
  baseSelected: Set<string>
): Promise<Set<string>> {
  const learning = chat.summaryLearning
  if (!learning || learning.completedRounds < DYNAMIC_LEARNING_START_ROUNDS) return new Set()
  const learned = Object.entries(learning.terms)
  if (learned.length === 0) return new Set()

  const disabled = new Set(chat.injectionOverrides?.disabled ?? [])
  const alreadyActive = new Set([
    ...baseSelected,
    ...(chat.injectionOverrides?.active ?? []),
    ...(chat.injectionOverrides?.pending ?? [])
  ])
  const candidates = await loadCandidates(chat, applicable, tree)
  const scored = candidates
    .filter((candidate) => !alreadyActive.has(candidate.key) && !disabled.has(candidate.key))
    .map((candidate) => {
      let score = 0
      for (const [term, state] of learned) {
        const fieldWeight = candidate.terms.get(term)
        if (fieldWeight) score += state.score * fieldWeight
      }
      return { ...candidate, score }
    })
    .filter((candidate) => candidate.score >= DYNAMIC_RELEVANCE_THRESHOLD)

  const result = new Set<string>()
  for (const kind of ['doc', 'chat', 'res'] as const) {
    scored
      .filter((candidate) => candidate.kind === kind)
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, DYNAMIC_RELEVANCE_SAMPLE[kind])
      .forEach((candidate) => result.add(candidate.key))
  }
  return result
}

/** Updates per-conversation relevance signals after one successful turn. */
export function updateChatRelevanceLearning(
  current: ChatRelevanceLearning | undefined,
  userText: string,
  assistantText: string,
  completedRounds: number
): ChatRelevanceLearning {
  const terms: Record<string, ChatRelevanceLearningTerm> = {}
  for (const [term, state] of Object.entries(current?.terms ?? {})) {
    const nextScore = state.score * 0.88
    if (nextScore >= 0.5) terms[term] = { ...state, score: nextScore }
  }

  const add = (text: string, weight: number, source: 'userTurns' | 'assistantTurns'): void => {
    for (const term of extractConversationTerms(text)) {
      const state = terms[term] ?? { score: 0, userTurns: 0, assistantTurns: 0, lastSeenRound: completedRounds }
      state.score += weight
      state[source] += 1
      state.lastSeenRound = completedRounds
      terms[term] = state
    }
  }
  add(userText, 3, 'userTurns')
  add(assistantText, 1, 'assistantTurns')

  const trimmed = Object.fromEntries(
    Object.entries(terms)
      .sort(([, a], [, b]) => b.score - a.score || b.lastSeenRound - a.lastSeenRound)
      .slice(0, 200)
  )
  return {
    completedRounds,
    terms: trimmed,
    updatedAt: new Date().toISOString()
  }
}

export function collectApplicableKeys(chat: ChatMeta, cfg: AppConfig, tree: ProjectTree | undefined): string[] {
  if (!tree) return []
  const kind = chat.kind
  const inj = cfg.summaryInjection
  const keys: string[] = []

  if (kind === 'doc' && inj.doc.fullText) keys.push('fulltext')

  let docIds: string[] = []
  if (kind === 'project' && inj.project.docSummaries) docIds = tree.docs.map((doc) => doc.id)
  else if (kind === 'doc' && inj.doc.otherDocSummaries) docIds = tree.docs.filter((doc) => doc.id !== chat.docId).map((doc) => doc.id)
  else if (kind === 'context' && inj.context.docSummaries) docIds = tree.docs.map((doc) => doc.id)
  for (const id of docIds) keys.push(`doc:${id}`)

  let chatIds: string[] = []
  if (kind === 'project' && inj.project.chatSummaries) chatIds = tree.chats.filter((item) => item.id !== chat.id).map((item) => item.id)
  else if (kind === 'doc' && inj.doc.docChatSummaries) chatIds = tree.chats.filter((item) => item.docId === chat.docId && item.id !== chat.id).map((item) => item.id)
  else if (kind === 'context' && inj.context.docChatSummaries) chatIds = tree.chats.filter((item) => item.docId === chat.docId && item.id !== chat.id).map((item) => item.id)
  for (const id of chatIds) keys.push(`chat:${id}`)

  const includeResources = kind === 'project' ? inj.project.resourceSummaries : kind === 'doc' ? inj.doc.resourceSummaries : inj.context.resourceSummaries
  if (includeResources) for (const resource of tree.resources) keys.push(`res:${resource.id}`)
  return keys
}

export function computeActiveKeys(
  chat: ChatMeta,
  applicable: string[],
  defaultSelected: Set<string>,
  dynamicSelected: Set<string> = new Set()
): Set<string> {
  const frozen = chat.injectionOverrides?.active
  const pending = chat.injectionOverrides?.pending ?? []
  const disabled = new Set(chat.injectionOverrides?.disabled ?? [])
  const active = new Set<string>()
  for (const key of applicable) {
    if (frozen) {
      if (frozen.includes(key) || pending.includes(key)) active.add(key)
    } else if (defaultSelected.has(key) || pending.includes(key) || key === 'fulltext') {
      if (!disabled.has(key)) active.add(key)
    }
  }
  // Dynamic additions are temporary and may supplement a frozen conversation,
  // but an explicit user disable always wins.
  for (const key of dynamicSelected) {
    if (applicable.includes(key) && !disabled.has(key)) active.add(key)
  }
  return active
}

export async function computeDefaultActive(chat: ChatMeta, tree: ProjectTree | undefined, cfg: AppConfig): Promise<string[]> {
  const applicable = collectApplicableKeys(chat, cfg, tree)
  const selected = await selectDefaultKeys(chat, applicable, tree)
  if (applicable.includes('fulltext')) selected.add('fulltext')
  return [...selected]
}
