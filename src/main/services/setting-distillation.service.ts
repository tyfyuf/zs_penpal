import { createHash } from 'crypto'
import type {
  SettingEntry,
  SettingSummary,
  SettingTerm,
  SummaryChunkResult,
  SummaryEntity,
  SummaryEntityKind,
  SummaryFact,
  SummaryKnowledgeBase
} from '@shared/types'
import type { ApiSettings } from './api-settings'
import { estimateTokens } from './tokenizer'
import { computeSourceInfo } from '../summary-source'
import { normalizeKnowledgeName } from './summary-knowledge'
import { splitSourceByTokenBudget, type SourceChunk } from './summary-hierarchy'
import { readSettingDistillationCheckpoint, writeSettingDistillationCheckpoint } from './file.service'
import { executeStructuredTask, StructuredGenerationError } from './structured-generation.service'
import { scheduleSummaryTask } from './summary-task-scheduler'
import { reportSummaryProgress } from './summary-state.service'
import { settingExtractionPrompt, settingMergePrompt, settingOverviewPrompt } from './setting-distillation.protocol'
import type {
  SettingDistillationCheckpoint,
  SettingDistillationResult,
  SettingEntityRelationshipExtraction,
  SettingEntryCandidate,
  SettingMechanismExtraction,
  SettingRelationshipCandidate,
  SettingTermCandidate,
  SettingTextCandidate,
  SettingTimelineExtraction
} from './setting-distillation.types'

const PIPELINE_VERSION = 2 as const
const PROMPT_RESERVE_TOKENS = 2600

interface MergedEntry extends SettingEntry {
  sourceIds: string[]
}

interface MergedTerm extends SettingTerm {
  sourceIds: string[]
}

interface MergedRelationship {
  subject: string
  predicate: string
  object: string
  description: string
  sourceIds: string[]
}

interface MergedText {
  text: string
  sourceIds: string[]
}

interface OverviewResult {
  overview: string
  scope: string
}

interface UnitExtraction extends SettingEntityRelationshipExtraction, SettingMechanismExtraction, SettingTimelineExtraction {
  chunk: SourceChunk
}

function cleanText(value: unknown, max = 100_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function parseJson(raw: string): Record<string, unknown> | null {
  const text = raw.trim().replace(/```(?:json)?/gi, '').trim()
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 16)}`
}

function taskHash(ids: string[]): string {
  return createHash('sha1').update([...ids].sort().join('|'), 'utf8').digest('hex').slice(0, 12)
}

function textTokens(text: string, model: string): number {
  return Math.max(estimateTokens(text, model), Math.ceil([...text].length * 1.05))
}

function inputBudget(settings: ApiSettings): number {
  return Math.max(4000, Math.floor(settings.contextLimit * 0.6))
}

function outputBudget(settings: ApiSettings): number {
  return Math.max(2048, Math.min(8192, Math.floor(settings.contextLimit * 0.22)))
}

function sourceHas(normalized: string, value: string): boolean {
  const needle = normalizeKnowledgeName(value)
  return needle.length > 0 && normalized.includes(needle)
}

function isSplitWorthy(error: unknown): boolean {
  return error instanceof StructuredGenerationError && ['truncated', 'invalid', 'empty', 'timeout'].includes(error.code)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function modelFingerprint(settings: ApiSettings): string {
  const endpoint = settings.baseURL.trim().replace(/\/+$/, '').toLowerCase()
  return createHash('sha256')
    .update(`${endpoint}::${settings.model.trim().toLowerCase()}::${settings.contextLimit}`, 'utf8')
    .digest('hex')
}

class CheckpointStore {
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly projectId: string,
    private readonly resourceId: string,
    private readonly data: SettingDistillationCheckpoint
  ) {}

  static async load(projectId: string, resourceId: string, sourceFingerprint: string, settings: ApiSettings): Promise<CheckpointStore> {
    const fingerprint = modelFingerprint(settings)
    const existing = await readSettingDistillationCheckpoint<SettingDistillationCheckpoint>(projectId, resourceId)
    const reusable = existing
      && existing.pipelineVersion === PIPELINE_VERSION
      && existing.sourceFingerprint === sourceFingerprint
      && existing.modelFingerprint === fingerprint
      && existing.language === settings.language
      && existing.results && typeof existing.results === 'object'
      && existing.failedTasks && typeof existing.failedTasks === 'object'
    const data: SettingDistillationCheckpoint = reusable ? existing : {
      pipelineVersion: PIPELINE_VERSION,
      sourceFingerprint,
      modelFingerprint: fingerprint,
      language: settings.language,
      results: {},
      failedTasks: {},
      updatedAt: new Date().toISOString()
    }
    return new CheckpointStore(projectId, resourceId, data)
  }

  get<T>(key: string): T | undefined {
    if (!Object.prototype.hasOwnProperty.call(this.data.results, key)) return undefined
    return this.data.results[key] as T
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key)
    if (cached !== undefined) return cached
    try {
      const result = await task()
      await this.succeed(key, result)
      return result
    } catch (error) {
      await this.fail(key, errorMessage(error))
      throw error
    }
  }

  async succeed<T>(key: string, result: T): Promise<void> {
    this.data.results[key] = result
    delete this.data.failedTasks[key]
    await this.save()
  }

  private async fail(key: string, reason: string): Promise<void> {
    delete this.data.results[key]
    this.data.failedTasks[key] = reason.slice(0, 1000)
    await this.save()
  }

  private async save(): Promise<void> {
    this.data.updatedAt = new Date().toISOString()
    const snapshot = JSON.parse(JSON.stringify(this.data)) as SettingDistillationCheckpoint
    const next = this.writeQueue.then(() => writeSettingDistillationCheckpoint(this.projectId, this.resourceId, snapshot))
    this.writeQueue = next.catch(() => {})
    await next
  }
}

async function callStructured<T>(task: string, settings: ApiSettings, system: string, user: string, parseAndValidate: (raw: string) => T | null): Promise<T> {
  const tokens = outputBudget(settings)
  return scheduleSummaryTask(() => executeStructuredTask({
    task,
    settings,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user || '(empty content)' }],
    outputTokens: tokens,
    compactOutputTokens: tokens,
    parseAndValidate,
    retryPolicy: 'split-required'
  }), 'batch')
}

function parseEntries(value: unknown, source: string, origin: string): SettingEntryCandidate[] {
  if (!Array.isArray(value)) return []
  const normalized = normalizeKnowledgeName(source)
  return value.flatMap((raw) => {
    const item = raw as Record<string, unknown>
    const name = cleanText(item?.name, 240)
    const category = cleanText(item?.category, 120) || 'other'
    const description = cleanText(item?.description, 50_000)
    if (!name || !description || !sourceHas(normalized, name)) return []
    return [{ id: hashId('entry', `${origin}|${name}|${category}|${description}`), name, category, description }]
  })
}

function parseTerms(value: unknown, source: string, origin: string): SettingTermCandidate[] {
  if (!Array.isArray(value)) return []
  const normalized = normalizeKnowledgeName(source)
  return value.flatMap((raw) => {
    const item = raw as Record<string, unknown>
    const term = cleanText(item?.term, 240)
    const definition = cleanText(item?.definition, 50_000)
    if (!term || !definition || !sourceHas(normalized, term)) return []
    return [{ id: hashId('term', `${origin}|${term}|${definition}`), term, definition }]
  })
}

function parseRelationships(value: unknown, source: string, origin: string): SettingRelationshipCandidate[] {
  if (!Array.isArray(value)) return []
  const normalized = normalizeKnowledgeName(source)
  return value.flatMap((raw) => {
    const item = raw as Record<string, unknown>
    const subject = cleanText(item?.subject, 300)
    const predicate = cleanText(item?.predicate, 1000)
    const object = cleanText(item?.object, 4000)
    const description = cleanText(item?.description, 50_000)
    if (!subject || !predicate || !object || !sourceHas(normalized, subject) || !sourceHas(normalized, object)) return []
    return [{ id: hashId('relationship', `${origin}|${subject}|${predicate}|${object}|${description}`), subject, predicate, object, description }]
  })
}

function parseTexts(value: unknown, origin: string, prefix: string): SettingTextCandidate[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    const text = cleanText(raw, 50_000)
    return text ? [{ id: hashId(prefix, `${origin}|${text}`), text }] : []
  })
}

async function callEntityRelationship(text: string, origin: string, settings: ApiSettings): Promise<SettingEntityRelationshipExtraction> {
  return callStructured(`setting_extract_entity_relationship:${origin}`, settings, settingExtractionPrompt('entity-relationship', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    if (!parsed || !Array.isArray(parsed.entries) || !Array.isArray(parsed.relationships)) return null
    return { entries: parseEntries(parsed.entries, text, origin), relationships: parseRelationships(parsed.relationships, text, origin) }
  })
}

async function callEntities(text: string, origin: string, settings: ApiSettings): Promise<SettingEntryCandidate[]> {
  return callStructured(`setting_extract_entities:${origin}`, settings, settingExtractionPrompt('entities', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    return parsed && Array.isArray(parsed.entries) ? parseEntries(parsed.entries, text, origin) : null
  })
}

async function callRelationships(text: string, origin: string, settings: ApiSettings): Promise<SettingRelationshipCandidate[]> {
  return callStructured(`setting_extract_relationships:${origin}`, settings, settingExtractionPrompt('relationships', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    return parsed && Array.isArray(parsed.relationships) ? parseRelationships(parsed.relationships, text, origin) : null
  })
}

async function callMechanisms(text: string, origin: string, settings: ApiSettings): Promise<SettingMechanismExtraction> {
  return callStructured(`setting_extract_mechanisms:${origin}`, settings, settingExtractionPrompt('mechanisms', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    if (!parsed || !Array.isArray(parsed.terms) || !Array.isArray(parsed.rules) || !Array.isArray(parsed.constraints)) return null
    return {
      terms: parseTerms(parsed.terms, text, origin),
      rules: parseTexts(parsed.rules, origin, 'rule'),
      constraints: parseTexts(parsed.constraints, origin, 'constraint')
    }
  })
}

async function callTerms(text: string, origin: string, settings: ApiSettings): Promise<SettingTermCandidate[]> {
  return callStructured(`setting_extract_terms:${origin}`, settings, settingExtractionPrompt('terms', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    return parsed && Array.isArray(parsed.terms) ? parseTerms(parsed.terms, text, origin) : null
  })
}

async function callRules(text: string, origin: string, settings: ApiSettings): Promise<SettingTextCandidate[]> {
  return callStructured(`setting_extract_rules:${origin}`, settings, settingExtractionPrompt('rules', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    return parsed && Array.isArray(parsed.rules) ? parseTexts(parsed.rules, origin, 'rule') : null
  })
}

async function callConstraints(text: string, origin: string, settings: ApiSettings): Promise<SettingTextCandidate[]> {
  return callStructured(`setting_extract_constraints:${origin}`, settings, settingExtractionPrompt('constraints', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    return parsed && Array.isArray(parsed.constraints) ? parseTexts(parsed.constraints, origin, 'constraint') : null
  })
}

async function callTimeline(text: string, origin: string, settings: ApiSettings): Promise<SettingTextCandidate[]> {
  return callStructured(`setting_extract_timeline:${origin}`, settings, settingExtractionPrompt('timeline', settings.language), text, (raw) => {
    const parsed = parseJson(raw)
    return parsed && Array.isArray(parsed.timeline) ? parseTexts(parsed.timeline, origin, 'timeline') : null
  })
}

function splitRetryText(text: string, settings: ApiSettings): SourceChunk[] {
  const current = textTokens(text, settings.model)
  if (current <= 900) return []
  const parts = splitSourceByTokenBudget(text, settings.model, Math.max(800, Math.floor(current / 2)))
  return parts.length > 1 ? parts : []
}

async function runTextTask<T>(
  store: CheckpointStore,
  key: string,
  text: string,
  settings: ApiSettings,
  call: (part: string, origin: string, settings: ApiSettings) => Promise<T>,
  combine: (parts: T[]) => T
): Promise<T> {
  const cached = store.get<T>(key)
  if (cached !== undefined) return cached
  try {
    return await store.run(key, () => call(text, key, settings))
  } catch (error) {
    if (!isSplitWorthy(error)) throw error
    const parts = splitRetryText(text, settings)
    if (parts.length < 2) throw error
    const settled = await Promise.allSettled(parts.map((part) => runTextTask(
      store,
      `${key}:part:${part.sourceFingerprint.slice(0, 12)}`,
      part.text,
      settings,
      call,
      combine
    )))
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new Error(failures.map((item) => errorMessage(item.reason)).join('；'))
    const combined = combine(settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []))
    await store.succeed(key, combined)
    return combined
  }
}

async function settleRequired<T extends Record<string, Promise<unknown>>>(label: string, tasks: T): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(tasks) as Array<keyof T>
  const settled = await Promise.allSettled(keys.map((key) => tasks[key]))
  const failures = settled.flatMap((result, index) => result.status === 'rejected' ? [`${String(keys[index])}: ${errorMessage(result.reason)}`] : [])
  if (failures.length > 0) throw new Error(`${label}失败：${failures.join('；')}`)
  const output = {} as { [K in keyof T]: Awaited<T[K]> }
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') output[keys[index]] = result.value as Awaited<T[keyof T]>
  })
  return output
}

async function extractEntityBranch(chunk: SourceChunk, settings: ApiSettings, store: CheckpointStore): Promise<SettingEntityRelationshipExtraction> {
  const key = `extract:${chunk.id}:entity-relationship`
  const cached = store.get<SettingEntityRelationshipExtraction>(key)
  if (cached !== undefined) return cached
  try {
    return await store.run(key, () => callEntityRelationship(chunk.text, key, settings))
  } catch (error) {
    if (!isSplitWorthy(error)) throw error
    const split = await settleRequired('实体与关系拆分提取', {
      entries: runTextTask(store, `extract:${chunk.id}:entities`, chunk.text, settings, callEntities, (parts) => parts.flat()),
      relationships: runTextTask(store, `extract:${chunk.id}:relationships`, chunk.text, settings, callRelationships, (parts) => parts.flat())
    })
    const result = { entries: split.entries, relationships: split.relationships }
    await store.succeed(key, result)
    return result
  }
}

async function extractMechanismBranch(chunk: SourceChunk, settings: ApiSettings, store: CheckpointStore): Promise<SettingMechanismExtraction> {
  const key = `extract:${chunk.id}:mechanisms`
  const cached = store.get<SettingMechanismExtraction>(key)
  if (cached !== undefined) return cached
  try {
    return await store.run(key, () => callMechanisms(chunk.text, key, settings))
  } catch (error) {
    if (!isSplitWorthy(error)) throw error
    const split = await settleRequired('术语、规则与约束拆分提取', {
      terms: runTextTask(store, `extract:${chunk.id}:terms`, chunk.text, settings, callTerms, (parts) => parts.flat()),
      rules: runTextTask(store, `extract:${chunk.id}:rules`, chunk.text, settings, callRules, (parts) => parts.flat()),
      constraints: runTextTask(store, `extract:${chunk.id}:constraints`, chunk.text, settings, callConstraints, (parts) => parts.flat())
    })
    const result = { terms: split.terms, rules: split.rules, constraints: split.constraints }
    await store.succeed(key, result)
    return result
  }
}

async function extractTimelineBranch(chunk: SourceChunk, settings: ApiSettings, store: CheckpointStore): Promise<SettingTimelineExtraction> {
  const timeline = await runTextTask(store, `extract:${chunk.id}:timeline`, chunk.text, settings, callTimeline, (parts) => parts.flat())
  return { timeline }
}

function buildUnits(source: string, settings: ApiSettings): SourceChunk[] {
  const budget = inputBudget(settings)
  const fullTokens = textTokens(source, settings.model)
  const fullFits = fullTokens + PROMPT_RESERVE_TOKENS <= budget
  const target = fullFits ? Math.max(800, fullTokens + 100) : Math.min(10000, Math.max(3000, budget - PROMPT_RESERVE_TOKENS))
  return splitSourceByTokenBudget(source, settings.model, target)
}

async function extractUnits(source: string, settings: ApiSettings, store: CheckpointStore, progressKey?: string): Promise<UnitExtraction[]> {
  const chunks = buildUnits(source, settings)
  if (progressKey) {
    reportSummaryProgress(progressKey, 'chunking', 1, 1, `${chunks.length} chunks prepared`)
    reportSummaryProgress(progressKey, 'extracting', 0, chunks.length)
  }
  const output: UnitExtraction[] = []
  const failures: string[] = []
  for (const chunk of chunks) {
    try {
      const branches = await settleRequired(`设定分块 ${chunk.index + 1}/${chunks.length}`, {
        entityRelationship: extractEntityBranch(chunk, settings, store),
        mechanisms: extractMechanismBranch(chunk, settings, store),
        timeline: extractTimelineBranch(chunk, settings, store)
      })
      output.push({ chunk, ...branches.entityRelationship, ...branches.mechanisms, ...branches.timeline })
      if (progressKey) reportSummaryProgress(progressKey, 'extracting', output.length, chunks.length, `Chunk ${output.length}/${chunks.length}`)
    } catch (error) {
      failures.push(errorMessage(error))
    }
  }
  if (failures.length > 0) throw new Error(failures.join('；'))
  return output
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): T[][] {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    const group = map.get(key)
    if (group) group.push(item)
    else map.set(key, [item])
  }
  return [...map.values()]
}

function partitionGroups<T extends { id: string }>(groups: T[][], settings: ApiSettings): T[][][] {
  const budget = Math.max(1800, Math.floor(inputBudget(settings) * 0.55))
  const batches: T[][][] = []
  let current: T[][] = []
  let currentTokens = 0
  for (const group of groups) {
    const tokens = textTokens(JSON.stringify(group), settings.model)
    if (current.length > 0 && (current.length >= 40 || currentTokens + tokens > budget)) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(group)
    currentTokens += tokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function validSourceIds(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanText(item, 120)).filter((item) => allowed.has(item)))]
}

function hasCoverage(items: Array<{ sourceIds: string[] }>, required: string[]): boolean {
  const covered = new Set(items.flatMap((item) => item.sourceIds))
  return required.every((id) => covered.has(id))
}

function referencedCandidates<T extends { id: string }>(sourceIds: string[], requiredById: Map<string, T>): T[] {
  return sourceIds.flatMap((id) => {
    const candidate = requiredById.get(id)
    return candidate ? [candidate] : []
  })
}

function matchesReferencedName<T extends { id: string }>(
  value: string,
  sourceIds: string[],
  requiredById: Map<string, T>,
  nameOf: (candidate: T) => string
): boolean {
  const normalized = normalizeKnowledgeName(value)
  return normalized.length > 0 && referencedCandidates(sourceIds, requiredById)
    .some((candidate) => normalizeKnowledgeName(nameOf(candidate)) === normalized)
}

function parseMergedEntries(value: unknown, required: SettingEntryCandidate[]): MergedEntry[] | null {
  if (!Array.isArray(value)) return null
  const requiredById = new Map(required.map((item) => [item.id, item]))
  const allowed = new Set(requiredById.keys())
  const output: MergedEntry[] = []
  for (const raw of value) {
    const item = raw as Record<string, unknown>
    const name = cleanText(item?.name, 240)
    const category = cleanText(item?.category, 200) || 'other'
    const description = cleanText(item?.description, 100_000)
    const sourceIds = validSourceIds(item?.sourceIds, allowed)
    if (
      name
      && description
      && sourceIds.length > 0
      && matchesReferencedName(name, sourceIds, requiredById, (candidate) => candidate.name)
    ) output.push({ name, category, description, sourceIds })
  }
  return hasCoverage(output, required.map((item) => item.id)) ? output : null
}

function parseMergedTerms(value: unknown, required: SettingTermCandidate[]): MergedTerm[] | null {
  if (!Array.isArray(value)) return null
  const requiredById = new Map(required.map((item) => [item.id, item]))
  const allowed = new Set(requiredById.keys())
  const output: MergedTerm[] = []
  for (const raw of value) {
    const item = raw as Record<string, unknown>
    const term = cleanText(item?.term, 240)
    const definition = cleanText(item?.definition, 100_000)
    const sourceIds = validSourceIds(item?.sourceIds, allowed)
    if (
      term
      && definition
      && sourceIds.length > 0
      && matchesReferencedName(term, sourceIds, requiredById, (candidate) => candidate.term)
    ) output.push({ term, definition, sourceIds })
  }
  return hasCoverage(output, required.map((item) => item.id)) ? output : null
}

function parseMergedRelationships(value: unknown, required: SettingRelationshipCandidate[]): MergedRelationship[] | null {
  if (!Array.isArray(value)) return null
  const requiredById = new Map(required.map((item) => [item.id, item]))
  const allowed = new Set(requiredById.keys())
  const output: MergedRelationship[] = []
  for (const raw of value) {
    const item = raw as Record<string, unknown>
    const subject = cleanText(item?.subject, 300)
    const predicate = cleanText(item?.predicate, 1000)
    const object = cleanText(item?.object, 4000)
    const description = cleanText(item?.description, 100_000)
    const sourceIds = validSourceIds(item?.sourceIds, allowed)
    const subjectMatches = matchesReferencedName(subject, sourceIds, requiredById, (candidate) => candidate.subject)
    const objectMatches = matchesReferencedName(object, sourceIds, requiredById, (candidate) => candidate.object)
    if (subject && predicate && object && sourceIds.length > 0 && subjectMatches && objectMatches) {
      output.push({ subject, predicate, object, description, sourceIds })
    }
  }
  return hasCoverage(output, required.map((item) => item.id)) ? output : null
}

function parseMergedTexts(value: unknown, required: SettingTextCandidate[]): MergedText[] | null {
  if (!Array.isArray(value)) return null
  const allowed = new Set(required.map((item) => item.id))
  const output: MergedText[] = []
  for (const raw of value) {
    const item = raw as Record<string, unknown>
    const text = cleanText(item?.text, 100_000)
    const sourceIds = validSourceIds(item?.sourceIds, allowed)
    if (text && sourceIds.length > 0) output.push({ text, sourceIds })
  }
  return hasCoverage(output, required.map((item) => item.id)) ? output : null
}

function mergeSplitGroups<T extends { id: string }>(groups: T[][]): [T[][], T[][]] | null {
  if (groups.length > 1) {
    const middle = Math.ceil(groups.length / 2)
    return [groups.slice(0, middle), groups.slice(middle)]
  }
  const only = groups[0] ?? []
  if (only.length <= 1) return null
  const middle = Math.ceil(only.length / 2)
  return [[only.slice(0, middle)], [only.slice(middle)]]
}

async function runMergeGroups<T extends { id: string }, R extends { sourceIds: string[] }>(
  store: CheckpointStore,
  baseKey: string,
  groups: T[][],
  settings: ApiSettings,
  call: (items: T[], taskKey: string) => Promise<R[]>,
  coalesce: (items: R[]) => R[],
  preserve: (item: T) => R
): Promise<R[]> {
  const items = groups.flat()
  if (items.length === 0) return []
  const key = `${baseKey}:batch:${taskHash(items.map((item) => item.id))}`
  const cached = store.get<R[]>(key)
  if (cached !== undefined) return cached
  try {
    return await store.run(key, () => call(items, key))
  } catch (error) {
    if (!isSplitWorthy(error)) throw error
    const split = mergeSplitGroups(groups)
    if (!split) {
      const preserved = items.map(preserve)
      await store.succeed(key, preserved)
      return preserved
    }
    const settled = await Promise.allSettled(split.map((part) => runMergeGroups(
      store,
      baseKey,
      part,
      settings,
      call,
      coalesce,
      preserve
    )))
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new Error(failures.map((item) => errorMessage(item.reason)).join('；'))
    const merged = coalesce(settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []))
    await store.succeed(key, merged)
    return merged
  }
}

async function runAllBatches<T extends { id: string }, R extends { sourceIds: string[] }>(
  store: CheckpointStore,
  baseKey: string,
  groups: T[][],
  settings: ApiSettings,
  call: (items: T[], taskKey: string) => Promise<R[]>,
  coalesce: (items: R[]) => R[],
  preserve: (item: T) => R
): Promise<R[]> {
  if (groups.length === 0) return []
  const batches = partitionGroups(groups, settings)
  const settled = await Promise.allSettled(batches.map((batch) => runMergeGroups(
    store,
    baseKey,
    batch,
    settings,
    call,
    coalesce,
    preserve
  )))
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length > 0) throw new Error(failures.map((item) => errorMessage(item.reason)).join('；'))
  return coalesce(settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []))
}

function uniqueJoined(values: string[]): string {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = normalizeKnowledgeName(value)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).join('\n')
}

function coalesceEntries(items: MergedEntry[]): MergedEntry[] {
  return groupBy(items, (item) => normalizeKnowledgeName(item.name)).map((group) => ({
    name: group[0].name,
    category: uniqueJoined(group.map((item) => item.category)).replace(/\n/g, ' / '),
    description: uniqueJoined(group.map((item) => item.description)),
    sourceIds: [...new Set(group.flatMap((item) => item.sourceIds))]
  }))
}

function coalesceTerms(items: MergedTerm[]): MergedTerm[] {
  return groupBy(items, (item) => normalizeKnowledgeName(item.term)).map((group) => ({
    term: group[0].term,
    definition: uniqueJoined(group.map((item) => item.definition)),
    sourceIds: [...new Set(group.flatMap((item) => item.sourceIds))]
  }))
}

function coalesceRelationships(items: MergedRelationship[]): MergedRelationship[] {
  return groupBy(items, (item) => [item.subject, item.predicate, item.object].map(normalizeKnowledgeName).join('|')).map((group) => ({
    subject: group[0].subject,
    predicate: group[0].predicate,
    object: group[0].object,
    description: uniqueJoined(group.map((item) => item.description).filter(Boolean)),
    sourceIds: [...new Set(group.flatMap((item) => item.sourceIds))]
  }))
}

function coalesceTexts(items: MergedText[]): MergedText[] {
  return groupBy(items, (item) => normalizeKnowledgeName(item.text)).map((group) => ({
    text: group[0].text,
    sourceIds: [...new Set(group.flatMap((item) => item.sourceIds))]
  }))
}

async function mergeEntries(items: SettingEntryCandidate[], settings: ApiSettings, store: CheckpointStore): Promise<MergedEntry[]> {
  const groups = groupBy(items, (item) => normalizeKnowledgeName(item.name))
  return runAllBatches(store, 'merge:entries', groups, settings, (batch, taskKey) => callStructured(
    `setting_${taskKey}`,
    settings,
    settingMergePrompt('entries', settings.language),
    JSON.stringify({ entries: batch }),
    (raw) => {
      const parsed = parseJson(raw)
      return parsed ? parseMergedEntries(parsed.entries, batch) : null
    }
  ), coalesceEntries, (item) => ({ ...item, sourceIds: [item.id] }))
}

async function mergeRelationships(items: SettingRelationshipCandidate[], settings: ApiSettings, store: CheckpointStore): Promise<MergedRelationship[]> {
  const groups = groupBy(items, (item) => [item.subject, item.predicate, item.object].map(normalizeKnowledgeName).join('|'))
  return runAllBatches(store, 'merge:relationships', groups, settings, (batch, taskKey) => callStructured(
    `setting_${taskKey}`,
    settings,
    settingMergePrompt('relationships', settings.language),
    JSON.stringify({ relationships: batch }),
    (raw) => {
      const parsed = parseJson(raw)
      return parsed ? parseMergedRelationships(parsed.relationships, batch) : null
    }
  ), coalesceRelationships, (item) => ({ ...item, sourceIds: [item.id] }))
}

async function mergeTerms(items: SettingTermCandidate[], settings: ApiSettings, store: CheckpointStore): Promise<MergedTerm[]> {
  const groups = groupBy(items, (item) => normalizeKnowledgeName(item.term))
  return runAllBatches(store, 'merge:terms', groups, settings, (batch, taskKey) => callStructured(
    `setting_${taskKey}`,
    settings,
    settingMergePrompt('terms', settings.language),
    JSON.stringify({ terms: batch }),
    (raw) => {
      const parsed = parseJson(raw)
      return parsed ? parseMergedTerms(parsed.terms, batch) : null
    }
  ), coalesceTerms, (item) => ({ ...item, sourceIds: [item.id] }))
}

async function mergeTexts(
  kind: 'rules' | 'constraints' | 'timeline',
  items: SettingTextCandidate[],
  settings: ApiSettings,
  store: CheckpointStore
): Promise<MergedText[]> {
  const groups = groupBy(items, (item) => normalizeKnowledgeName(item.text))
  return runAllBatches(store, `merge:${kind}`, groups, settings, (batch, taskKey) => callStructured(
    `setting_${taskKey}`,
    settings,
    settingMergePrompt(kind, settings.language),
    JSON.stringify({ [kind]: batch }),
    (raw) => {
      const parsed = parseJson(raw)
      return parsed ? parseMergedTexts(parsed[kind], batch) : null
    }
  ), coalesceTexts, (item) => ({ text: item.text, sourceIds: [item.id] }))
}

function combinedMergeFits(value: unknown, itemCount: number, settings: ApiSettings): boolean {
  return itemCount <= 80 && textTokens(JSON.stringify(value), settings.model) < Math.floor(inputBudget(settings) * 0.5)
}

async function mergeEntityBranch(
  entries: SettingEntryCandidate[],
  relationships: SettingRelationshipCandidate[],
  settings: ApiSettings,
  store: CheckpointStore
): Promise<{ entries: MergedEntry[]; relationships: MergedRelationship[] }> {
  const key = 'merge:entity-relationship'
  const cached = store.get<{ entries: MergedEntry[]; relationships: MergedRelationship[] }>(key)
  if (cached !== undefined) return cached
  const payload = { entries, relationships }
  if (combinedMergeFits(payload, entries.length + relationships.length, settings)) {
    try {
      return await store.run(key, () => callStructured(`setting_${key}`, settings, settingMergePrompt('entity-relationship', settings.language), JSON.stringify(payload), (raw) => {
        const parsed = parseJson(raw)
        if (!parsed) return null
        const mergedEntries = parseMergedEntries(parsed.entries, entries)
        const mergedRelationships = parseMergedRelationships(parsed.relationships, relationships)
        return mergedEntries && mergedRelationships ? { entries: mergedEntries, relationships: mergedRelationships } : null
      }))
    } catch (error) {
      if (!isSplitWorthy(error)) throw error
    }
  }
  const split = await settleRequired('实体与关系归并', {
    entries: mergeEntries(entries, settings, store),
    relationships: mergeRelationships(relationships, settings, store)
  })
  await store.succeed(key, split)
  return split
}

async function mergeMechanismBranch(
  terms: SettingTermCandidate[],
  rules: SettingTextCandidate[],
  constraints: SettingTextCandidate[],
  settings: ApiSettings,
  store: CheckpointStore
): Promise<{ terms: MergedTerm[]; rules: MergedText[]; constraints: MergedText[] }> {
  const key = 'merge:mechanisms'
  const cached = store.get<{ terms: MergedTerm[]; rules: MergedText[]; constraints: MergedText[] }>(key)
  if (cached !== undefined) return cached
  const payload = { terms, rules, constraints }
  if (combinedMergeFits(payload, terms.length + rules.length + constraints.length, settings)) {
    try {
      return await store.run(key, () => callStructured(`setting_${key}`, settings, settingMergePrompt('mechanisms', settings.language), JSON.stringify(payload), (raw) => {
        const parsed = parseJson(raw)
        if (!parsed) return null
        const mergedTerms = parseMergedTerms(parsed.terms, terms)
        const mergedRules = parseMergedTexts(parsed.rules, rules)
        const mergedConstraints = parseMergedTexts(parsed.constraints, constraints)
        return mergedTerms && mergedRules && mergedConstraints ? { terms: mergedTerms, rules: mergedRules, constraints: mergedConstraints } : null
      }))
    } catch (error) {
      if (!isSplitWorthy(error)) throw error
    }
  }
  const split = await settleRequired('术语、规则与约束归并', {
    terms: mergeTerms(terms, settings, store),
    rules: mergeTexts('rules', rules, settings, store),
    constraints: mergeTexts('constraints', constraints, settings, store)
  })
  await store.succeed(key, split)
  return split
}

function parseOverview(raw: string): OverviewResult | null {
  const parsed = parseJson(raw)
  if (!parsed) return null
  const overview = cleanText(parsed.overview, 6000)
  const scope = cleanText(parsed.scope, 3000)
  return overview ? { overview, scope } : null
}

async function mergeOverviewResults(
  initial: OverviewResult[],
  keyPrefix: string,
  settings: ApiSettings,
  store: CheckpointStore
): Promise<OverviewResult> {
  if (initial.length === 0) throw new StructuredGenerationError('No overview content was generated', 'empty')
  const budget = inputBudget(settings) - PROMPT_RESERVE_TOKENS
  let nodes = initial
  let level = 0
  while (nodes.length > 1) {
    const groups: OverviewResult[][] = []
    let current: OverviewResult[] = []
    for (const node of nodes) {
      const next = [...current, node]
      if (current.length > 0 && textTokens(JSON.stringify(next), settings.model) > budget) {
        groups.push(current)
        current = [node]
      } else current = next
    }
    if (current.length > 0) groups.push(current)
    if (groups.length === nodes.length) {
      groups.length = 0
      for (let index = 0; index < nodes.length; index += 2) groups.push(nodes.slice(index, index + 2))
    }
    const nextSettled = await Promise.allSettled(groups.map((group, index) => overviewFromInput(
      JSON.stringify(group),
      `${keyPrefix}:merge:${level}:${index}:${taskHash(group.map((item) => hashId('overview', JSON.stringify(item))))}`,
      settings,
      store,
      true
    )))
    const failures = nextSettled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new Error(failures.map((item) => errorMessage(item.reason)).join('；'))
    nodes = nextSettled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    level++
  }
  return nodes[0]
}

async function overviewFromInput(
  input: string,
  key: string,
  settings: ApiSettings,
  store: CheckpointStore,
  synthesis: boolean
): Promise<OverviewResult> {
  const cached = store.get<OverviewResult>(key)
  if (cached !== undefined) return cached
  try {
    return await store.run(key, () => callStructured(
      `setting_${key}`,
      settings,
      settingOverviewPrompt(settings.language, synthesis),
      input,
      parseOverview
    ))
  } catch (error) {
    if (!isSplitWorthy(error)) throw error
    const parts = splitRetryText(input, settings)
    if (parts.length < 2) throw error
    const settled = await Promise.allSettled(parts.map((part, index) => overviewFromInput(
      part.text,
      `${key}:part:${index}:${part.sourceFingerprint.slice(0, 12)}`,
      settings,
      store,
      synthesis
    )))
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length > 0) throw new Error(failures.map((item) => errorMessage(item.reason)).join('；'))
    const partials = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const result = await mergeOverviewResults(partials, `${key}:retry`, settings, store)
    await store.succeed(key, result)
    return result
  }
}

async function generateOverview(source: string, distilled: unknown, settings: ApiSettings, store: CheckpointStore): Promise<OverviewResult> {
  const cached = store.get<OverviewResult>('overview')
  if (cached !== undefined) return cached
  const budget = inputBudget(settings) - PROMPT_RESERVE_TOKENS
  const primary = textTokens(source, settings.model) <= budget ? source : JSON.stringify(distilled)
  if (textTokens(primary, settings.model) <= budget) return overviewFromInput(primary, 'overview', settings, store, false)

  const parts = splitSourceByTokenBudget(primary, settings.model, Math.max(1000, Math.floor(budget * 0.75)))
  const settled = await Promise.allSettled(parts.map((part, index) => overviewFromInput(
    part.text,
    `overview:part:${index}:${part.sourceFingerprint.slice(0, 12)}`,
    settings,
    store,
    false
  )))
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length > 0) throw new Error(failures.map((item) => errorMessage(item.reason)).join('；'))
  const nodes = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  const result = await mergeOverviewResults(nodes, 'overview', settings, store)
  await store.succeed('overview', result)
  return result
}

function relationshipText(item: { subject: string; predicate: string; object: string; description: string }): string {
  const base = `${item.subject} — ${item.predicate} — ${item.object}`
  return item.description ? `${base}：${item.description}` : base
}

function entityKind(category: string): SummaryEntityKind {
  const value = category.toLowerCase()
  if (/(character|人物|角色)/.test(value)) return 'character'
  if (/(faction|势力|组织|阵营)/.test(value)) return 'faction'
  if (/(place|地点|地域|城市|国家)/.test(value)) return 'place'
  if (/(item|物品|道具|器物)/.test(value)) return 'item'
  if (/(species|物种|种族)/.test(value)) return 'species'
  if (/(occupation|职业)/.test(value)) return 'occupation'
  if (/(ability|能力|技能|法术)/.test(value)) return 'ability'
  if (/(system|体系|系统|机制)/.test(value)) return 'system'
  if (/(event|事件)/.test(value)) return 'event'
  return 'other'
}

function buildKnowledge(
  entries: Array<Pick<MergedEntry, 'name' | 'category'>>,
  terms: Array<Pick<MergedTerm, 'term'>>,
  relationships: Array<Pick<MergedRelationship, 'subject' | 'predicate' | 'object'>>
): SummaryKnowledgeBase {
  const entityMap = new Map<string, SummaryEntity>()
  for (const entry of entries) {
    const key = normalizeKnowledgeName(entry.name)
    if (!key || entityMap.has(key)) continue
    entityMap.set(key, {
      id: hashId('entity', key),
      kind: entityKind(entry.category),
      name: entry.name,
      aliases: [],
      status: 'confirmed',
      evidence: []
    })
  }
  for (const term of terms) {
    const key = normalizeKnowledgeName(term.term)
    if (!key || entityMap.has(key)) continue
    entityMap.set(key, {
      id: hashId('entity', key),
      kind: 'term',
      name: term.term,
      aliases: [],
      status: 'confirmed',
      evidence: []
    })
  }
  const factMap = new Map<string, SummaryFact>()
  for (const relationship of relationships) {
    const key = [relationship.subject, relationship.predicate, relationship.object].map(normalizeKnowledgeName).join('|')
    if (!key.replaceAll('|', '') || factMap.has(key)) continue
    factMap.set(key, {
      id: hashId('fact', key),
      kind: 'relationship',
      subject: relationship.subject,
      predicate: relationship.predicate,
      object: relationship.object,
      status: 'confirmed',
      evidence: []
    })
  }
  return { entities: [...entityMap.values()], facts: [...factMap.values()] }
}

function chunkResult(unit: UnitExtraction): SummaryChunkResult {
  const summary: SettingSummary = {
    type: 'setting',
    overview: '',
    scope: '',
    entries: unit.entries.map(({ name, category, description }) => ({ name, category, description })),
    terms: unit.terms.map(({ term, definition }) => ({ term, definition })),
    rules: unit.rules.map((item) => item.text),
    relationships: unit.relationships.map(relationshipText),
    timeline: unit.timeline.map((item) => item.text),
    constraints: unit.constraints.map((item) => item.text),
  }
  return {
    id: unit.chunk.id,
    index: unit.chunk.index,
    sourceFingerprint: unit.chunk.sourceFingerprint,
    summary,
    knowledge: buildKnowledge(unit.entries, unit.terms, unit.relationships)
  }
}

export async function distillSettingResourceV2(
  projectId: string,
  resourceId: string,
  source: string,
  settings: ApiSettings,
  progressKey?: string
): Promise<SettingDistillationResult> {
  const sourceInfo = computeSourceInfo(source)
  const store = await CheckpointStore.load(projectId, resourceId, sourceInfo.sourceFingerprint, settings)
  const units = await extractUnits(source, settings, store, progressKey)
  const entryCandidates = units.flatMap((unit) => unit.entries)
  const relationshipCandidates = units.flatMap((unit) => unit.relationships)
  const termCandidates = units.flatMap((unit) => unit.terms)
  const ruleCandidates = units.flatMap((unit) => unit.rules)
  const constraintCandidates = units.flatMap((unit) => unit.constraints)
  const timelineCandidates = units.flatMap((unit) => unit.timeline)

  let completedBranches = 0
  if (progressKey) reportSummaryProgress(progressKey, 'merging', 0, 3)
  const trackBranch = <T>(name: string, task: Promise<T>): Promise<T> => task.then((result) => {
    completedBranches += 1
    if (progressKey) reportSummaryProgress(progressKey, 'merging', completedBranches, 3, `${name} merged`)
    return result
  })
  const merged = await settleRequired('setting_distillation_merge', {
    entityRelationship: trackBranch('Entities and relationships', mergeEntityBranch(entryCandidates, relationshipCandidates, settings, store)),
    mechanisms: trackBranch('Terms, rules and constraints', mergeMechanismBranch(termCandidates, ruleCandidates, constraintCandidates, settings, store)),
    timeline: trackBranch('Timeline', mergeTexts('timeline', timelineCandidates, settings, store))
  })
  if (progressKey) reportSummaryProgress(progressKey, 'overview', 0, 0)
  const distilledForOverview = {
    entries: merged.entityRelationship.entries.map(({ sourceIds: _sourceIds, ...item }) => item),
    relationships: merged.entityRelationship.relationships.map(({ sourceIds: _sourceIds, ...item }) => item),
    terms: merged.mechanisms.terms.map(({ sourceIds: _sourceIds, ...item }) => item),
    rules: merged.mechanisms.rules.map((item) => item.text),
    constraints: merged.mechanisms.constraints.map((item) => item.text),
    timeline: merged.timeline.map((item) => item.text)
  }
  const overview = await generateOverview(source, distilledForOverview, settings, store)
  if (progressKey) reportSummaryProgress(progressKey, 'overview', 1, 1)
  const summary: SettingSummary = {
    type: 'setting',
    overview: overview.overview,
    scope: overview.scope,
    entries: distilledForOverview.entries,
    terms: distilledForOverview.terms,
    rules: distilledForOverview.rules,
    relationships: distilledForOverview.relationships.map(relationshipText),
    timeline: distilledForOverview.timeline,
    constraints: distilledForOverview.constraints,
  }
  return {
    summary,
    knowledge: buildKnowledge(
      merged.entityRelationship.entries,
      merged.mechanisms.terms,
      merged.entityRelationship.relationships
    ),
    chunkResults: units.map(chunkResult),
    totalChunks: units.length
  }
}
