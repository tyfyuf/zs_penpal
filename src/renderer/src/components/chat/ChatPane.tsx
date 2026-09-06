import { useEffect, useMemo, useRef, useState, type UIEvent, type WheelEvent } from 'react'
import {
  Brain,
  LoaderCircle,
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
  DocMeta,
  ChatInjectionOverrides,
  ChatMessage,
  ChatMeta,
  ContextRange,
  MemoryContext,
  ProjectSummariesOverview,
  StreamContextRange,
  SummarySearchResult
} from '@shared/types'
import type { SummaryReadinessProgress } from '@shared/summary-job-protocol'
import type { Tab } from '../../store/app.store'
import { useAppStore } from '../../store/app.store'
import { useContextStore } from '../../store/context.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
import { confirmDialog } from '../../store/dialog.store'
import { useT } from '../../i18n'
import ContextPanel from './ContextPanel'
import UploadPicker from './UploadPicker'
import DocumentPicker from './DocumentPicker'

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

interface ChatDraft {
  input: string
  attachments: ChatAttachment[]
}

const CHAT_DRAFTS_KEY = 'penpal:chat-drafts'

function readChatDraft(chatId: string): ChatDraft {
  try {
    const raw = localStorage.getItem(CHAT_DRAFTS_KEY)
    if (!raw) return { input: '', attachments: [] }
    const all = JSON.parse(raw) as Record<string, Partial<ChatDraft>>
    const draft = all[chatId]
    if (!draft || typeof draft.input !== 'string' || !Array.isArray(draft.attachments)) {
      return { input: '', attachments: [] }
    }
    const attachments = draft.attachments.filter((item): item is ChatAttachment =>
      !!item && typeof item === 'object' && typeof item.name === 'string'
    )
    return { input: draft.input, attachments }
  } catch {
    return { input: '', attachments: [] }
  }
}

function writeChatDraft(chatId: string, draft: ChatDraft): void {
  try {
    const raw = localStorage.getItem(CHAT_DRAFTS_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, ChatDraft>) : {}
    if (!draft.input && draft.attachments.length === 0) delete all[chatId]
    else all[chatId] = draft
    localStorage.setItem(CHAT_DRAFTS_KEY, JSON.stringify(all))
  } catch {
    // Draft persistence is best effort and must never affect chat operation.
  }
}

export default function ChatPane({ tab, isActive = true }: { tab: Tab; isActive?: boolean }): JSX.Element {
  const t = useT()
  const chatId = tab.refId!
  const [chat, setChat] = useState<ChatMeta | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const initialDraft = useMemo(() => readChatDraft(chatId), [chatId])
  const [input, setInput] = useState(initialDraft.input)
  const [attachments, setAttachments] = useState<ChatAttachment[]>(initialDraft.attachments)
  const [range, setRange] = useState<ContextRange | null>(tab.contextRange ?? null)
  const [streaming, setStreaming] = useState<{ requestId: string; acc: string; reasoning: string } | null>(null)
  const [summaryReadiness, setSummaryReadiness] = useState<SummaryReadinessProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [showDocumentPicker, setShowDocumentPicker] = useState(false)
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
  /** Dynamic summaries used by the latest answer; UI-only and never persisted into fixed active keys. */
  const [dynamicInjections, setDynamicInjections] = useState<string[]>([])
  /** 对话开始后手动开启、尚未随消息使用的键（仍可自由关闭；发送消息后并入 active） */
  const [pendingEnabled, setPendingEnabled] = useState<string[]>([])
  /** 该对话默认激活的注入键（相关度采样结果，首条消息前的“默认开”） */
  const [defaultActive, setDefaultActive] = useState<string[] | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SummarySearchResult[]>([])
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 每次回答的记忆使用情况（透明展示），键 = assistant 消息 id */
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({})
  const newSummaryNotifiedRef = useRef(false)
  const knownInjectionKeysRef = useRef<Set<string> | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const injectionRecoveryRef = useRef<string | null>(null)
  const pendingReasonRef = useRef<'context' | 'summary' | 'both' | null>(null)
  const pendingNewlyEnabledRef = useRef<string[]>([])
  const rangeSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const expandedReasoningRef = useRef<Record<string, boolean>>({})
  const streamBufferRef = useRef<{ requestId: string; acc: string; reasoning: string } | null>(null)
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followBottomRef = useRef(true)
  const programmaticScrollRef = useRef(false)
  const scrollRafRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  /** A fresh Context chat expands once for range setup; chats with history reopen compact. */
  const [contextPanelDefaultCollapsed, setContextPanelDefaultCollapsed] = useState(true)
  const initialScrollDoneRef = useRef(false)
  const hiddenContentChangedRef = useRef(false)
  /** Tracks active -> inactive transitions because chat panes stay mounted while tabs switch. */
  const wasActiveRef = useRef(isActive)

  const config = useAppStore((s) => s.config)
  const workspace = useAppStore((s) => s.workspace)
  const summaryRevision = useAppStore((s) => s.summaryRevision)
  const setTabContextRange = useAppStore((s) => s.setContextRange)
  const setStreamingChat = useAppStore((s) => s.setStreamingChat)
  const titleGenerating = useAppStore((s) => s.titleGenerating[chatId])
  const isFeatureGuideChat = chat?.system === 'feature-guide'

  const docTitle = useMemo(() => {
    if (!chat?.docId) return undefined
    return workspace.projects.flatMap((p) => p.docs).find((d) => d.id === chat.docId)?.title
  }, [workspace, chat?.docId])

  useEffect(() => {
    let cancelled = false
    injectionRecoveryRef.current = null
    newSummaryNotifiedRef.current = false
    knownInjectionKeysRef.current = null
    activeRequestIdRef.current = null
    setSummaryReadiness(null)
    expandedReasoningRef.current = {}
    setExpandedReasoning({})
    streamBufferRef.current = null
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
    followBottomRef.current = true
    initialScrollDoneRef.current = false
    setHistoryLoaded(false)
    setDynamicInjections([])
    setContextPanelDefaultCollapsed(true)
    void api.invoke('chat:get', chatId).then(({ chat, messages }) => {
      if (cancelled) return
      // Range controls should be visible for a new Context chat, but reopen compact once it has history.
      setContextPanelDefaultCollapsed(messages.length > 0)
      const latestMemory = [...messages].reverse().find((message) => message.role === 'assistant')?.memory
      setDynamicInjections((latestMemory?.small ?? [])
        .map((item) => item.key)
        .filter((key) => key.startsWith('doc:') || key.startsWith('chat:') || key.startsWith('res:') || key === 'fulltext'))
      setChat(chat)
      setMessages(messages)
      if (chat.system === 'feature-guide') {
        // Built-in guide chats own their tutorial context and cannot accept
        // user attachments. Clear a stale draft left before the guide was opened.
        setAttachments([])
        setShowUpload(false)
        setShowDocumentPicker(false)
        writeChatDraft(chatId, { input: initialDraft.input, attachments: [] })
      }
      setHistoryLoaded(true)
      if (chat.contextRange) setRange(chat.contextRange)
      if (chat.lockedRange) setLockedRange(chat.lockedRange)
      setDisabledInjections(chat.injectionOverrides?.disabled ?? [])
      setActiveInjections(chat.injectionOverrides?.active ?? null)
      setPendingEnabled(chat.injectionOverrides?.pending ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [chatId])

  // 摘要概览（注入开关面板数据）
  useEffect(() => {
    if (!chat?.projectId || chat.system === 'feature-guide') {
      setOverview(null)
      return
    }
    void api.invoke('summary:listProject', chat.projectId).then(setOverview).catch(() => {})
  }, [chat?.projectId, chat?.system, summaryRevision])

  // 默认激活集（相关度采样），随摘要变化刷新
  useEffect(() => {
    if (!chat?.id || chat.system === 'feature-guide') {
      setDefaultActive([])
      return
    }
    setDefaultActive(null)
    void api.invoke('summary:defaultActive', chat.id).then(setDefaultActive).catch(() => setDefaultActive([]))
  }, [chat?.id, chat?.system, summaryRevision])

  // 流式订阅
  function setReasoningExpanded(key: string, open: boolean): void {
    expandedReasoningRef.current = { ...expandedReasoningRef.current, [key]: open }
    setExpandedReasoning((current) => ({ ...current, [key]: open }))
  }

  function clearReasoningExpanded(key: string): void {
    delete expandedReasoningRef.current[key]
    setExpandedReasoning((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function flushStreamingBuffer(): void {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current)
      streamFlushTimerRef.current = null
    }
    const buffered = streamBufferRef.current
    if (!buffered) return
    setStreaming((current) => current && current.requestId === buffered.requestId
      ? { ...buffered }
      : current)
  }

  function scheduleStreamingFlush(): void {
    if (streamFlushTimerRef.current) return
    streamFlushTimerRef.current = setTimeout(() => {
      streamFlushTimerRef.current = null
      const buffered = streamBufferRef.current
      if (!buffered) return
      setStreaming((current) => current && current.requestId === buffered.requestId
        ? { ...buffered }
        : current)
    }, 45)
  }

  // Stream chunks are merged in a ref and committed to React in small batches.
  useEffect(() => {
    const offChunk = api.on('stream:chunk', (p) => {
      if (p.chatId !== chatId || p.requestId !== activeRequestIdRef.current) return
      const buffered = streamBufferRef.current
      if (!buffered || buffered.requestId !== p.requestId) return
      buffered.acc += p.delta
      buffered.reasoning += p.reasoningDelta ?? ''
      scheduleStreamingFlush()
    })
    const offDone = api.on('stream:done', (p) => {
      if (p.chatId !== chatId || p.requestId !== activeRequestIdRef.current) return
      flushStreamingBuffer()
      streamBufferRef.current = null
      setStreaming((s) => (s && s.requestId === p.requestId ? null : s))
      const streamReasoningKey = `stream:${p.requestId}`
      const wasExpanded = !!expandedReasoningRef.current[streamReasoningKey]
      clearReasoningExpanded(streamReasoningKey)
      if (p.aborted) {
        activeRequestIdRef.current = null
        setSummaryReadiness(null)
        sentRangeRef.current = null
        pendingReasonRef.current = null
        pendingNewlyEnabledRef.current = []
        return
      }
      if (p.error) {
        setError(p.error)
        activeRequestIdRef.current = null
        setSummaryReadiness((current) => current?.phase === 'failed' && current.requestId === p.requestId ? current : null)
        sentRangeRef.current = null
        pendingReasonRef.current = null
        pendingNewlyEnabledRef.current = []
        return
      }
      activeRequestIdRef.current = null
      setSummaryReadiness(null)
      if (p.memory) {
        setDynamicInjections((p.memory.small ?? [])
          .map((item) => item.key)
          .filter((key) => key.startsWith('doc:') || key.startsWith('chat:') || key.startsWith('res:') || key === 'fulltext'))
      }
      if (p.content) {
        const id = p.messageId ?? `a-${p.requestId}`
        const message: ChatMessage = {
          id,
          role: 'assistant',
          content: p.content,
          createdAt: new Date().toISOString(),
          reasoning: p.reasoning,
          memory: p.memory
        }
        setMessages((current) => {
          if (p.regenerated) {
            const index = p.messageId
              ? current.findIndex((item) => item.id === p.messageId)
              : [...current].map((item) => item.role).lastIndexOf('assistant')
            if (index >= 0) {
              const next = [...current]
              next[index] = { ...current[index], ...message, regenerated: true }
              return next
            }
          }
          return [...current, message]
        })
        if (wasExpanded) setReasoningExpanded(id, true)
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
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current)
        streamFlushTimerRef.current = null
      }
      streamBufferRef.current = null
    }
  }, [chatId])

  // Chat panes remain mounted in AppLayout, so unmount cleanup alone does not run when the user leaves a chat.
  // Queue the same incremental/missing-summary check on every active -> inactive transition instead.
  useEffect(() => {
    const wasActive = wasActiveRef.current
    wasActiveRef.current = isActive
    if (wasActive && !isActive) {
      void api.invoke('summary:queueChat', chatId).catch(() => {})
    }
  }, [chatId, isActive])

  useEffect(() => {
    return () => {
      // Unmount remains the fallback for closing a chat tab or leaving the app.
      const requestId = activeRequestIdRef.current
      activeRequestIdRef.current = null
      if (requestId) void api.invoke('api:cancelStream', requestId).catch(() => {})
      void api.invoke('summary:queueChat', chatId).catch(() => {})
      setStreamingChat(chatId, false)
      if (rangeSaveTimer.current) {
        clearTimeout(rangeSaveTimer.current)
        void api.invoke('chat:patch', { chatId, patch: { contextRange: range ?? undefined } })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, setStreamingChat])

  function isNearConversationBottom(element: HTMLDivElement): boolean {
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    return distanceFromBottom <= 40
  }

  function scheduleScrollToBottom(force = false): void {
    if (force) {
      followBottomRef.current = true
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
    if (!force && !followBottomRef.current) return
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      const element = scrollRef.current
      if (!element || (!force && !followBottomRef.current)) return

      // Mark the write so the synthetic scroll event caused by this assignment
      // cannot be mistaken for the user scrolling away from the bottom.
      programmaticScrollRef.current = true
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    })
  }

  function handleConversationScroll(event: UIEvent<HTMLDivElement>): void {
    const element = scrollRef.current
    if (!element) return
    // Chromium reports programmatic scroll events as untrusted. Keep the
    // current follow state for those events; trusted events are user input.
    if (programmaticScrollRef.current && !event.nativeEvent.isTrusted) return
    followBottomRef.current = isNearConversationBottom(element)
  }

  function handleConversationWheel(event: WheelEvent<HTMLDivElement>): void {
    const element = scrollRef.current
    if (!element) return
    // Capture upward wheel intent immediately, before the following scroll
    // event arrives, so a pending animation frame cannot pull the view back.
    if (event.deltaY < 0) {
      followBottomRef.current = false
    } else if (event.deltaY > 0 && isNearConversationBottom(element)) {
      followBottomRef.current = true
    }
  }

  useEffect(() => {
    if (!isActive) hiddenContentChangedRef.current = true
    scheduleScrollToBottom()
  }, [messages, streaming?.acc, streaming?.reasoning, isActive])

  // History is loaded asynchronously and inactive chat panes are kept mounted.
  // Wait until the pane is visible and the browser has laid out the message
  // list before forcing the initial position to the last message.
  useEffect(() => {
    if (!isActive || !historyLoaded || initialScrollDoneRef.current) return
    let raf1: number | null = null
    let raf2: number | null = null
    let raf3: number | null = null
    raf1 = requestAnimationFrame(() => {
      scheduleScrollToBottom(true)
      raf2 = requestAnimationFrame(() => {
        scheduleScrollToBottom(true)
        raf3 = requestAnimationFrame(() => {
          scheduleScrollToBottom(true)
          initialScrollDoneRef.current = true
        })
      })
    })
    return () => {
      if (raf1 !== null) cancelAnimationFrame(raf1)
      if (raf2 !== null) cancelAnimationFrame(raf2)
      if (raf3 !== null) cancelAnimationFrame(raf3)
    }
  }, [historyLoaded, isActive, messages.length, chatId])

  // Re-anchor after returning from another tab so content streamed while
  // hidden is immediately visible. User scrolls remain respected afterwards.
  useEffect(() => {
    if (!isActive || !historyLoaded) return
    if (!initialScrollDoneRef.current || !hiddenContentChangedRef.current) return
    hiddenContentChangedRef.current = false
    scheduleScrollToBottom(true)
  }, [isActive, historyLoaded])

  // Streaming text, reasoning expansion, memory cards and late font/layout
  // changes can all alter the content height without changing scroll state.
  // Observe the inner content so follow mode remains at the bottom in each of
  // those cases, while a user who has scrolled up remains undisturbed.
  useEffect(() => {
    const content = scrollContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!isActive) hiddenContentChangedRef.current = true
      scheduleScrollToBottom()
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [chatId, isActive])

  useEffect(() => () => {
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
  }, [])

  // 同步流式状态到全局（供侧栏标题按钮等判断）
  // Drafts stay local to this renderer and never enter chat history, logs, or model requests.
  useEffect(() => {
    writeChatDraft(chatId, { input, attachments })
  }, [chatId, input, attachments])

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
    if (!chat || chat.system === 'feature-guide' || !overview || !config?.summaryEnabled) return []
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

  // The main list only shows active entries; inactive entries remain searchable for manual activation.
  const visibleInjectionItems = useMemo(() => {
    return injectionItems.filter((item) => {
      if (started) {
        return (activeInjections?.includes(item.key) ?? false)
          || pendingEnabled.includes(item.key)
          || dynamicInjections.includes(item.key)
      }
      return !disabledInjections.includes(item.key)
        && ((defaultActive?.includes(item.key) ?? false) || pendingEnabled.includes(item.key))
    })
  }, [injectionItems, started, activeInjections, pendingEnabled, dynamicInjections, disabledInjections, defaultActive])

  // Repair legacy/corrupted started chats whose first-message freeze was lost.
  // `active: []` is valid; only an absent `active` field violates the state-machine invariant.
  useEffect(() => {
    if (!chat || !overview || !config?.summaryEnabled || defaultActive === null) return
    if (messages.length === 0 || activeInjections !== null || chat.injectionOverrides?.active !== undefined) return
    if (injectionRecoveryRef.current === chat.id) return

    const disabled = chat.injectionOverrides?.disabled ?? disabledInjections
    const pending = chat.injectionOverrides?.pending ?? pendingEnabled
    const available = new Set(injectionItems.map((item) => item.key))
    const recovered = [...new Set([...defaultActive, ...pending])]
      .filter((key) => available.has(key) && !disabled.includes(key))

    injectionRecoveryRef.current = chat.id
    setActiveInjections(recovered)
    setPendingEnabled([])
    void persistInjectionOverrides({ disabled, active: recovered, pending: [] }).then((ok) => {
      if (ok) return
      setActiveInjections(null)
      setPendingEnabled(pending)
    })
  }, [chat, overview, config?.summaryEnabled, defaultActive, messages.length, activeInjections, disabledInjections, pendingEnabled, injectionItems])


  // Request-scoped summary readiness events are isolated by chat and request id.
  useEffect(() => {
    const off = api.on('summary:readiness', (progress) => {
      if (progress.chatId !== chatId || progress.requestId !== activeRequestIdRef.current) return
      if (progress.phase === 'ready') {
        setSummaryReadiness(null)
      } else {
        setSummaryReadiness(progress)
      }
    })
    return off
  }, [chatId])

  // Establish the injection baseline only after chat initialization is complete.
  useEffect(() => {
    if (!chat || !overview || !historyLoaded || !config?.summaryEnabled) return
    if (started && activeInjections === null) return
    if (!started && defaultActive === null) return

    const currentKeys = new Set(injectionItems.map((item) => item.key))
    if (knownInjectionKeysRef.current === null) {
      knownInjectionKeysRef.current = currentKeys
      return
    }

    const newKeys = [...currentKeys].filter((key) =>
      !knownInjectionKeysRef.current!.has(key)
      && !disabledInjections.includes(key)
      && !pendingEnabled.includes(key)
    )
    knownInjectionKeysRef.current = currentKeys
    if (newKeys.length > 0 && !newSummaryNotifiedRef.current) {
      newSummaryNotifiedRef.current = true
      toast.info(t('chat.newSummaryDetected', { n: newKeys.length }))
    }
  }, [chat, overview, historyLoaded, config?.summaryEnabled, started, activeInjections, defaultActive, disabledInjections, pendingEnabled, injectionItems, t])

  function isInjectionEnabled(key: string): boolean {
    if (started) {
      return (activeInjections?.includes(key) ?? false)
        || pendingEnabled.includes(key)
        || dynamicInjections.includes(key)
    }
    return !disabledInjections.includes(key)
      && ((defaultActive?.includes(key) ?? false) || pendingEnabled.includes(key))
  }

  function toggleInjection(key: string): boolean {
    if (streaming || titleGenerating) return false
    if (started) {
      const isActive = (activeInjections?.includes(key) ?? false) || dynamicInjections.includes(key)
      const isPending = pendingEnabled.includes(key)
      if (isActive) return false // 已随消息使用的摘要：锁定，不能关闭
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
        return true
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
      return true
    } else {
      // 对话开始前：默认开启项可关（记 disabled）；默认关闭项可开（记 pending）
      const inDefault = defaultActive?.includes(key) ?? false
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
      return true
    }
  }

  function clearInjectionSearch(): void {
    if (searchTimer.current) {
      clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
    setSearchQuery('')
    setSearchResults([])
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

  function attachDocument(doc: DocMeta): void {
    if (attachments.some((attachment) => attachment.docId === doc.id)) {
      toast.info(t('chat.docAlreadyAttached'))
      return
    }
    setAttachments((current) => [...current, { docId: doc.id, kind: 'project_document', name: doc.title }])
  }

  function isLinkedFullTextEnabled(): boolean {
    if (!config?.summaryEnabled || !config.summaryInjection.doc.fullText) return false
    if (started) return activeInjections?.includes('fulltext') === true || pendingEnabled.includes('fulltext')
    return !disabledInjections.includes('fulltext') && ((defaultActive?.includes('fulltext') ?? false) || pendingEnabled.includes('fulltext'))
  }

  async function expandContextToFullDocument(): Promise<void> {
    if (!chat?.docId || chat.kind !== 'context') return
    if (!(await confirmDialog(t('chat.contextFullTextConfirm')))) return
    try {
      const { content } = await api.invoke('doc:read', chat.docId)
      const current = range ?? { before: 0, after: 0, anchor: 0, hasSelection: false }
      const hasSelection = current.selectionFrom !== undefined && current.selectionTo !== undefined && current.selectionTo > current.selectionFrom
      const anchor = Math.min(content.length, Math.max(0, current.anchor))
      const selectionFrom = hasSelection ? Math.min(content.length, Math.max(0, current.selectionFrom!)) : undefined
      const selectionTo = hasSelection ? Math.min(content.length, Math.max(selectionFrom!, current.selectionTo!)) : undefined
      const coreStart = selectionFrom !== undefined ? selectionFrom : anchor
      const coreEnd = selectionTo !== undefined ? selectionTo : anchor
      const fullRange: ContextRange = {
        before: coreStart,
        after: Math.max(0, content.length - coreEnd),
        anchor,
        hasSelection: selectionFrom !== undefined && selectionTo !== undefined && selectionTo > selectionFrom,
        ...(selectionFrom !== undefined ? { selectionFrom } : {}),
        ...(selectionTo !== undefined ? { selectionTo } : {})
      }
      const fullLock = { before: fullRange.before, after: fullRange.after }
      setRange(fullRange)
      setTabContextRange(tab.id, fullRange)
      setLockedRange(fullLock)
      useContextStore.getState().setHighlight({ docId: chat.docId, ...fullRange })
      if (rangeSaveTimer.current) clearTimeout(rangeSaveTimer.current)
      await api.invoke('chat:patch', { chatId, patch: { contextRange: fullRange, lockedRange: fullLock } })
      if (started && hasOutput && (current.before !== fullRange.before || current.after !== fullRange.after)) {
        pendingReasonRef.current = pendingReasonRef.current === 'summary' ? 'both' : 'context'
        setRegeneratePrompt(true)
      }
      toast.info(t('chat.contextFullTextEnabled'))
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleSelectedDocument(doc: DocMeta): Promise<void> {
    setShowDocumentPicker(false)
    if (!chat) return
    if (chat.kind === 'doc' && chat.docId === doc.id) {
      if (isLinkedFullTextEnabled()) {
        toast.info(t('chat.docFullTextOn'))
      } else if (injectionItems.some((item) => item.key === 'fulltext')) {
        toggleInjection('fulltext')
      } else {
        attachDocument(doc)
      }
      return
    }
    if (chat.kind === 'context' && chat.docId === doc.id) {
      await expandContextToFullDocument()
      return
    }
    attachDocument(doc)
  }

  async function persistInjectionOverrides(overrides: ChatInjectionOverrides): Promise<boolean> {
    try {
      const updated = await api.invoke('chat:patch', { chatId, patch: { injectionOverrides: overrides } })
      setChat(updated)
      return true
    } catch (err) {
      setError((err as Error).message)
      return false
    }
  }

  async function send(regenerate = false): Promise<void> {
    if (streaming) return
    if (!regenerate && !input.trim() && attachments.length === 0) return
    if (!isFeatureGuideChat && config?.summaryEnabled && ((messages.length === 0 && defaultActive === null) || (messages.length > 0 && activeInjections === null))) {
      setError(t('chat.injectionsLoading'))
      return
    }

    const requestId = crypto.randomUUID()
    const userMessageId = crypto.randomUUID()
    if (!regenerate) {
      // Persist the frozen injection state before appending the first user message.
      // Otherwise appendMessage can race with chat:patch and restore an older meta snapshot.
      if (messages.length === 0 && !isFeatureGuideChat) {
        const onKeys = injectionItems
          .filter((item) => ((defaultActive?.includes(item.key) ?? false) || pendingEnabled.includes(item.key)) && !disabledInjections.includes(item.key))
          .map((item) => item.key)
        const persisted = await persistInjectionOverrides({ disabled: disabledInjections, active: onKeys, pending: [] })
        if (!persisted) return
        setActiveInjections(onKeys)
        setPendingEnabled([])
      } else if (!isFeatureGuideChat && pendingEnabled.length > 0) {
        const nextActive = [...new Set([...(activeInjections ?? []), ...pendingEnabled])]
        const persisted = await persistInjectionOverrides({ disabled: disabledInjections, active: nextActive, pending: [] })
        if (!persisted) return
        setActiveInjections(nextActive)
        setPendingEnabled([])
      }
      setMessages((current) => [
        ...current,
        { id: userMessageId, role: 'user', content: input, createdAt: new Date().toISOString(), attachments: isFeatureGuideChat ? [] : attachments }
      ])
      setPrevAnswer(null)
    } else {
      // Regeneration also consumes pending summaries, so persist them before starting the request.
      if (!isFeatureGuideChat && pendingEnabled.length > 0) {
        const nextActive = [...new Set([...(activeInjections ?? []), ...pendingEnabled])]
        const persisted = await persistInjectionOverrides({ disabled: disabledInjections, active: nextActive, pending: [] })
        if (!persisted) return
        setActiveInjections(nextActive)
        setPendingEnabled([])
      }
      const lastA = [...messages].reverse().find((message) => message.role === 'assistant')
      if (lastA) setPrevAnswer({ content: lastA.content, reasoning: lastA.reasoning })
    }
    activeRequestIdRef.current = requestId
    setSummaryReadiness(null)
    followBottomRef.current = true
    scheduleScrollToBottom(true)
    streamBufferRef.current = { requestId, acc: '', reasoning: '' }
    setReasoningExpanded(`stream:${requestId}`, false)
    setStreaming({ requestId, acc: '', reasoning: '' })
    setError(null)
    setRegeneratePrompt(false)
    const streamRange = chat?.kind === 'context' && chat.docId && range ? toStreamRange(range, chat.docId, chat.projectId) : undefined
    sentRangeRef.current = streamRange ? { before: streamRange.before, after: streamRange.after } : null
    await api.invoke('api:streamChat', {
      chatId,
      requestId,
      userText: regenerate ? '' : input,
      snapshotIds: regenerate || isFeatureGuideChat ? undefined : attachments.map((attachment) => attachment.snapshotId).filter((id): id is string => !!id),
      docIds: regenerate || isFeatureGuideChat ? undefined : attachments.map((attachment) => attachment.docId).filter((id): id is string => !!id),
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
        <div className="context-panel-shell border-b" style={{ borderColor: 'var(--border)' }}>
          <ContextPanel
            key={chat.id}
            docId={chat.docId}
            range={range}
            disabled={!!streaming}
            defaultCollapsed={contextPanelDefaultCollapsed}
            onChange={updateRange}
            minBefore={lockedRange?.before}
            minAfter={lockedRange?.after}
          />
          {regenerateBanner && <div className="context-panel-shell__regenerate">{regenerateBanner}</div>}
        </div>
      )}

      <div ref={scrollRef} onScroll={handleConversationScroll} onWheel={handleConversationWheel} className="min-h-0 flex-1 overflow-y-auto p-4">
        <div ref={scrollContentRef} className="space-y-3">
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
              {m.attachments && m.attachments.length > 0 && !isFeatureGuideChat && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {m.attachments.map((a) => (
                    <span key={a.snapshotId} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--panel3)' }}>
                      <FileText size={11} />
                      {a.name}
                    </span>
                  ))}
                </div>
              )}
              {m.role === 'assistant' && m.reasoning && (
                <ReasoningBlock
                  reasoning={m.reasoning}
                  expanded={!!expandedReasoning[m.id]}
                  onExpandedChange={(open) => setReasoningExpanded(m.id, open)}
                />
              )}
              {m.content}
              {m.role === 'assistant' && m.memory && <MemoryCard memory={m.memory} hideVector={isFeatureGuideChat} />}
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

        {summaryReadiness && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-xl border px-3 py-2 text-sm" style={{ background: 'var(--panel)', borderColor: summaryReadiness.phase === 'failed' ? 'var(--danger)' : 'var(--border)' }}>
              <div className="flex items-center gap-2" style={{ color: summaryReadiness.phase === 'failed' ? 'var(--danger)' : 'var(--muted)' }}>
                <LoaderCircle size={13} className={summaryReadiness.phase === 'failed' ? undefined : 'animate-spin'} />
                <span>
                  {summaryReadiness.phase === 'checking'
                    ? t('chat.summaryChecking')
                    : summaryReadiness.phase === 'failed'
                      ? t('chat.summaryPreparingFailed', { error: summaryReadiness.error ?? t('chat.summaryPreparing') })
                      : summaryReadiness.total > 0
                        ? t('chat.summaryPreparingProgress', { completed: summaryReadiness.completed, total: summaryReadiness.total })
                        : t('chat.summaryPreparing')}
                </span>
              </div>
              {summaryReadiness.phase === 'generating' && summaryReadiness.total > 0 && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--panel3)' }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, (summaryReadiness.completed / summaryReadiness.total) * 100)}%`, background: 'var(--accent)' }} />
                </div>
              )}
              {summaryReadiness.currentTitle && summaryReadiness.phase === 'generating' && (
                <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>{summaryReadiness.currentTitle}</div>
              )}
            </div>
          </div>
        )}

        {streaming && (
          <div className="flex justify-start">
            <div
              className="max-w-[80%] rounded-xl border px-3 py-2 text-sm"
              style={{ background: 'var(--panel2)', borderColor: 'var(--border)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
            >
              {streaming.reasoning && (
                <ReasoningBlock
                  reasoning={streaming.reasoning}
                  streaming
                  expanded={!!expandedReasoning[`stream:${streaming.requestId}`]}
                  onExpandedChange={(open) => setReasoningExpanded(`stream:${streaming.requestId}`, open)}
                />
              )}
              {streaming.acc ? <>{streaming.acc}<span className="animate-pulse">{'\u258d'}</span></> : !streaming.reasoning && <span className="animate-pulse">{'\u258d'}</span>}
            </div>
          </div>
        )}

        {error && summaryReadiness?.phase !== 'failed' && (
          <div className="rounded-lg border px-3 py-2 text-sm" style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', color: 'var(--danger)' }}>
            {t('chat.callFailed', { error })}
          </div>
        )}
        </div>
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
                          onClick={() => {
                            if (!isInjectionEnabled(r.key) && toggleInjection(r.key)) clearInjectionSearch()
                          }}
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
                {visibleInjectionItems.map((item) => {
                  const enabled = started
                    ? (activeInjections?.includes(item.key) ?? false) || pendingEnabled.includes(item.key) || dynamicInjections.includes(item.key)
                    : !disabledInjections.includes(item.key) && ((defaultActive?.includes(item.key) ?? false) || pendingEnabled.includes(item.key))
                  const locked = started && ((activeInjections?.includes(item.key) ?? false) || dynamicInjections.includes(item.key))
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
        {attachments.length > 0 && !isFeatureGuideChat && (
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
          {!isFeatureGuideChat && (
            <>
              <button className="btn !px-2 !py-2" title={t('chat.upload')} onClick={() => setShowUpload(true)}>
                <Paperclip size={16} />
              </button>
              <button className="btn !px-2 !py-2" title={t('chat.attachDoc')} onClick={() => setShowDocumentPicker(true)}>
                <FileText size={16} />
              </button>
            </>
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

      {showUpload && chat && !isFeatureGuideChat && (
        <UploadPicker
          chatId={chatId}
          projectId={chat.projectId}
          onAttached={(r) => setAttachments((a) => a.some((x) => x.snapshotId === r.snapshotId) ? a : [...a, { snapshotId: r.snapshotId, kind: 'resource', name: r.resource.name }])}
          onClose={() => setShowUpload(false)}
        />
      )}
      {showDocumentPicker && chat && !isFeatureGuideChat && (
        <DocumentPicker
          projectId={chat.projectId}
          onSelect={(doc) => void handleSelectedDocument(doc)}
          onClose={() => setShowDocumentPicker(false)}
        />
      )}
    </div>
  )
}

function ReasoningBlock({
  reasoning,
  streaming = false,
  expanded = false,
  onExpandedChange
}: {
  reasoning: string
  streaming?: boolean
  expanded?: boolean
  onExpandedChange?: (open: boolean) => void
}): JSX.Element {
  const t = useT()
  const lines = reasoning.split(/\r?\n/).filter((line) => line.trim())
  const preview = lines.length > 0 ? lines[lines.length - 1] : ''
  const toggle = (): void => onExpandedChange?.(!expanded)
  return (
    <div className="mb-1.5 rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
      <button
        className="flex w-full items-center gap-1"
        style={{ color: 'var(--muted)' }}
        onClick={toggle}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        {t('chat.thinking')}
      </button>
      <div
        className="mt-1 whitespace-pre-wrap leading-relaxed"
        style={{
          color: 'var(--muted)',
          ...(expanded ? {} : { maxHeight: '2.8em', overflow: 'hidden' })
        }}
      >
        {expanded ? reasoning : preview}
        {streaming && <span className="animate-pulse">{'\u258d'}</span>}
      </div>
    </div>
  )
}

/** “本次记忆”卡：透明展示本次回答使用了哪些摘要/大摘要/向量命中 */
function MemoryCard({ memory, hideVector = false }: { memory: MemoryContext; hideVector?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const t = useT()
  const small = memory.small ?? []
  const rollups = memory.rollups ?? []
  const vector = hideVector ? [] : (memory.vector ?? [])
  const trace = hideVector ? undefined : memory.vectorTrace
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
