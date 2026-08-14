import { getEncoding, type TiktokenEncoding } from 'js-tiktoken'

let encodingCache: Map<string, ReturnType<typeof getEncoding>> = new Map()

function resolveEncoding(model: string): TiktokenEncoding {
  const m = model.toLowerCase()
  if (/(gpt-4o|gpt-4\.1|gpt-4-turbo|o1|o3|o4|chatgpt-4o)/.test(m)) return 'o200k_base'
  if (/(gpt-4|gpt-3\.5|gpt-35|davinci|text-)/.test(m)) return 'cl100k_base'
  return 'cl100k_base'
}

function getEncoder(model: string): ReturnType<typeof getEncoding> | null {
  const encName = resolveEncoding(model)
  if (encodingCache.has(encName)) return encodingCache.get(encName)!
  try {
    const enc = getEncoding(encName)
    encodingCache.set(encName, enc)
    return enc
  } catch {
    return null
  }
}

/**
 * 按模型 tokenizer 估算 token 数（PRD 6.7）。
 * 主路径使用 js-tiktoken（纯 JS 版 tiktoken），未知模型回退保守估算：
 * 按每 3 字符 1 token 的上界，避免低估导致超预算。
 */
export function estimateTokens(text: string, model: string): number {
  if (!text) return 0
  const enc = getEncoder(model)
  if (enc) {
    try {
      return enc.encode(text).length
    } catch {
      // 忽略，走回退
    }
  }
  return Math.ceil([...text].length / 3)
}
