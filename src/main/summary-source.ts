import { createHash } from 'crypto'
import type { SummarySourceInfo } from '@shared/types'

// ---------------------------------------------------------------------------
// 摘要源指纹工具：替代「内嵌全文快照」的存储与失效检测。
// - 指纹 = 规范化（去空白/标点，仅保留 CJK/字母/数字）后的 sha256，
//   排版差异（空行、全半角标点、加粗符号等）不触发失效。
// - 失效判定：指纹变化 且（原始长度变化 > 30% 或 规范化长度差 > 100 字符）。
//   这是「惰性检测 + 黄标」的信号源，非精确 diff；极小改动不打扰用户。
// ---------------------------------------------------------------------------

export const SUMMARY_SCHEMA_VERSION = 2

/** 规范化：去掉空白与各类标点/符号，仅保留 CJK 与字母数字 */
export function normalizeForFingerprint(content: string): string {
  return content.replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function fingerprintOf(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

export function computeSourceInfo(content: string): SummarySourceInfo {
  const normalized = normalizeForFingerprint(content)
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    sourceFingerprint: fingerprintOf(normalized),
    sourceLength: content.length,
    sourceNormalizedLength: normalized.length
  }
}

/** 判断源内容相对摘要生成时是否「显著变化」（STALE）。无指纹（旧数据）视为新鲜。 */
export function isSourceStale(info: SummarySourceInfo, current: string): boolean {
  if (!info.sourceFingerprint) return false
  const normalized = normalizeForFingerprint(current)
  if (fingerprintOf(normalized) === info.sourceFingerprint) return false
  const prevLen = info.sourceLength ?? current.length
  const lenRatio = Math.abs(current.length - prevLen) / Math.max(prevLen, 1)
  const normDelta = Math.abs(normalized.length - (info.sourceNormalizedLength ?? normalized.length))
  return lenRatio > 0.3 || normDelta > 100
}
