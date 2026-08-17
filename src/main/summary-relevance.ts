import type { AppConfig, ChatMeta, ProjectTree } from '@shared/types'
import { readChatSummary, readDocSummary, readResource, readResourceSummary } from './services/file.service'

// ---------------------------------------------------------------------------
// 摘要注入的候选收集、相关度采样、激活键计算。
// 供 api.service（构建注入消息）与 ipc（给渲染层返回默认激活集/搜索）共用，保证两端一致。
// ---------------------------------------------------------------------------

/** 收集该对话当前可注入的候选键（按对话类型与全局注入配置） */
export function collectApplicableKeys(chat: ChatMeta, cfg: AppConfig, tree: ProjectTree | undefined): string[] {
  if (!tree) return []
  const kind = chat.kind
  const inj = cfg.summaryInjection
  const keys: string[] = []

  if (kind === 'doc' && inj.doc.fullText) keys.push('fulltext')

  let docIds: string[] = []
  if (kind === 'project' && inj.project.docSummaries) docIds = tree.docs.map((d) => d.id)
  else if (kind === 'doc' && inj.doc.otherDocSummaries) docIds = tree.docs.filter((d) => d.id !== chat.docId).map((d) => d.id)
  else if (kind === 'context' && inj.context.docSummaries) docIds = tree.docs.map((d) => d.id)
  for (const id of docIds) keys.push(`doc:${id}`)

  let chatIds: string[] = []
  if (kind === 'project' && inj.project.chatSummaries) {
    chatIds = tree.chats.filter((c) => c.id !== chat.id).map((c) => c.id)
  } else if (kind === 'doc' && inj.doc.docChatSummaries) {
    chatIds = tree.chats.filter((c) => c.docId === chat.docId && c.id !== chat.id).map((c) => c.id)
  } else if (kind === 'context' && inj.context.docChatSummaries) {
    chatIds = tree.chats.filter((c) => c.docId === chat.docId && c.id !== chat.id).map((c) => c.id)
  }
  for (const id of chatIds) keys.push(`chat:${id}`)

  const includeRes =
    kind === 'project' ? inj.project.resourceSummaries : kind === 'doc' ? inj.doc.resourceSummaries : inj.context.resourceSummaries
  if (includeRes) for (const r of tree.resources) keys.push(`res:${r.id}`)

  return keys
}

/**
 * 计算激活键：对话开始（首条消息）后以冻结的 active 为准（pending 为已开启但尚未随消息使用的键，同样注入）；
 * 首条消息前：默认注入「相关度采样 + 用户置顶(pending)」键（不再是全部），此后新加入摘要系统的摘要默认关闭，由用户手动开启。
 */
export function computeActiveKeys(chat: ChatMeta, applicable: string[], defaultSelected: Set<string>): Set<string> {
  const frozen = chat.injectionOverrides?.active
  const pending = chat.injectionOverrides?.pending ?? []
  const disabled = chat.injectionOverrides?.disabled ?? []
  const active = new Set<string>()
  for (const k of applicable) {
    if (frozen) {
      if (frozen.includes(k) || pending.includes(k)) active.add(k)
    } else if (defaultSelected.has(k) || pending.includes(k) || k === 'fulltext') {
      if (!disabled.includes(k)) active.add(k)
    }
  }
  return active
}

// ---------------------------------------------------------------------------
// 内容相关度采样：默认注入「最相关 N 条」而非全部，避免上百文档/对话/资源摘要堵塞上下文。
// 相关度 = 实体重叠（角色/别名/关键设定/术语）+ 新鲜度（updatedAt），零 LLM。
// ---------------------------------------------------------------------------

export const RELEVANCE_SAMPLE: Record<'doc' | 'chat' | 'res', number> = { doc: 10, chat: 10, res: 10 }

function summaryKeyKind(k: string): 'doc' | 'chat' | 'res' {
  if (k.startsWith('doc:')) return 'doc'
  if (k.startsWith('chat:')) return 'chat'
  return 'res'
}

/** 从摘要提取实体集合（角色名/别名/关键设定/术语），供相关度打分 */
export function extractSummaryEntities(s: unknown): string[] {
  if (!s || typeof s !== 'object') return []
  const o = s as Record<string, unknown>
  const ents = new Set<string>()
  const chars = Array.isArray(o.characters) ? (o.characters as Record<string, unknown>[]) : []
  for (const c of chars) {
    const name = String(c.name ?? '').trim().toLowerCase()
    if (name) ents.add(name)
    const aliases = Array.isArray(c.aliases) ? (c.aliases as unknown[]).map(String) : []
    for (const a of aliases) {
      const t = a.trim().toLowerCase()
      if (t) ents.add(t)
    }
  }
  const push = (arr: unknown): void => {
    if (Array.isArray(arr)) for (const v of arr) {
      const t = String(v).trim().toLowerCase()
      if (t) ents.add(t)
    }
  }
  push(o.keySettings)
  push(o.keyTerms)
  return [...ents]
}

/** 相关度锚点：文档级/上下文对话取当前文档摘要的实体 */
async function buildAnchorEntities(chat: ChatMeta): Promise<Set<string>> {
  const ids = new Set<string>()
  if ((chat.kind === 'doc' || chat.kind === 'context') && chat.docId) {
    const s = await readDocSummary(chat.projectId, chat.docId)
    for (const e of extractSummaryEntities(s)) ids.add(e)
  }
  return ids
}

/** 从候选键中采样每个类型「最相关 N 条」（fulltext 由注入逻辑单独处理，不在此采样） */
export async function selectDefaultKeys(chat: ChatMeta, applicable: string[]): Promise<Set<string>> {
  const anchor = await buildAnchorEntities(chat)
  const scored: { key: string; kind: 'doc' | 'chat' | 'res'; overlap: number; updatedAt: string }[] = []
  for (const k of applicable) {
    if (k === 'fulltext') continue
    const kind = summaryKeyKind(k)
    const id = k.slice(kind === 'doc' ? 4 : kind === 'chat' ? 5 : 4)
    if (kind === 'res') {
      try {
        if ((await readResource(chat.projectId, id)).encoding.suspicious) continue
      } catch {
        continue
      }
    }
    const s =
      kind === 'doc'
        ? await readDocSummary(chat.projectId, id)
        : kind === 'chat'
          ? await readChatSummary(chat.projectId, id)
          : await readResourceSummary(chat.projectId, id)
    const ents = extractSummaryEntities(s)
    const overlap = anchor.size ? ents.filter((e) => anchor.has(e)).length : 0
    scored.push({ key: k, kind, overlap, updatedAt: s?.updatedAt ?? '' })
  }
  const out = new Set<string>()
  for (const kind of ['doc', 'chat', 'res'] as const) {
    const list = scored
      .filter((x) => x.kind === kind)
      .sort((a, b) => b.overlap - a.overlap || b.updatedAt.localeCompare(a.updatedAt))
    for (const x of list.slice(0, RELEVANCE_SAMPLE[kind])) out.add(x.key)
  }
  return out
}

/** 默认激活集（含 fulltext）：渲染层据此展示默认开启项并在首条消息冻结 */
export async function computeDefaultActive(chat: ChatMeta, tree: ProjectTree | undefined, cfg: AppConfig): Promise<string[]> {
  const applicable = collectApplicableKeys(chat, cfg, tree)
  const selected = await selectDefaultKeys(chat, applicable)
  if (applicable.includes('fulltext')) selected.add('fulltext')
  return [...selected]
}
