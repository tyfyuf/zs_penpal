import type { SettingSummary, SummaryChunkResult, SummaryKnowledgeBase } from '@shared/types'

export interface SettingEntryCandidate {
  id: string
  name: string
  category: string
  description: string
}

export interface SettingTermCandidate {
  id: string
  term: string
  definition: string
}

export interface SettingRelationshipCandidate {
  id: string
  subject: string
  predicate: string
  object: string
  description: string
}

export interface SettingTextCandidate {
  id: string
  text: string
}

export interface SettingEntityRelationshipExtraction {
  entries: SettingEntryCandidate[]
  relationships: SettingRelationshipCandidate[]
}

export interface SettingMechanismExtraction {
  terms: SettingTermCandidate[]
  rules: SettingTextCandidate[]
  constraints: SettingTextCandidate[]
}

export interface SettingTimelineExtraction {
  timeline: SettingTextCandidate[]
}

export interface SettingDistillationCheckpoint {
  pipelineVersion: 1
  sourceFingerprint: string
  modelFingerprint: string
  language: 'zh' | 'en'
  results: Record<string, unknown>
  failedTasks: Record<string, string>
  updatedAt: string
}

export interface SettingDistillationResult {
  summary: SettingSummary
  knowledge: SummaryKnowledgeBase
  chunkResults: SummaryChunkResult[]
  totalChunks: number
}
