import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Crosshair,
  FileText,
  ListFilter,
  MessageSquare,
  Paperclip,
  Send,
  Square
} from 'lucide-react'
import type {
  ChatAttachment,
  ChatMessage,
  ChatMeta,
  ContextRange,
  MemoryContext,
  ProjectSummariesOverview,
  StreamContextRange,
  SummarySearchResult
} from '@shared/types'
import type { Tab } from '../../store/app.store'
import { useAppStore } from '../../store/app.store'
import { useContextStore } from '../../store/context.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { useT } from '../../i18n'
import ContextPanel from './ContextPanel'
import UploadPicker from './UploadPicker'

function toStreamRange(range: ContextRange, docId: string, projectId: string): StreamContextRange {
  return {
    docId,
    projectId,
    before: range.before,
    after: range.after,
    anchor: range.anchor,
    selectionFrom: range.selectionFrom,
    selectionTo: range.selectionTo
  }
}

interface InjectionItem {
  key: string
  label: string
}

export default function ChatPane({ tab }: { tab: Tab }): JSX.Element {
  const t = useT()
  const chatId = tab.refId!
  const [chat, setChat] = useState<ChatMeta | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [range, setRange] = useState<ContextRange | null>(tab.contextRange ?? null)
  const [streaming, setStreaming] = useState<{ requestId: string; acc: string; reasoning: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [regeneratePrompt, setRegeneratePrompt] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [prevAnswer, setPrevAnswer] = useState<{ content: string; reasoning?: string } | null>(null)
  const [injectionsOpen, setInjectionsOpen] = useState(false)
  const [overview, setOverview] = useState<ProjectSummariesOverview | null>(null)
  /** 本次发送实际使用的上下文范围（成功后写入锁定下限） */
  const sentRangeRef = useRef<{ before: number; after: number } | null>(null)
  /** 对话已进行后锁定的最小范围（只能扩大，持久化） */
  const [lockedRange, setLockedRange] = useState<{ before: number; after: number } | null>(null)
  /** 该对话关闭的注入键（持久化到对话 meta） */
  const [disabledInjections, setDisabledInjections] = useState<string[]>([])
  /** 对话开始（首条消息）时冻结的激活注入键；此后新摘要默认关闭 */
  const [activeInjections, setActiveInjections] = useState<string[] | null>(null)
  /** 对话开始后手动开启、尚未随消息使用的键（仍可自由关闭；发送消息后并入 active） */
  const [pendingEnabled, setPendingEnabled] = useState<string[]>([])
  /** 该对话默认激活的注入键（相关度采样结果，首条消息前的“默认开”） */
  const [defaultActive, setDefaultActive] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SummarySearchResult[]>([])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 每次回答的记忆使用情况（透明展示），键 = assistant 消息 id */
  const [memories, setMemories] = useState<Record<string, MemoryContext>>({})
  const newSummaryNotifiedRef = useRef(false)
  const pendingReasonRef = useRef<'context' | 'summary' | 'both' | null>(null)
  const pendingNewlyEnabledRef = useRef<string[]>([])
  const rangeSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const config = useAppStore((s) => s.config)
  const workspace = useAppStore((s) => s.workspace)
  const summaryRevision = useAppStore((s) => s.summaryRevision)
  const setTabContextRange = useAppStore((s) => s.setContextRange)
  const setStreamingChat = useAppStore((s) => s.setStreamingChat)
  const titleGenerating = useAppStore((s) => s.titleGenerating[chatId])

  const docTitle = useMemo(() => {
    if (!chat?.docId) return undefined
    return workspace.projects.flatMap((p) => p.docs).find((d) => d.id === chat.docId)?.title
  }, [workspace, chat?.docId])

  useEffect(() => {
    void api.invoke('chat:get', chatId).then(({ chat, messages }) => {
      setChat(chat)
      setMessages(messages)
      if (chat.contextRange) setRange(chat.contextRange)
      if (chat.lockedRange) setLockedRange(chat.lockedRange)
      setDisabledInjections(chat.injectionOverrides?.disabled ?? [])
      setActiveInjections(chat.injectionOverrides?.active ?? null)
      setPendingEnabled(chat.injectionOverrides?.pending ?? [])
    })
  }, [chatId])

  // 摘要概览（注入开关面板数据）
  useEffect(() => {
    if (!chat?.projectId) return
    void api.invoke('summary:listProject', chat.projectId).then(setOverview).catch(() => {})
  }, [chat?.projectId, summaryRevision])

  // 默认激活集（相关度采样），随摘要变化刷新
  useEffect(() => {
    if (!chat?.id) return
    void api.invoke('summary:defaultActive', chat.id).then(setDefaultActive).catch(() => setDefaultActive([]))
  }, [chat?.id, summaryRevision])

  // 流式订阅
  useEffect(() => {
    const offChunk = api.on('stream:chunk', (p) => {
      if (p.chatId !== chatId) return
      setStreaming((s) =>
        s && s.requestId === p.requestId
          ? { ...s, acc: s.acc + p.delta, reasoning: s.reasoning + (p.reasoningDelta ?? '') }
          : s
      )
    })
    const offDone = api.on('stream:done', (p) => {
      if (p.chatId !== chatId) return
      setStreaming((s) => (s && s.requestId === p.requestId ? null : s))
      if (p.aborted) {
        sentRangeRef.current = null
        pendingReasonRef.current = null
        pendingNewlyEnabledRef.current = []
        return
      }
      if (p.error) {
        setError(p.error)
        sentRangeRef.current = null
        pendingReasonRef.current = null
        pendingNewlyEnabledRef.current = []
        return
      }
      if (p.content) {
        const id = `a-${p.requestId}`
        setMessages((m) => [
          ...m,
          { id, role: 'assistant', content: p.content, createdAt: new Date().toISOString(), reasoning: p.reasoning }
        ])
        if (p.memory) setMemories((prev) => ({ ...prev, [id]: p.memory! }))
        if (sentRangeRef.current) {
          setLockedRange(sentRangeRef.current)
          void api.invoke('chat:patch', { chatId, patch: { lockedRange: sentRangeRef.current } })
          sentRangeRef.current = null
        }
        pendingReasonRef.current = null
        pendingNewlyEnabledRef.current = []
      }
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [chatId])

  // 关闭对话窗口 → 后台生成/更新聊天摘要（PRD 7.5）+ 清理全局流式状态 + 落盘防抖中的范围
  useEffect(() => {
    return () => {
      void api.invoke('summary:queueChat', chatId)
      setStreamingChat(chatId, false)
      if (rangeSaveTimer.current) {
        clearTimeout(rangeSaveTimer.current)
        void api.invoke('chat:patch', { chatId, patch: { contextRange: range ?? undefined } })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, setStreamingChat])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming?.acc])

  // 同步流式状态到全局（供侧栏标题按钮等判断）
  useEffect(() => {
    setStreamingChat(chatId, !!streaming)
  }, [streaming, chatId, setStreamingChat])

  const started = messages.length > 0
  const hasOutput = messages.some((m) => m.role === 'assistant')

  function updateRange(r: ContextRange): void {
    setRange(r)
    setTabContextRange(tab.id, r)
    if (chat?.docId) {
      useContextStore.getState().setHighlight({ docId: chat.docId, ...r })
    }
    // 防抖持久化（避免高频写入触发 EPERM）
    if (rangeSaveTimer.current) clearTimeout(rangeSaveTimer.current)
    rangeSaveTimer.current = setTimeout(() => {
      void api.invoke('chat:patch', { chatId, patch: { contextRange: r } })
    }, 400)
    // 已开始且范围变化 → 提示重新生成（原因：context）
    if (started && hasOutput && lockedRange && (r.before !== lockedRange.before || r.after !== lockedRange.after)) {
      pendingReasonRef.current = pendingReasonRef.current === 'summary' ? 'both' : 'context'
      setRegeneratePrompt(true)
    }
  }

  // 注入开关项
  const injectionItems = useMemo<InjectionItem[]>(() => {
    if (!chat || !overview || !config?.summaryEnabled) return []
    const kind = chat.kind
    const inj = config.summaryInjection
    const items: InjectionItem[] = []

    if (kind === 'doc' && inj.doc.fullText) {
      items.push({ key: 'fulltext', label: t('chat.fulltext') })
    }

    let docIds: string[] = []
    if (kind === 'project' && inj.project.docSummaries) docIds = overview.docs.map((d) => d.docId)
    else if (kind === 'doc' && inj.doc.otherDocSummaries) docIds = overview.docs.filter((d) => d.docId !== chat.docId).map((d) => d.docId)
    else if (kind === 'context' && inj.context.docSummaries) docIds = overview.docs.map((d) => d.docId)
    for (const d of overview.docs) {
      if (!docIds.includes(d.docId) || !d.hasSummary) continue
      items.push({ key: `doc:${d.docId}`, label: t('chat.docSummary', { name: d.title }) })
    }

    let chatIds: string[] = []
    if (kind === 'project' && inj.project.chatSummaries) {
      chatIds = overview.chats.filter((c) => c.chatId !== chat.id).map((c) => c.chatId)
    } else if (kind === 'doc' && inj.doc.docChatSummaries) {
      chatIds = overview.chats.filter((c) => c.docId === chat.docId && c.chatId !== chat.id).map((c) => c.chatId)
    } else if (kind === 'context' && inj.context.docChatSummaries) {
      chatIds = overview.chats.filter((c) => c.docId === chat.docId && c.chatId !== chat.id).map((c) => c.chatId)
    }
    for (const c of overview.chats) {
      if (!chatIds.includes(c.chatId) || !c.hasSummary) continue
      items.push({ key: `chat:${c.chatId}`, label: t('chat.chatSummary', { name: c.title }) })
    }

    const includeRes =
      kind === 'project' ? inj.project.resourceSummaries : kind === 'doc' ? inj.doc.resourceSummaries : inj.context.resourceSummaries
    if (includeRes) {
      for (const r of overview.resources) {
        if (!r.distilled) continue
        items.push({ key: `res:${r.resourceId}`, label: t('chat.resSummary', { name: r.name }) })
      }
    }
    return items
  }, [chat, overview, config, t])

  // 打开对话窗口时检测新加入摘要系统的摘要（进行中对话默认关闭），一次性提示
  useEffect(() => {
    if (!chat || !overview || !started || newSummaryNotifiedRef.current) return
    if (!activeInjections) return
    const newKeys = injectionItems
      .map((i) => i.key)
      .filter((k) => !activeInjections.includes(k) && !disabledInjections.includes(k) && !pendingEnabled.includes(k))
    if (newKeys.length > 0) {
      newSummaryNotifiedRef.current = true
      toast.info(t('chat.newSummaryDetected', { n: newKeys.length }))
    }
  }, [chat, overview, started, activeInjections, disabledInjections, pendingEnabled, injectionItems, t])

  function toggleInjection(key: string): void {
    if (streaming || titleGenerating) return
    if (started) {
      const isActive = activeInjections?.includes(key) ?? false
      const isPending = pendingEnabled.includes(key)
      if (isActive) return // 已随消息使用的摘要：锁定，不能关闭
      if (isPending) {
        // 已开启但尚未随消息使用：仍可自由关闭
        const nextPending = pendingEnabled.filter((k) => k !== key)
        setPendingEnabled(nextPending)
        pendingNewlyEnabledRef.current = pendingNewlyEnabledRef.current.filter((k) => k !== key)
        if (pendingNewlyEnabledRef.current.length === 0) pendingReasonRef.current = null
        void api.invoke('chat:patch', {
          chatId,
          patch: { injectionOverrides: { disabled: disabledInjections, active: activeInjections ?? [], pending: nextPending } }
        })
        return
      }
      // 关闭状态 → 手动开启（进入 pending，发送消息后锁定）
      const nextPending = [...pendingEnabled, key]
      setPendingEnabled(nextPending)
      void api.invoke('chat:patch', {
        chatId,
        patch: { injectionOverrides: { disabled: disabledInjections, active: activeInjections ?? [], pending: nextPending } }
      })
      pendingNewlyEnabledRef.current = [...pendingNewlyEnabledRef.current, key]
      if (hasOutput) {
        pendingReasonRef.current = pendingReasonRef.current === 'context' ? 'both' : 'summary'
        setRegeneratePrompt(true)
      }
    } else {
      // 对话开始前：默认开启项可关（记 disabled）；默认关闭项可开（记 pending）
      const inDefault = defaultActive.includes(key)
      let nextDisabled = disabledInjections
      let nextPending = pendingEnabled
      if (inDefault) {
        const enabled = !disabledInjections.includes(key)
        nextDisabled = enabled ? [...disabledInjections, key] : disabledInjections.filter((k) => k !== key)
        setDisabledInjections(nextDisabled)
      } else {
        const enabled = pendingEnabled.includes(key)
        nextPending = enabled ? pendingEnabled.filter((k) => k !== key) : [...pendingEnabled, key]
        setPendingEnabled(nextPending)
      }
      void api.invoke('chat:patch', { chatId, patch: { injectionOverrides: { disabled: nextDisabled, pending: nextPending } } })
    }
  }

  async function runSearch(q: string): Promise<void> {
    setSearchQuery(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (!q.trim() || !chat?.projectId) {
      setSearchResults([])
      return
    }
    searchTimer.current = setTimeout(async () => {
      try {
        setSearchResults(await api.invoke('summary:search', { projectId: chat.projectId!, query: q }))
      } catch {
        setSearchResults([])
      }
    }, 300)
  }

  /** 附加关联文档（写作文档）到当前对话；与全文注入去重 */
  function attachLinkedDoc(): void {
    if (!chat?.docId) return
    if (attachments.some((a) => a.docId === chat.docId)) return
    const hasFullText = !!config?.summaryEnabled && !!config?.summaryInjection?.doc?.fullText && chat.kind === 'doc'
    if (hasFullText) {
      toast.info(t('chat.docFullTextOn'))
      return
    }
    const title = docTitle ?? chat.docId
    setAttachments((a) => [...a, { docId: chat.docId, name: title }])
  }

  async function send(regenerate = false): Promise<void> {
    if (streaming) return
    if (!regenerate && !input.trim() && attachments.length === 0) return
    const requestId = crypto.randomUUID()
    const userMessageId = crypto.randomUUID()
    if (!regenerate) {
      // 冻结激活键：首条消息 = 默认采样集 ∪ 手动开启(pending) − 手动关闭(disabled)
      if (messages.length === 0) {
        const onKeys = injectionItems
          .filter((i) => (defaultActive.includes(i.key) || pendingEnabled.includes(i.key)) && !disabledInjections.includes(i.key))
          .map((i) => i.key)
        setActiveInjections(onKeys)
        setPendingEnabled([])
        void api.invoke('chat:patch', { chatId, patch: { injectionOverrides: { disabled: disabledInjections, active: onKeys, pending: [] } } })
      } else if (pendingEnabled.length > 0) {
        const nextActive = [...(activeInjections ?? []), ...pendingEnabled]
        setActiveInjections(nextActive)
        setPendingEnabled([])
        void api.invoke('chat:patch', { chatId, patch: { injectionOverrides: { disabled: disabledInjections, active: nextActive, pending: [] } } })
      }
      setMessages((m) => [
        ...m,
        { id: userMessageId, role: 'user', content: input, createdAt: new Date().toISOString(), attachments }
      ])
      setPrevAnswer(null)
    } else {
      // 重新生成同样会“使用”pending 中的摘要 → 锁定
      if (pendingEnabled.length > 0) {
        const nextActive = [...(activeInjections ?? []), ...pendingEnabled]
        setActiveInjections(nextActive)
        setPendingEnabled([])
        void api.invoke('chat:patch', { chatId, patch: { injectionOverrides: { disabled: disabledInjections, active: nextActive, pending: [] } } })
      }
      const lastA = [...messages].reverse().find((m) => m.role === 'assistant')
      if (lastA) setPrevAnswer({ content: lastA.content, reasoning: lastA.reasoning })
    }
    setStreaming({ requestId, acc: '', reasoning: '' })
    setError(null)
    setRegeneratePrompt(false)
    const streamRange = chat?.kind === 'context' && chat.docId && range ? toStreamRange(range, chat.docId, chat.projectId) : undefined
    sentRangeRef.current = streamRange ? { before: streamRange.before, after: streamRange.after } : null
    await api.invoke('api:streamChat', {
      chatId,
      requestId,
      userText: regenerate ? '' : input,
      snapshotIds: regenerate ? undefined : attachments.map((a) => a.snapshotId).filter((x): x is string => !!x),
      docIds: regenerate ? undefined : attachments.map((a) => a.docId).filter((x): x is string => !!x),
      contextRange: streamRange,
      regenerate,
      regenerateReason: regenerate ? pendingReasonRef.current ?? undefined : undefined,
      newlyEnabledSummaries: regenerate && pendingNewlyEnabledRef.current.length ? [...pendingNewlyEnabledRef.current] : undefined,
      userMessageId
    })
    if (!regenerate) {
      setInput('')
      setAttachments([])
    }
  }

  function cancelRegeneratePrompt(): void {
    setRegeneratePrompt(false)
    pendingReasonRef.current = null
    pendingNewlyEnabledRef.current = []
  }

  async function copy(text: string, id?: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    if (id) {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1200)
    }
  }

  const isContext = chat?.kind === 'context'
  const regeneratePromptText =
    pendingReasonRef.current === 'both'
      ? t('chat.bothChanged')
      : pendingReasonRef.current === 'summary'
        ? t('chat.summaryChanged')
        : t('chat.rangeChanged')

  const regenerateBanner = regeneratePrompt && (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}>
      <span className="text-sm">{regeneratePromptText}</span>
      <button className="btn btn-primary !px-2 !py-1" onClick={() => void send(true)}>
        {t('chat.regenerate')}
      </button>
      <button className="btn !px-2 !py-1" onClick={cancelRegeneratePrompt}>
        {t('dialog.cancel')}
      </button>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="text-sm font-medium">{tab.title}</span>
        {chat && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'var(--panel3)', color: 'var(--muted)' }}>
            {chat.kind === 'project' ? <MessageSquare size={11} /> : chat.kind === 'doc' ? <FileText size={11} /> : <Crosshair size={11} />}
            {chat.kind === 'project' ? t('chat.projectChat') : chat.kind === 'doc' ? t('chat.docChat') : t('chat.contextChat')}
          </span>
        )}
        {chat?.action && (
          <span className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            {chat.action === 'diagnose' ? t('sidebar.actionDiagnose') : chat.action === 'plot' ? t('sidebar.actionPlot') : t('sidebar.actionOptimize')}
          </span>
        )}
        {docTitle && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]" style={{ background: 'var(--panel3)', color: 'var(--muted)' }} title={docTitle}>
            <FileText size={11} />
            <span className="max-w-[160px] truncate">{docTitle}</span>
          </span>
        )}
      </div>

      {/* 上下文调控面板固定在窗口顶部，始终可见 */}
      {isContext && chat && chat.docId && range && (
        <div className="space-y-2 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
          <ContextPanel
            docId={chat.docId}
            range={range}
            disabled={!!streaming}
            onChange={updateRange}
            minBefore={lockedRange?.before}
            minAfter={lockedRange?.after}
          />
          {regenerateBanner}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {!isContext && regenerateBanner}

        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className="max-w-[80%] rounded-xl px-3 py-2 text-sm"
              style={{
                background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--panel2)',
                border: '1px solid var(--border)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {m.attachments && m.attachments.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {m.attachments.map((a) => (
                    <span key={a.snapshotId} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--panel3)' }}>
                      <FileText size={11} />
                      {a.name}
                    </span>
                  ))}
                </div>
              )}
              {m.role === 'assistant' && m.reasoning && <ReasoningBlock reasoning={m.reasoning} />}
              {m.content}
              {m.role === 'assistant' && memories[m.id] && <MemoryCard memory={memories[m.id]} />}
              {m.role === 'assistant' && (
                <button
                  className="mt-1.5 flex items-center gap-1 text-xs opacity-60 hover:opacity-100"
                  style={{ color: 'var(--muted)' }}
                  onClick={() => void copy(m.content, m.id)}
                >
                  {copiedId === m.id ? <Check size={12} /> : <Copy size={12} />}
                  {copiedId === m.id ? t('chat.copied') : t('chat.copy')}
                </button>
              )}
            </div>
          </div>
        ))}

        {prevAnswer && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-xl border px-3 py-2 text-sm" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
              <details>
                <summary className="cursor-pointer text-xs" style={{ color: 'var(--muted)' }}>
                  {t('chat.prevAnswer')}
                </summary>
                <div className="mt-1 whitespace-pre-wrap" style={{ color: 'var(--muted)' }}>
                  {prevAnswer.content}
                </div>
              </details>
            </div>
          </div>
        )}

        {streaming && streaming.reasoning && !streaming.acc && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-xl border px-3 py-2 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
              <div className="flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                <Brain size={12} />
                {t('chat.thinking')}
              </div>
              <div className="mt-1 whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--muted)' }}>
                {streaming.reasoning}
                <span className="animate-pulse">▍</span>
              </div>
            </div>
          </div>
        )}
        {streaming && streaming.reasoning && streaming.acc && (
          <div className="flex justify-start">
            <ReasoningBlock reasoning={streaming.reasoning} />
          </div>
        )}

        {streaming && (
          <div className="flex justify-start">
            <div
              className="max-w-[80%] rounded-xl border px-3 py-2 text-sm"
              style={{ background: 'var(--panel2)', borderColor: 'var(--border)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {streaming.acc}
              <span className="animate-pulse">▍</span>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border px-3 py-2 text-sm" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', color: 'var(--danger)' }}>
            {t('chat.callFailed', { error })}
          </div>
        )}
      </div>

      {/* 摘要注入开关面板（输入框上方，可折叠） */}
      {injectionItems.length > 0 && (
        <div className="border-t px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
          <button
            className="flex w-full items-center gap-1 text-xs"
            style={{ color: 'var(--muted)' }}
            onClick={() => setInjectionsOpen((o) => !o)}
          >
            {injectionsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ListFilter size={12} />
            {t('chat.injections')}
            <span className="flex-1" />
            {started && <span className="text-[10px]" style={{ color: 'var(--warn)' }}>{t('chat.injectionLockedHint')}</span>}
          </button>
          {injectionsOpen && (
            <div className="mt-1 space-y-0.5">
              <input
                className="input !py-1 text-xs"
                placeholder={t('chat.searchInjections')}
                value={searchQuery}
                onChange={(e) => void runSearch(e.target.value)}
              />
              {searchResults.length > 0 && (
                <div className="max-h-28 space-y-0.5 overflow-y-auto rounded border p-1" style={{ borderColor: 'var(--border)' }}>
                  {searchResults
                    .filter((r) => injectionItems.some((i) => i.key === r.key))
                    .map((r) => (
                      <div key={r.key} className="flex items-center gap-2 text-xs">
                        <button
                          className="flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-[var(--panel3)]"
                          onClick={() => toggleInjection(r.key)}
                        >
                          <span className="font-medium">{r.title}</span>
                          <span className="ml-1" style={{ color: 'var(--muted)' }}>{r.preview}</span>
                        </button>
                        <span className="shrink-0" style={{ color: 'var(--muted)' }}>
                          {t(r.kind === 'doc' ? 'chat.docSummaryShort' : r.kind === 'chat' ? 'chat.chatSummaryShort' : 'chat.resSummaryShort')}
                        </span>
                      </div>
                    ))}
                </div>
              )}
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {injectionItems.map((item) => {
                  const enabled = started
                    ? (activeInjections?.includes(item.key) ?? false) || pendingEnabled.includes(item.key)
                    : !disabledInjections.includes(item.key) && (defaultActive.includes(item.key) || pendingEnabled.includes(item.key))
                  const locked = started && (activeInjections?.includes(item.key) ?? false)
                  return (
                    <label
                      key={item.key}
                      className="flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-[var(--panel3)]"
                      style={{ opacity: locked || streaming ? 0.6 : 1, cursor: locked || streaming ? 'not-allowed' : 'pointer' }}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={locked || !!streaming || !!titleGenerating}
                        onChange={() => toggleInjection(item.key)}
                      />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <span style={{ color: enabled ? 'var(--ok)' : 'var(--muted)' }}>
                        {enabled ? t('chat.injectionOn') : t('chat.injectionOff')}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {attachments.map((a) => {
              const key = a.snapshotId ?? a.docId ?? a.name
              return (
                <span key={key} className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs" style={{ background: 'var(--panel3)' }}>
                  <FileText size={11} />
                  {a.name}
                  <button
                    className="opacity-60 hover:opacity-100"
                    onClick={() => setAttachments(attachments.filter((x) => (x.snapshotId ?? x.docId ?? x.name) !== key))}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button className="btn !px-2 !py-2" title={t('chat.upload')} onClick={() => setShowUpload(true)}>
            <Paperclip size={16} />
          </button>
          {chat?.docId && (
            <button className="btn !px-2 !py-2" title={t('chat.attachDoc')} onClick={attachLinkedDoc}>
              <FileText size={16} />
            </button>
          )}
          <textarea
            className="input min-h-[40px] flex-1 resize-none"
            rows={1}
            placeholder={titleGenerating ? t('chat.inputLocked') : t('chat.inputPlaceholder')}
            value={input}
            disabled={!!titleGenerating}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {streaming ? (
            <button
              className="btn btn-danger !px-3 !py-2"
              onClick={() => streaming && void api.invoke('api:cancelStream', streaming.requestId)}
            >
              <Square size={15} />
              {t('chat.cancel')}
            </button>
          ) : (
            <button
              className="btn btn-primary !px-3 !py-2"
              onClick={() => void send()}
              disabled={!!titleGenerating || (!input.trim() && attachments.length === 0)}
            >
              <Send size={15} />
              {t('chat.send')}
            </button>
          )}
        </div>
      </div>

      {showUpload && chat && (
        <UploadPicker
          chatId={chatId}
          projectId={chat.projectId}
          onAttached={(r) => setAttachments((a) => [...a, { snapshotId: r.snapshotId, name: r.resource.name }])}
          onClose={() => setShowUpload(false)}
        />
      )}
    </div>
  )
}

function ReasoningBlock({ reasoning }: { reasoning: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const t = useT()
  return (
    <div className="mb-1.5 rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <button
        className="flex w-full items-center gap-1"
        style={{ color: 'var(--muted)' }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        {t('chat.thinking')}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--muted)' }}>
          {reasoning}
        </div>
      )}
    </div>
  )
}

/** “本次记忆”卡：透明展示本次回答使用了哪些摘要/大摘要/向量命中 */
function MemoryCard({ memory }: { memory: MemoryContext }): JSX.Element {
  const [open, setOpen] = useState(true)
  const t = useT()
  const small = memory.small ?? []
  const rollups = memory.rollups ?? []
  const vector = memory.vector ?? []
  const trace = memory.vectorTrace
  const total = small.length + rollups.length + vector.length
  if (total === 0 && !memory.reason && !trace) return <></>

  const line = (item: MemoryContext['small'][number], kind: 'small' | 'rollup' | 'vector'): JSX.Element => (
    <div key={item.key} className="rounded px-1 py-0.5">
      <div className="flex items-start gap-1">
        <span style={{ color: kind === 'rollup' ? 'var(--accent)' : kind === 'vector' ? 'var(--warn)' : 'var(--muted)' }}>
          {kind === 'rollup' ? '◈' : kind === 'vector' ? '▸' : '•'}
        </span>
        <span className="min-w-0 flex-1">{item.title}</span>
        {kind === 'vector' && item.score != null && (
          <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
            {t('chat.vectorScore', { n: item.score.toFixed(3) })}
          </span>
        )}
        {kind === 'vector' && item.source && (
          <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>
            · {t(item.source === 'tool' ? 'chat.vectorTool' : 'chat.vectorAutomatic')}
          </span>
        )}
        {item.reason && kind !== 'vector' && <span className="shrink-0 text-[10px]" style={{ color: 'var(--muted)' }}>· {item.reason}</span>}
      </div>
      {kind === 'vector' && item.preview && (
        <div className="ml-4 mt-0.5 max-h-20 overflow-hidden whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          {item.preview}
        </div>
      )}
    </div>
  )

  let vectorStatus = ''
  if (trace) {
    vectorStatus = trace.outcome === 'hit'
      ? t('chat.vectorHit', { n: trace.hitCount })
      : trace.outcome === 'empty'
        ? t('chat.vectorNoHit')
        : trace.outcome === 'failed'
          ? t('chat.vectorFailed')
          : t('chat.vectorSkipped')
  }

  return (
    <div className="mt-1.5 rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <button className="flex w-full items-center gap-1" style={{ color: 'var(--muted)' }} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ListFilter size={12} />
        {t('chat.memoryCard', { n: total })}
        {memory.reason && <span className="truncate" style={{ color: 'var(--warn)' }}>· {memory.reason}</span>}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {small.length > 0 && (
            <div>
              <div className="mb-0.5 font-medium" style={{ color: 'var(--muted)' }}>{t('chat.memorySummary')}</div>
              {small.map((i) => line(i, 'small'))}
            </div>
          )}
          {rollups.length > 0 && (
            <div>
              <div className="mb-0.5 font-medium" style={{ color: 'var(--accent)' }}>{t('chat.memoryRollups')}</div>
              {rollups.map((i) => line(i, 'rollup'))}
            </div>
          )}
          {(trace || vector.length > 0) && (
            <div>
              <div className="mb-0.5 font-medium" style={{ color: 'var(--warn)' }}>{t('chat.vectorSearch')}</div>
              {trace && (
                <div className="mb-0.5 space-y-0.5 text-[11px]" style={{ color: trace.outcome === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>
                  <div>{t('chat.vectorSearchStatus', { status: vectorStatus })}</div>
                  {trace.attempts && trace.attempts.length > 0 ? trace.attempts.map((attempt, index) => {
                    const status = attempt.outcome === 'hit'
                      ? t('chat.vectorHit', { n: attempt.hitCount })
                      : attempt.outcome === 'failed'
                        ? t('chat.vectorFailed')
                        : t('chat.vectorNoHit')
                    return (
                      <div key={`${attempt.source}:${attempt.query}:${index}`} className="pl-2">
                        {t(attempt.source === 'tool' ? 'chat.vectorTool' : 'chat.vectorAutomatic')}
                        {' · '}{t('chat.vectorQuery', { q: attempt.query })}{' · '}{status}
                      </div>
                    )
                  }) : trace.query ? <div className="pl-2">{t('chat.vectorQuery', { q: trace.query })}</div> : null}
                </div>
              )}
              {vector.map((i) => line(i, 'vector'))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
