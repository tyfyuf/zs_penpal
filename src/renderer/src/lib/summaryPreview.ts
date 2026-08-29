import type { ChatSummary, DocSummary, ResourceSummary } from '@shared/types'

export function storyText(s: {
  overview: string
  characters: { name: string; aliases: string[]; role: string; goal: string }[]
  plot: { id: string; function: string; summary: string }[]
  keySettings: string[]
  keyQuotes: string[]
}): string {
  const chars = (Array.isArray(s.characters) ? s.characters : [])
    .map((c) => `- ${c.name}${c.aliases?.length ? `\uff08${c.aliases.join('\u3001')}\uff09` : ''}\uff1a${c.role}${c.goal ? ` \u00b7 \u76ee\u6807\uff1a${c.goal}` : ''}`)
    .join('\n')
  const plot = (Array.isArray(s.plot) ? s.plot : []).map((p) => `- ${p.id}\uff5c${p.function}\uff1a${p.summary}`).join('\n')
  const settings = Array.isArray(s.keySettings) ? s.keySettings : []
  const quotes = Array.isArray(s.keyQuotes) ? s.keyQuotes : []
  const none = '\uff08\u65e0\uff09'
  return `\u603b\u89c8\uff1a${s.overview || none}\n\n\u4eba\u7269\uff1a\n${chars || none}\n\n\u60c5\u8282\u94fe\uff1a\n${plot || none}\n\n\u5173\u952e\u8bbe\u5b9a\uff1a${settings.join('\u3001') || none}\n\u5173\u952e\u53f0\u8bcd\uff1a${quotes.join(' / ') || none}`
}

export function chatText(s: ChatSummary): string {
  const compacted = Array.isArray(s.compacted) ? s.compacted.map((iv) => `- ${iv.summary}`).join('\n') : ''
  const items = (Array.isArray(s.items) ? s.items : []).map((i) => `${i.role === 'user' ? '用户' : 'AI'}：${i.summary}`).join('\n')
  const parts: string[] = []
  if (compacted) parts.push(`历史（已压缩）：\n${compacted}`)
  if (items) parts.push(`最近：\n${items}`)
  return parts.join('\n\n') || '（无）'
}

export function resourceText(s: ResourceSummary): string {
  if (s.type === 'story') return storyText(s)
  if (s.type === 'setting') {
    const list = (items: string[]): string => items.map((item) => `- ${item}`).join('\n') || '（无）'
    const entries = s.entries.map((entry) => `- ${entry.name} [${entry.category}]：${entry.description}`).join('\n') || '（无）'
    const terms = s.terms.map((term) => `- ${term.term}：${term.definition}`).join('\n') || '（无）'
    return `设定概览：${s.overview || '（无）'}

覆盖范围：${s.scope || '（无）'}

实体：
${entries}

术语：
${terms}

规则：
${list(s.rules)}

关系：
${list(s.relationships)}

时间线：
${list(s.timeline)}

约束：
${list(s.constraints)}`
  }
  return `类型：${s.docType || '其他'}

概述：${s.overview || '（无）'}

核心要点：
${s.keyPoints.map((point) => `- ${point}`).join('\n') || '（无）'}

关键术语：${s.keyTerms.join('、') || '（无）'}

结构：${s.structure || '（无）'}`
}

export function summaryText(s: DocSummary | ChatSummary | ResourceSummary, kind: 'doc' | 'chat' | 'resource'): string {
  if (kind === 'doc') return storyText(s as DocSummary)
  if (kind === 'chat') return chatText(s as ChatSummary)
  return resourceText(s as ResourceSummary)
}
