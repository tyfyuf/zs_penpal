import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODEL_DIR = path.join(PROJECT_ROOT, 'models', 'bge-small-zh-onnx')
const REQUIRED_FILES = [
  'model.onnx',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt'
]
const EXPECTED_MODEL_SHA256 = {
  'model.onnx': '168892246ed23d46f5ef7549db107cfaf9e4ebd947f9fbff28f169d26c99a7ce',
  'config.json': 'de93a80c5dbbe0f42ded2da85bb8e8b94db3d2d0600caedef37c2d2b735b6680',
  'tokenizer.json': '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  'tokenizer_config.json': 'cbe004ed102fc7d706925907e6772aeca04fbe3d90d56a95a09ed75b3f30e7e9',
  'special_tokens_map.json': '5aa43c2f985a25296d5a5ce621c2f77376ca8091a47993c492fd5460b895b140',
  'vocab.txt': '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c'
}

function assertPathWithin(root, candidate, label) {
  const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparableCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const relativePath = path.relative(comparableRoot, comparableCandidate)
  if (
    relativePath === '..' ||
    relativePath.startsWith('..' + path.sep) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} is outside the project root`)
  }
}

async function sha256(filePath) {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  return new Promise((resolveHash, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolveHash(hash.digest('hex')))
  })
}

async function main() {
  const canonicalRoot = await realpath(PROJECT_ROOT)
  const directoryStats = await lstat(MODEL_DIR)
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('Embedding model directory must be a real directory')
  }

  const canonicalDirectory = await realpath(MODEL_DIR)
  assertPathWithin(canonicalRoot, canonicalDirectory, 'Embedding model directory')

  const verifiedFiles = new Map()
  for (const name of REQUIRED_FILES) {
    const filePath = path.join(canonicalDirectory, name)
    const fileStats = await lstat(filePath)
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      throw new Error(`Embedding model file is not a regular file: ${name}`)
    }

    const canonicalFilePath = await realpath(filePath)
    assertPathWithin(canonicalDirectory, canonicalFilePath, `Embedding model file ${name}`)
    assertPathWithin(canonicalRoot, canonicalFilePath, `Embedding model file ${name}`)

    const actualHash = await sha256(canonicalFilePath)
    const expectedHash = EXPECTED_MODEL_SHA256[name]
    if (actualHash !== expectedHash) {
      throw new Error(
        `Embedding model integrity check failed for ${name}: expected ${expectedHash}, got ${actualHash}`
      )
    }
    verifiedFiles.set(name, canonicalFilePath)
  }

  const config = JSON.parse(await readFile(verifiedFiles.get('config.json'), 'utf8'))
  const tokenizerConfig = JSON.parse(await readFile(verifiedFiles.get('tokenizer_config.json'), 'utf8'))
  if (config.hidden_size !== 512) {
    throw new Error(`config.json hidden_size must be 512, got ${config.hidden_size}`)
  }
  if (config.max_position_embeddings !== 512) {
    throw new Error(
      `config.json max_position_embeddings must be 512, got ${config.max_position_embeddings}`
    )
  }
  if (tokenizerConfig.model_max_length !== 512) {
    throw new Error(
      `tokenizer_config.json model_max_length must be 512, got ${tokenizerConfig.model_max_length}`
    )
  }

  console.log(`embedding model verified: ${canonicalDirectory}`)
  for (const name of REQUIRED_FILES) {
    console.log(`${name} sha256: ${EXPECTED_MODEL_SHA256[name]}`)
  }
}

main().catch((error) => {
  console.error(
    `embedding model verification failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})