import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MODEL_DIR = path.resolve('models', 'bge-small-zh-onnx')
const EXPECTED_MODEL_SHA256 = '168892246ed23d46f5ef7549db107cfaf9e4ebd947f9fbff28f169d26c99a7ce'
const EXPECTED_TOKENIZER_SHA256 = '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'
const REQUIRED_FILES = [
  'model.onnx',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt'
]

async function sha256(file) {
  const data = await readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

async function main() {
  for (const name of REQUIRED_FILES) {
    const info = await stat(path.join(MODEL_DIR, name))
    if (!info.isFile() || info.size === 0) throw new Error(`模型文件无效：${name}`)
  }

  const config = JSON.parse(await readFile(path.join(MODEL_DIR, 'config.json'), 'utf8'))
  const tokenizerConfig = JSON.parse(await readFile(path.join(MODEL_DIR, 'tokenizer_config.json'), 'utf8'))
  if (config.hidden_size !== 512) throw new Error(`hidden_size 应为 512，实际为 ${config.hidden_size}`)
  if (config.max_position_embeddings !== 512) {
    throw new Error(`max_position_embeddings 应为 512，实际为 ${config.max_position_embeddings}`)
  }
  if (tokenizerConfig.model_max_length !== 512) {
    throw new Error(`tokenizer model_max_length 应为 512，实际为 ${tokenizerConfig.model_max_length}`)
  }

  const modelHash = await sha256(path.join(MODEL_DIR, 'model.onnx'))
  if (modelHash !== EXPECTED_MODEL_SHA256) throw new Error(`model.onnx SHA-256 不匹配：${modelHash}`)
  const tokenizerHash = await sha256(path.join(MODEL_DIR, 'tokenizer.json'))
  if (tokenizerHash !== EXPECTED_TOKENIZER_SHA256) {
    throw new Error(`tokenizer.json SHA-256 不匹配：${tokenizerHash}`)
  }

  console.log(`embedding model verified: ${MODEL_DIR}`)
  console.log(`model.onnx sha256: ${modelHash}`)
}

main().catch((error) => {
  console.error(`embedding model verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
