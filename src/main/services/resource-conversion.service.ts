import { createRequire } from 'node:module'
import { join } from 'node:path'
import mammoth from 'mammoth'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import WordExtractor from 'word-extractor'
import type { ResourceContentFormat, ResourceSourceFormat } from '@shared/resource-formats'
import { getResourceSourceFormat } from '@shared/resource-formats'
import type { TextEncodingInfo } from '@shared/types'
import { assertTextIntegrity, decodeTextBuffer } from './text-decoding.service'


interface QueryableHtmlNode {
  textContent?: string | null
  querySelectorAll(selector: string): ArrayLike<QueryableHtmlNode>
}

export interface ConvertedResourceInput {
  content: string
  sourceFormat: ResourceSourceFormat
  contentFormat: ResourceContentFormat
  warnings: string[]
  encoding?: TextEncodingInfo
}

function normalizeConvertedText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function assertHasContent(content: string, name: string): void {
  if (!content.trim()) throw new Error(`“${name}”中没有可提取的正文内容`)
}

function wordError(name: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('password') || lower.includes('encrypted') || lower.includes('encryption')) {
    return new Error(`“${name}”已加密或受密码保护，请解除保护后重新上传`)
  }
  if (message.includes('没有可提取的正文内容')) return error instanceof Error ? error : new Error(message)
  if (lower.includes('zip') || lower.includes('central directory') || lower.includes('corrupt')) {
    return new Error(`“${name}”文件已损坏或不是有效的 Word 文档`)
  }
  return new Error(`无法读取 Word 文档“${name}”：${message}`)
}

async function convertDocx(name: string, data: Uint8Array): Promise<ConvertedResourceInput> {
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(data) },
      {
        includeDefaultStyleMap: true,
        includeEmbeddedStyleMap: true,
        ignoreEmptyParagraphs: false,
        externalFileAccess: false,
        convertImage: mammoth.images.imgElement(async () => ({ src: 'penpal-resource-image' }))
      }
    )
    const turndown = new TurndownService({
      headingStyle: 'atx',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',
      emDelimiter: '*',
      strongDelimiter: '**'
    })
    turndown.use(gfm)
    // Word tables usually contain only <td> cells. The GFM plugin intentionally
    // skips tables without a <th> header row, so provide a fallback that keeps
    // every row instead of leaking raw HTML into the normalized resource text.
    turndown.addRule('penpal-word-table', {
      filter: 'table',
      replacement: (_content, node) => {
        const tableRows = Array.from((node as unknown as QueryableHtmlNode).querySelectorAll('tr'))
        const rows = tableRows
          .map((row) =>
            Array.from(row.querySelectorAll('th, td')).map((cell) =>
              (cell.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
            )
          )
          .filter((row) => row.length > 0)
        if (rows.length === 0) return ''
        const width = Math.max(...rows.map((row) => row.length))
        const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')])
        const separator = Array(width).fill('---')
        return `\n\n${[normalized[0], separator, ...normalized.slice(1)]
          .map((row) => `| ${row.join(' | ')} |`)
          .join('\n')}\n\n`
      }
    })
    turndown.addRule('penpal-image-placeholder', {
      filter: 'img',
      replacement: (_content, node) => {
        const alt = node.getAttribute('alt')?.trim()
        return alt ? `[图片：${alt}]` : '[图片]'
      }
    })
    const content = normalizeConvertedText(turndown.turndown(result.value))
    assertHasContent(content, name)
    const warnings = result.messages
      .filter((message) => message.type === 'warning')
      .map((message) => `Word 转换提示：${message.message}`)
    return { content, sourceFormat: 'docx', contentFormat: 'markdown', warnings }
  } catch (error) {
    throw wordError(name, error)
  }
}

interface LegacyWordDocument {
  getBody(): string
  getFootnotes(): string
  getEndnotes(): string
}

interface LegacyWordOleExtractor {
  new (): {
    _boundaries: Record<string, number>
    documentStream(document: unknown, streamName: string): Promise<unknown>
    streamBuffer(stream: unknown): Promise<Buffer>
    writePieces(buffer: Buffer, tableBuffer: Buffer): void
    buildDocument(): LegacyWordDocument
  }
}

interface LegacyOleCompoundDoc {
  new (reader: unknown): {
    read(): Promise<void>
    stream(streamName: string): unknown
  }
}

interface LegacyBufferReader {
  new (buffer: Buffer): unknown
}

function loadLegacyDocInternals(): {
  WordOleExtractor: LegacyWordOleExtractor
  OleCompoundDoc: LegacyOleCompoundDoc
  BufferReader: LegacyBufferReader
} {
  // word-extractor does not expose its OLE parser publicly. Loading these
  // modules through Node's CJS resolver keeps the compatibility path optional
  // and leaves the normal extractor untouched for documents it handles well.
  const require = createRequire(join(__dirname, 'index.js'))
  return {
    WordOleExtractor: require('word-extractor/lib/word-ole-extractor') as LegacyWordOleExtractor,
    OleCompoundDoc: require('word-extractor/lib/ole-compound-doc') as LegacyOleCompoundDoc,
    BufferReader: require('word-extractor/lib/buffer-reader') as LegacyBufferReader
  }
}

async function extractDocWithoutFormatting(data: Uint8Array): Promise<LegacyWordDocument> {
  const { WordOleExtractor, OleCompoundDoc, BufferReader } = loadLegacyDocInternals()
  const extractor = new WordOleExtractor()
  const compound = new OleCompoundDoc(new BufferReader(Buffer.from(data)))
  await compound.read()

  const wordStream = await extractor.documentStream(compound, 'WordDocument')
  const wordBuffer = await extractor.streamBuffer(wordStream)
  if (wordBuffer.length < 0x6c || wordBuffer.readUInt16LE(0) !== 0xa5ec) {
    throw new Error('\u4e0d\u662f\u6709\u6548\u7684\u65e7\u7248 Word \u6587\u6863')
  }

  const flags = wordBuffer.readUInt16LE(0x0a)
  const tableName = (flags & 0x0200) !== 0 ? '1Table' : '0Table'
  const tableStream = await extractor.documentStream(compound, tableName)
  const tableBuffer = await extractor.streamBuffer(tableStream)

  extractor._boundaries = {
    fcMin: wordBuffer.readUInt32LE(0x0018),
    ccpText: wordBuffer.readUInt32LE(0x004c),
    ccpFtn: wordBuffer.readUInt32LE(0x0050),
    ccpHdd: wordBuffer.readUInt32LE(0x0054),
    ccpAtn: wordBuffer.readUInt32LE(0x005c),
    ccpEdn: wordBuffer.readUInt32LE(0x0060),
    ccpTxbx: wordBuffer.readUInt32LE(0x0064),
    ccpHdrTxbx: wordBuffer.readUInt32LE(0x0068)
  }
  // Some old .doc files contain valid piece data but incompatible character
  // or paragraph property tables. writePieces() is the safe text-only path;
  // the formatting passes can replace valid pieces with NUL characters.
  extractor.writePieces(wordBuffer, tableBuffer)
  return extractor.buildDocument()
}

function documentTextSections(document: LegacyWordDocument): string {
  const sections = [document.getBody()]
  const footnotes = document.getFootnotes().trim()
  const endnotes = document.getEndnotes().trim()
  if (footnotes) sections.push(`\u811a\u6ce8\n\n${footnotes}`)
  if (endnotes) sections.push(`\u5c3e\u6ce8\n\n${endnotes}`)
  return normalizeConvertedText(sections.join('\n\n'))
}

async function convertDoc(name: string, data: Uint8Array): Promise<ConvertedResourceInput> {
  let normalError: unknown = null
  try {
    const extractor = new WordExtractor()
    const document = await extractor.extract(Buffer.from(data))
    const content = documentTextSections(document)
    if (content.trim()) {
      return {
        content,
        sourceFormat: 'doc',
        contentFormat: 'plain_text',
        warnings: ['\u65e7\u7248 .doc \u6587\u6863\u5df2\u8f6c\u6362\u4e3a\u7eaf\u6587\u672c\uff0c\u590d\u6742\u8868\u683c\u548c\u6392\u7248\u53ef\u80fd\u65e0\u6cd5\u5b8c\u6574\u4fdd\u7559\u3002']
      }
    }
  } catch (error) {
    normalError = error
  }

  try {
    const document = await extractDocWithoutFormatting(data)
    const content = documentTextSections(document)
    assertHasContent(content, name)
    return {
      content,
      sourceFormat: 'doc',
      contentFormat: 'plain_text',
      warnings: [
        '\u65e7\u7248 .doc \u6587\u6863\u5df2\u6309\u6b63\u6587\u6587\u672c\u517c\u5bb9\u5bfc\u5165\uff0c\u90e8\u5206\u590d\u6742\u6392\u7248\u548c\u683c\u5f0f\u5c5e\u6027\u65e0\u6cd5\u5b8c\u6574\u4fdd\u7559\u3002'
      ]
    }
  } catch (fallbackError) {
    throw wordError(name, normalError ?? fallbackError)
  }
}

export async function convertResourceInput(
  name: string,
  data: Uint8Array,
  encodingHint?: string
): Promise<ConvertedResourceInput> {
  const sourceFormat = getResourceSourceFormat(name)
  if (!sourceFormat) throw new Error('不支持的文件类型，仅支持 .txt / .md / .csv / .doc / .docx')
  if (sourceFormat === 'docx') return convertDocx(name, data)
  if (sourceFormat === 'doc') return convertDoc(name, data)

  const decoded = decodeTextBuffer(data, encodingHint)
  assertTextIntegrity(decoded.info, name)
  assertHasContent(decoded.text, name)
  return {
    content: decoded.text,
    sourceFormat,
    contentFormat: sourceFormat === 'md' ? 'markdown' : 'plain_text',
    warnings: [],
    encoding: decoded.info
  }
}
