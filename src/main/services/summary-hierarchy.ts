import type { ResourceDistillType, SummaryChunkResult, SummaryGenerationInfo } from '@shared/types'
import { estimateTokens } from './tokenizer'
import { fingerprintOf, normalizeForFingerprint } from '../summary-source'

export interface SourceChunk {
  id: string
  index: number
  start: number
  end: number
  sourceFingerprint: string
  text: string
}

function chunkId(index: number, fingerprint: string): string {
  return `chunk_${index}_${fingerprint.slice(0, 12)}`
}

function textTokens(text: string, model: string): number {
  const estimated = estimateTokens(text, model)
  const cjkConservative = Math.ceil([...text].length * 1.05)
  return Math.max(estimated, cjkConservative)
}

function splitOversized(text: string, targetTokens: number, model: string): string[] {
  if (textTokens(text, model) <= targetTokens) return [text]
  const sentences = text.split(/(?<=[\u3002\uff01\uff1f.!?])\s*/u).filter(Boolean)
  if (sentences.length <= 1) return splitBySearch(text, targetTokens, model)
  const output: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const next = current ? `${current}${sentence}` : sentence
    if (current && textTokens(next, model) > targetTokens) {
      output.push(current)
      current = ''
      if (textTokens(sentence, model) > targetTokens) output.push(...splitBySearch(sentence, targetTokens, model))
      else current = sentence
    } else {
      current = next
    }
  }
  if (current) output.push(current)
  return output
}

function splitBySearch(text: string, targetTokens: number, model: string): string[] {
  const result: string[] = []
  let rest = text
  while (rest && textTokens(rest, model) > targetTokens) {
    let low = 1
    let high = rest.length
    let best = 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      if (textTokens(rest.slice(0, mid), model) <= targetTokens) {
        best = mid
        low = mid + 1
      } else high = mid - 1
    }
    let cut = best
    const boundary = Math.max(rest.lastIndexOf('\n', best), rest.lastIndexOf(' ', best), rest.lastIndexOf('\u3002', best), rest.lastIndexOf('\uff0c', best))
    if (boundary > Math.floor(best * 0.55)) cut = boundary + 1
    result.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) result.push(rest)
  return result
}

/** Splits text with heading/paragraph/sentence preference while enforcing a token budget. */
export function splitSourceByTokenBudget(source: string, model: string, targetTokens: number): SourceChunk[] {
  const target = Math.max(800, targetTokens)
  const paragraphs = source.split(/(?=^#{1,6}\s)|\n{2,}/mu).filter((part) => part.length > 0)
  const parts = paragraphs.flatMap((part) => splitOversized(part, target, model))
  const chunks: SourceChunk[] = []
  let current = ''
  let currentStart = 0
  let cursor = 0
  const flush = (): void => {
    if (!current) return
    const fingerprint = fingerprintOf(normalizeForFingerprint(current))
    const index = chunks.length
    chunks.push({ id: chunkId(index, fingerprint), index, start: currentStart, end: currentStart + current.length, sourceFingerprint: fingerprint, text: current })
    current = ''
  }
  for (const part of parts) {
    const position = source.indexOf(part, cursor)
    const start = position >= 0 ? position : cursor
    cursor = Math.max(cursor, start + part.length)
    const separator = current ? '\n\n' : ''
    if (current && textTokens(current + separator + part, model) > target) flush()
    if (!current) currentStart = start
    current += (current ? '\n\n' : '') + part
  }
  flush()
  if (chunks.length === 0 && source.trim()) {
    const fingerprint = fingerprintOf(normalizeForFingerprint(source))
    chunks.push({ id: chunkId(0, fingerprint), index: 0, start: 0, end: source.length, sourceFingerprint: fingerprint, text: source })
  }
  return chunks
}

export function reusableChunkResults(
  chunks: SourceChunk[],
  previous: SummaryChunkResult[] | undefined,
  type: ResourceDistillType
): Map<string, SummaryChunkResult> {
  const candidates = new Map<string, SummaryChunkResult>()
  for (const result of previous ?? []) {
    if (result.summary?.type !== type || !result.knowledge) continue
    candidates.set(result.sourceFingerprint, result)
  }
  const reusable = new Map<string, SummaryChunkResult>()
  for (const chunk of chunks) {
    const previousResult = candidates.get(chunk.sourceFingerprint)
    if (previousResult) {
      const knowledge = {
        entities: previousResult.knowledge.entities.map((entity) => ({
          ...entity,
          evidence: entity.evidence.map((item) => ({ ...item, sourceChunkId: chunk.id }))
        })),
        facts: previousResult.knowledge.facts.map((fact) => ({
          ...fact,
          evidence: fact.evidence.map((item) => ({ ...item, sourceChunkId: chunk.id }))
        }))
      }
      reusable.set(chunk.id, { ...previousResult, id: chunk.id, index: chunk.index, knowledge })
    }
  }
  return reusable
}

export function generationInfo(totalChunks: number, completed: SummaryChunkResult[], failed: string[]): SummaryGenerationInfo {
  return {
    state: failed.length === 0 && completed.length === totalChunks ? 'complete' : 'incomplete',
    totalChunks,
    completedChunks: completed.length,
    failedChunkIds: [...new Set(failed)]
  }
}
