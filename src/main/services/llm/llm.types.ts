import type { ApiProtocol } from '@shared/types'

export type { ApiProtocol }

export interface StructuredResponseUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export interface StructuredResponse {
  output_text: string
  output?: unknown[]
  status?: string | null
  incomplete_details?: { reason?: string | null } | null
  finish_reason?: string | null
  usage?: StructuredResponseUsage | null
  error_message?: string | null
}
