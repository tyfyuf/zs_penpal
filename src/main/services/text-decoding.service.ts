import { analyse } from 'chardet'
import iconv from 'iconv-lite'
import { readFile } from 'node:fs/promises'

export type TextIntegrityIssue = 'replacement-characters' | 'nul-characters' | 'control-characters' | 'mojibake'

export interface TextIntegrityInfo {
  suspicious: boolean
  issue?: TextIntegrityIssue
  replacementCount: number
  nulCount: number
  controlCount: number
  mojibakeCount: number
}

export interface TextEncodingInfo extends TextIntegrityInfo {
  encoding: string
  confidence: number
  hadBom: boolean
}

export interface DecodedText {
  text: string
  info: TextEncodingInfo
}

interface BomInfo {
  encoding: string
  length: number
}

const MOJIBAKE_PATTERNS = [/Ã./g, /Â./g, /â[€™œ“”]/g, /锟斤拷/g]

function detectBom(buffer: Buffer): BomInfo | null {
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0xfe && buffer[3] === 0xff) {
    return { encoding: 'utf-32be', length: 4 }
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xfe && buffer[2] === 0x00 && buffer[3] === 0x00) {
    return { encoding: 'utf-32le', length: 4 }
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return { encoding: 'utf-16le', length: 2 }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return { encoding: 'utf-16be', length: 2 }
  return null
}

function normalizeEncodingName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/_/g, '-')
  const aliases: Record<string, string> = {
    ascii: 'utf-8',
    utf8: 'utf-8',
    'utf-16': 'utf-16le',
    'utf-32': 'utf-32le',
    gb2312: 'gb18030',
    gbk: 'gb18030',
    'iso-8859-1': 'windows-1252'
  }
  return aliases[normalized] ?? normalized
}

function decodeWithEncoding(buffer: Buffer, encoding: string): string {
  const normalized = normalizeEncodingName(encoding)
  if (!iconv.encodingExists(normalized)) throw new Error(`不支持的文本编码：${encoding}`)
  return iconv.decode(buffer, normalized).replace(/^\uFEFF/, '')
}

function isStrictUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

export function analyzeTextIntegrity(text: string): TextIntegrityInfo {
  const length = Math.max(1, text.length)
  const replacementCount = (text.match(/\uFFFD/g) ?? []).length
  const nulCount = (text.match(/\u0000/g) ?? []).length
  const controlCount = [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0
    return (code < 0x20 && char !== '\r' && char !== '\n' && char !== '\t') || (code >= 0x7f && code <= 0x9f)
  }).length
  const mojibakeCount = MOJIBAKE_PATTERNS.reduce((sum, pattern) => sum + (text.match(pattern) ?? []).length, 0)

  let issue: TextIntegrityIssue | undefined
  if (nulCount > 0) issue = 'nul-characters'
  else if (replacementCount >= 3 && replacementCount / length >= 0.001) issue = 'replacement-characters'
  else if (controlCount >= 3 && controlCount / length >= 0.005) issue = 'control-characters'
  else if (mojibakeCount >= 3 && mojibakeCount / length >= 0.002) issue = 'mojibake'

  return { suspicious: Boolean(issue), issue, replacementCount, nulCount, controlCount, mojibakeCount }
}

export function decodeTextBuffer(input: Uint8Array | Buffer, encodingHint?: string): DecodedText {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const bom = detectBom(buffer)
  let encoding: string
  let confidence: number
  let payload = buffer

  if (bom) {
    encoding = bom.encoding
    confidence = 100
    payload = buffer.subarray(bom.length)
  } else if (encodingHint) {
    encoding = normalizeEncodingName(encodingHint)
    confidence = 100
  } else if (isStrictUtf8(buffer)) {
    encoding = 'utf-8'
    confidence = 100
  } else {
    const matches = analyse(buffer)
      .map((match) => ({ encoding: normalizeEncodingName(match.name), confidence: match.confidence }))
      .filter((match) => iconv.encodingExists(match.encoding))
    const detected = matches[0]
    encoding = detected?.encoding ?? 'windows-1252'
    confidence = detected?.confidence ?? 0
  }

  const text = decodeWithEncoding(payload, encoding)
  return {
    text,
    info: {
      encoding,
      confidence,
      hadBom: Boolean(bom),
      ...analyzeTextIntegrity(text)
    }
  }
}

export async function readDecodedTextFile(filePath: string): Promise<DecodedText> {
  return decodeTextBuffer(await readFile(filePath))
}

export function assertTextIntegrity(info: TextIntegrityInfo, label = '文本'): void {
  if (!info.suspicious) return
  throw new Error(`${label}疑似存在编码乱码，请重新从原文件导入后再试`)
}
