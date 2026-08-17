import { app } from 'electron'
import { access } from 'fs/promises'
import { join, resolve } from 'path'
import { logVectorEvent } from './log.service'

export const NEURAL_EMBED_MODEL = 'bge-small-zh-v1.5-onnx-fp32-cls-qinst-v1'
export const NEURAL_EMBED_DIM = 512
export const NEURAL_MAX_CONTENT_TOKENS = 480
export const NEURAL_OVERLAP_TOKENS = 48
export const NEURAL_BATCH_SIZE = 4
export const BGE_QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：'

const MODEL_DIR_NAME = 'bge-small-zh-onnx'
const REQUIRED_MODEL_FILES = [
  'model.onnx',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt'
] as const
const RETRY_AFTER_FAILURE_MS = 30_000

type TensorLike = {
  data: ArrayLike<number>
  dims: number[]
}

type TokenizerOutput = {
  input_ids?: { data?: ArrayLike<unknown>; dims?: number[] }
}

type FeatureExtractionPipeline = {
  (
    input: string | string[],
    options: { pooling: 'cls'; normalize: true; truncation: true }
  ): Promise<TensorLike>
  tokenizer: (
    input: string,
    options: { add_special_tokens: boolean; truncation: boolean }
  ) => TokenizerOutput
  dispose?: () => void | Promise<void>
}

export interface NeuralEmbedder {
  readonly id: typeof NEURAL_EMBED_MODEL
  readonly dimension: typeof NEURAL_EMBED_DIM
  countTokens(text: string): number
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(query: string): Promise<number[]>
}

let pipelineInstance: FeatureExtractionPipeline | null = null
let loadPromise: Promise<NeuralEmbedder | null> | null = null
let nextRetryAt = 0

function modelDir(): string {
  const override = process.env.VIBEWRITE_EMBED_MODEL_DIR?.trim()
  if (override) return resolve(override)
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return join(base, 'models', MODEL_DIR_NAME)
}

async function assertModelFiles(dir: string): Promise<void> {
  await Promise.all(REQUIRED_MODEL_FILES.map((name) => access(join(dir, name))))
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeVector(values: number[]): number[] {
  if (values.length !== NEURAL_EMBED_DIM || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`神经嵌入输出无效：期望 ${NEURAL_EMBED_DIM} 维，实际 ${values.length} 维`)
  }
  let norm = 0
  for (const value of values) norm += value * value
  norm = Math.sqrt(norm)
  if (!Number.isFinite(norm) || norm <= 0) throw new Error('神经嵌入输出范数无效')
  return values.map((value) => value / norm)
}

function unpackBatch(output: TensorLike, expectedCount: number): number[][] {
  const values = Array.from(output.data)
  const dimension = output.dims.at(-1) ?? 0
  const rowCount = output.dims.length >= 2 ? output.dims[0] : expectedCount
  if (
    dimension !== NEURAL_EMBED_DIM ||
    rowCount !== expectedCount ||
    values.length !== expectedCount * NEURAL_EMBED_DIM
  ) {
    throw new Error(
      `神经嵌入输出形状无效：dims=${JSON.stringify(output.dims)} length=${values.length}`
    )
  }
  const rows: number[][] = []
  for (let i = 0; i < expectedCount; i++) {
    rows.push(normalizeVector(values.slice(i * NEURAL_EMBED_DIM, (i + 1) * NEURAL_EMBED_DIM)))
  }
  return rows
}

async function invalidatePipeline(reason: string): Promise<void> {
  const current = pipelineInstance
  pipelineInstance = null
  loadPromise = null
  nextRetryAt = Date.now() + RETRY_AFTER_FAILURE_MS
  if (current?.dispose) {
    try {
      await current.dispose()
    } catch {
      // 销毁失败不影响特征哈希回退
    }
  }
  logVectorEvent({ stage: 'fallback', backend: NEURAL_EMBED_MODEL, outcome: 'failure', reason })
}

async function createEmbedder(): Promise<NeuralEmbedder | null> {
  const startedAt = Date.now()
  try {
    const dir = modelDir()
    await assertModelFiles(dir)
    const transformers = await import('@huggingface/transformers')
    transformers.env.allowLocalModels = true
    transformers.env.allowRemoteModels = false
    const extractor = (await transformers.pipeline('feature-extraction', dir, {
      dtype: 'fp32',
      device: 'cpu',
      subfolder: ''
    })) as unknown as FeatureExtractionPipeline
    pipelineInstance = extractor

    const embedDocuments = async (texts: string[]): Promise<number[][]> => {
      if (texts.length === 0) return []
      const rows: number[][] = []
      try {
        for (let offset = 0; offset < texts.length; offset += NEURAL_BATCH_SIZE) {
          const batch = texts.slice(offset, offset + NEURAL_BATCH_SIZE)
          const output = await extractor(batch, { pooling: 'cls', normalize: true, truncation: true })
          rows.push(...unpackBatch(output, batch.length))
        }
        return rows
      } catch (error) {
        const reason = `神经嵌入推理失败：${toErrorMessage(error)}`
        await invalidatePipeline(reason)
        throw new Error(reason)
      }
    }

    const embedder: NeuralEmbedder = {
      id: NEURAL_EMBED_MODEL,
      dimension: NEURAL_EMBED_DIM,
      countTokens(text: string): number {
        if (!text) return 0
        const encoded = extractor.tokenizer(text, { add_special_tokens: false, truncation: false })
        return encoded.input_ids?.data?.length ?? encoded.input_ids?.dims?.at(-1) ?? 0
      },
      embedDocuments,
      async embedQuery(query: string): Promise<number[]> {
        const rows = await embedDocuments([`${BGE_QUERY_INSTRUCTION}${query.trim()}`])
        if (!rows[0]) throw new Error('神经查询嵌入为空')
        return rows[0]
      }
    }

    logVectorEvent({
      stage: 'load',
      backend: NEURAL_EMBED_MODEL,
      outcome: 'success',
      durationMs: Date.now() - startedAt
    })
    return embedder
  } catch (error) {
    const reason = `神经嵌入加载失败：${toErrorMessage(error)}`
    pipelineInstance = null
    nextRetryAt = Date.now() + RETRY_AFTER_FAILURE_MS
    logVectorEvent({
      stage: 'load',
      backend: NEURAL_EMBED_MODEL,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      reason
    })
    return null
  }
}

/** 延迟加载本地 BGE；模型不可用时返回 null，由调用方切换到特征哈希。 */
export async function getNeuralEmbedder(): Promise<NeuralEmbedder | null> {
  if (pipelineInstance && loadPromise) return loadPromise
  if (Date.now() < nextRetryAt) return null
  if (!loadPromise) loadPromise = createEmbedder()
  const result = await loadPromise
  if (!result) loadPromise = null
  return result
}

export async function disposeNeuralEmbedder(): Promise<void> {
  const current = pipelineInstance
  pipelineInstance = null
  loadPromise = null
  nextRetryAt = 0
  if (!current?.dispose) return
  const startedAt = Date.now()
  try {
    await current.dispose()
    logVectorEvent({
      stage: 'dispose',
      backend: NEURAL_EMBED_MODEL,
      outcome: 'success',
      durationMs: Date.now() - startedAt
    })
  } catch (error) {
    logVectorEvent({
      stage: 'dispose',
      backend: NEURAL_EMBED_MODEL,
      outcome: 'failure',
      durationMs: Date.now() - startedAt,
      reason: toErrorMessage(error)
    })
  }
}
