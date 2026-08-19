import { createHash } from 'crypto'
import type {
  SummaryEntity,
  SummaryEntityKind,
  SummaryEvidence,
  SummaryFact,
  SummaryFactKind,
  SummaryKnowledgeBase,
  SummaryKnowledgeStatus
} from '@shared/types'

const ENTITY_KINDS = new Set<SummaryEntityKind>([
  'character', 'faction', 'place', 'item', 'species', 'occupation',
  'ability', 'system', 'term', 'event', 'other'
])
const FACT_KINDS = new Set<SummaryFactKind>([
  'identity', 'relationship', 'rule', 'constraint', 'exception',
  'timeline', 'event', 'other'
])
const STATUS = new Set<SummaryKnowledgeStatus>(['confirmed', 'ambiguous', 'conflict', 'unverified'])
const ALIAS_WORDS = /(?:alias|aka|also\s+(?:called|known\s+as)|another\s+name\s+for|\u522b\u540d|\u53c8\u79f0|\u4e5f\u79f0|\u79f0\u4e3a|\u5373)/iu

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => clean(item, maxLength)).filter(Boolean).slice(0, maxItems)
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 12)}`
}

export function normalizeKnowledgeName(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, '')
}

export function sourceContainsName(source: string, name: string): boolean {
  const normalized = normalizeKnowledgeName(name)
  return normalized.length > 0 && normalizeKnowledgeName(source).includes(normalized)
}

export function sourceContainsEvidence(source: string, quote: string): boolean {
  const normalized = normalizeKnowledgeName(quote)
  return normalized.length >= 2 && normalizeKnowledgeName(source).includes(normalized)
}

function normalizedSearchView(value: string): { text: string; sourceOffsets: number[] } {
  let text = ''
  const sourceOffsets: number[] = []
  let sourceOffset = 0
  for (const sourceChar of value) {
    const normalized = sourceChar.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '')
    for (const normalizedChar of normalized) {
      text += normalizedChar
      sourceOffsets.push(sourceOffset)
    }
    sourceOffset += sourceChar.length
  }
  return { text, sourceOffsets }
}

function occurrences(haystack: string, needle: string): number[] {
  if (!needle) return []
  const found: number[] = []
  let from = 0
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    found.push(index)
    from = index + Math.max(1, needle.length)
  }
  return found
}

export function hasExplicitAliasRelation(source: string, name: string, alias: string): boolean {
  const normalizedName = normalizeKnowledgeName(name)
  const normalizedAlias = normalizeKnowledgeName(alias)
  if (!normalizedName || !normalizedAlias) return false

  // Locate names with the same NFKC/case/punctuation normalization used by
  // sourceContainsName, but map the match back to the original source before
  // checking relation words. This preserves English whitespace in phrases such
  // as "also known as" while accepting full-width or punctuated name variants.
  const view = normalizedSearchView(source)
  const nameIndexes = occurrences(view.text, normalizedName)
  const aliasIndexes = occurrences(view.text, normalizedAlias)
  if (nameIndexes.length === 0 || aliasIndexes.length === 0) return false

  let aliasCursor = 0
  for (const nameIndex of nameIndexes) {
    while (aliasCursor + 1 < aliasIndexes.length && aliasIndexes[aliasCursor + 1] <= nameIndex) aliasCursor++
    for (const aliasIndex of aliasIndexes.slice(Math.max(0, aliasCursor - 1), aliasCursor + 2)) {
      if (Math.abs(nameIndex - aliasIndex) > 320) continue
      const normalizedStart = Math.min(nameIndex, aliasIndex)
      const normalizedEnd = Math.max(nameIndex + normalizedName.length, aliasIndex + normalizedAlias.length) - 1
      const sourceStart = Math.max(0, (view.sourceOffsets[normalizedStart] ?? 0) - 160)
      const sourceEnd = Math.min(source.length, (view.sourceOffsets[normalizedEnd] ?? source.length) + 160)
      if (ALIAS_WORDS.test(source.slice(sourceStart, sourceEnd))) return true
    }
  }
  return false
}

function validateEvidence(value: unknown, source: string, sourceChunkId: string): SummaryEvidence[] {
  const candidates = Array.isArray(value) ? value : value ? [value] : []
  const seen = new Set<string>()
  const valid: SummaryEvidence[] = []
  for (const raw of candidates) {
    const item = raw as Record<string, unknown>
    const quote = clean(typeof raw === 'string' ? raw : item?.quote, 240)
    if (!quote || !sourceContainsEvidence(source, quote)) continue
    const key = normalizeKnowledgeName(quote)
    if (seen.has(key)) continue
    seen.add(key)
    valid.push({ sourceChunkId, quote })
    if (valid.length >= 3) break
  }
  return valid
}

function statusOf(value: unknown, valid: boolean): SummaryKnowledgeStatus {
  const proposed = clean(value, 24) as SummaryKnowledgeStatus
  if (!valid) return 'unverified'
  return STATUS.has(proposed) && proposed !== 'unverified' ? proposed : 'confirmed'
}

export function validateKnowledge(raw: unknown, source: string, sourceChunkId: string): SummaryKnowledgeBase {
  const input = (raw ?? {}) as Record<string, unknown>
  const entitiesRaw = Array.isArray(input.entities) ? input.entities : []
  const factsRaw = Array.isArray(input.facts) ? input.facts : []
  const entities: SummaryEntity[] = []
  const facts: SummaryFact[] = []
  const seenEntities = new Set<string>()
  const seenFacts = new Set<string>()

  for (const item of entitiesRaw.slice(0, 80)) {
    const entity = item as Record<string, unknown>
    const name = clean(entity.name, 120)
    if (!name) continue
    const key = normalizeKnowledgeName(name)
    if (!key || seenEntities.has(key)) continue
    seenEntities.add(key)
    const kindValue = clean(entity.kind, 24) as SummaryEntityKind
    const kind = ENTITY_KINDS.has(kindValue) ? kindValue : 'other'
    const evidence = validateEvidence(entity.evidence, source, sourceChunkId)
    const aliases = cleanList(entity.aliases, 12, 120).filter((alias) => (
      normalizeKnowledgeName(alias) !== key && hasExplicitAliasRelation(source, name, alias)
    ))
    const valid = sourceContainsName(source, name) && evidence.length > 0
    entities.push({
      id: stableId('entity', key),
      kind,
      name,
      aliases: [...new Set(aliases)],
      status: statusOf(entity.status, valid),
      evidence
    })
  }

  for (const item of factsRaw.slice(0, 160)) {
    const fact = item as Record<string, unknown>
    const subject = clean(fact.subject, 160)
    const predicate = clean(fact.predicate, 160)
    const object = clean(fact.object, 240)
    if (!subject || !predicate || !object) continue
    const key = `${normalizeKnowledgeName(subject)}|${normalizeKnowledgeName(predicate)}|${normalizeKnowledgeName(object)}`
    if (!key.replaceAll('|', '') || seenFacts.has(key)) continue
    seenFacts.add(key)
    const kindValue = clean(fact.kind, 24) as SummaryFactKind
    const kind = FACT_KINDS.has(kindValue) ? kindValue : 'other'
    const evidence = validateEvidence(fact.evidence, source, sourceChunkId)
    const valid = evidence.length > 0 && sourceContainsName(source, subject) && sourceContainsName(source, object)
    facts.push({
      id: stableId('fact', key),
      kind,
      subject,
      predicate,
      object,
      status: statusOf(fact.status, valid),
      evidence
    })
  }
  return { entities, facts }
}

function mergedStatus(values: SummaryKnowledgeStatus[]): SummaryKnowledgeStatus {
  if (values.includes('conflict')) return 'conflict'
  if (values.includes('confirmed')) return 'confirmed'
  if (values.includes('ambiguous')) return 'ambiguous'
  return 'unverified'
}

export function mergeKnowledgeBases(bases: SummaryKnowledgeBase[]): SummaryKnowledgeBase {
  const entityMap = new Map<string, SummaryEntity>()
  const factMap = new Map<string, SummaryFact>()
  for (const base of bases) {
    for (const entity of base.entities ?? []) {
      const key = normalizeKnowledgeName(entity.name)
      if (!key) continue
      const prior = entityMap.get(key)
      if (!prior) {
        entityMap.set(key, { ...entity, aliases: [...entity.aliases], evidence: [...entity.evidence] })
        continue
      }
      prior.aliases = [...new Set([...prior.aliases, ...entity.aliases])]
      prior.evidence = uniqueEvidence([...prior.evidence, ...entity.evidence])
      prior.status = mergedStatus([prior.status, entity.status])
      if (prior.kind !== entity.kind && prior.kind !== 'other' && entity.kind !== 'other') prior.status = 'conflict'
    }
    for (const fact of base.facts ?? []) {
      const key = `${normalizeKnowledgeName(fact.subject)}|${normalizeKnowledgeName(fact.predicate)}|${normalizeKnowledgeName(fact.object)}`
      if (!key.replaceAll('|', '')) continue
      const prior = factMap.get(key)
      if (!prior) {
        factMap.set(key, { ...fact, evidence: [...fact.evidence] })
        continue
      }
      prior.evidence = uniqueEvidence([...prior.evidence, ...fact.evidence])
      prior.status = mergedStatus([prior.status, fact.status])
    }
  }
  return { entities: [...entityMap.values()], facts: [...factMap.values()] }
}

function uniqueEvidence(items: SummaryEvidence[]): SummaryEvidence[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.sourceChunkId}:${normalizeKnowledgeName(item.quote)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 3)
}

export function confirmedKnowledge(base: SummaryKnowledgeBase): SummaryKnowledgeBase {
  return {
    entities: (base.entities ?? []).filter((entity) => entity.status === 'confirmed'),
    facts: (base.facts ?? []).filter((fact) => fact.status === 'confirmed')
  }
}
