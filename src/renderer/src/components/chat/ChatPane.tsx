import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FileText, Paperclip, Send, Square } from 'lucide-react'
import type { ChatAttachment, ChatMessage, ChatMeta, ContextRange, StreamContextRange } from '@shared/types'
import type { Tab } from '../../store/app.store'
import { useAppStore } from '../../store/app.store'
import { useContextStore } from '../../store/context.store'
import { api } from '../../lib/api'
import { toast } from '../../store/toast.store'
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

export default function ChatPane({ tab }: { tab: Tab }): JSX.Element {
  const chatId = tab.refId!
  const [chat, setChat] = useState<ChatMeta | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [range, setRange] = useState<ContextRange | null>(tab.contextRange ?? null)
  const [streaming, setStreaming] = useState<{ requestId: string; acc: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const [regeneratePrompt, setRegeneratePrompt] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  /** 本次发送实际使用的上下文范围（用于锁定“只能扩大”） */
  const sentRangeRef = useRef<{ before: number; after: number } | null>(null)
  /** 对话已进行后锁定的最小范围（PRD 改进：此后上下文只能扩大不能缩小） */
  const [lockedRange, setLockedRange] = useState<{ before: number; after: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const setTabContextRange = useAppStore((s) => s.setContextRange)

  useEffect(() => {
    void api.invoke('chat:get', chatId).then(({ chat, messages }) => {
      setChat(chat)
      setMessages(messages)
      if (chat.contextRange) setRange(chat.contextRange)
    })
  }, [chatId])

  // 流式订阅
  useEffect(() => {
    const offChunk = api.on('stream:chunk', (p) => {
      if (p.chatId !== chatId) return
      setStreaming((s) => (s && s.requestId === p.requestId ? { ...s, acc: s.acc + p.delta } : s))
    })
    const offDone = api.on('stream:done', (p) => {
      if (p.chatId !== chatId) return
      setStreaming((s) => (s && s.requestId === p.requestId ? null : s))
      if (p.aborted) {
        sentRangeRef.current = null
        return
      }
      if (p.error) {
        setError(p.error)
        sentRangeRef.current = null
        return
      }
      if (p.content) {
        setMessages((m) => [
          ...m,
          { id: `a-${p.requestId}`, role: 'assistant', content: p.content, createdAt: new Date().toISOString() }
        ])
        if (sentRangeRef.current) {
          setLockedRange(sentRangeRef.current)
          sentRangeRef.current = null
        }
      }
    })
    return () => {
      offChunk()
      offDone()
    }
  }, [chatId])

  // 关闭对话窗口 → 后台生成/更新聊天摘要（PRD 7.5）
  useEffect(() => {
    return () => {
      void api.invoke('summary:queueChat', chatId)
    }
  }, [chatId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streaming?.acc])

  function updateRange(r: ContextRange): void {
    setRange(r)
    setTabContextRange(tab.id, r)
    if (chat?.docId) {
      useContextStore.getState().setHighlight({ docId: chat.docId, ...r })
    }
    void api.invoke('chat:setContext', { chatId, contextRange: r })
    if (lockedRange && (r.before !== lockedRange.before || r.after !== lockedRange.after)) {
      setRegeneratePrompt(true)
    }
  }

  async function send(regenerate = false): Promise<void> {
    if (streaming) return
    if (!regenerate && !input.trim() && attachments.length === 0) return
    const requestId = crypto.randomUUID()
    const userMessageId = crypto.randomUUID()
    if (!regenerate) {
      setMessages((m) => [
        ...m,
        { id: userMessageId, role: 'user', content: input, createdAt: new Date().toISOString(), attachments }
      ])
    }
    setStreaming({ requestId, acc: '' })
    setError(null)
    setRegeneratePrompt(false)
    const streamRange = chat?.kind === 'context' && chat.docId && range ? toStreamRange(range, chat.docId, chat.projectId) : undefined
    sentRangeRef.current = streamRange ? { before: streamRange.before, after: streamRange.after } : null
    await api.invoke('api:streamChat', {
      chatId,
      requestId,
      userText: regenerate ? '' : input,
      snapshotIds: regenerate ? undefined : attachments.map((a) => a.snapshotId),
      contextRange: streamRange,
      regenerate,
      userMessageId
    })
    if (!regenerate) {
      setInput('')
      setAttachments([])
    }
  }

  async function copy(text: string, id?: string): Promise<void> {
    await navigator.clipboard.writeText(text)
    if (id) {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1200)
    }
  }

  const isContext = chat?.kind === 'context'

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
        <span className="text-sm font-medium">{tab.title}</span>
        {chat && chat.kind === 'doc' && <span className="text-xs" style={{ color: 'var(--muted)' }}>文档对话</span>}
        {chat && chat.kind === 'context' && <span className="text-xs" style={{ color: 'var(--accent)' }}>上下文对话</span>}
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
          {regeneratePrompt && (
            <div className="flex items-center gap-3 rounded-lg border px-3 py-2" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}>
              <span className="text-sm">检测到上下文范围调整，是否自动重新生成最近的 AI 回答？</span>
              <button className="btn btn-primary !px-2 !py-1" onClick={() => void send(true)}>
                重新生成
              </button>
              <button className="btn !px-2 !py-1" onClick={() => setRegeneratePrompt(false)}>
                取消
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
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
              {m.content}
              {m.role === 'assistant' && (
                <button
                  className="mt-1.5 flex items-center gap-1 text-xs opacity-60 hover:opacity-100"
                  style={{ color: 'var(--muted)' }}
                  onClick={() => void copy(m.content, m.id)}
                >
                  {copiedId === m.id ? <Check size={12} /> : <Copy size={12} />}
                  {copiedId === m.id ? '已复制' : '全篇复制'}
                </button>
              )}
            </div>
          </div>
        ))}

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
            调用失败：{error}
          </div>
        )}
      </div>

      <div className="border-t p-3" style={{ borderColor: 'var(--border)' }}>
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {attachments.map((a) => (
              <span key={a.snapshotId} className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs" style={{ background: 'var(--panel3)' }}>
                <FileText size={11} />
                {a.name}
                <button
                  className="opacity-60 hover:opacity-100"
                  onClick={() => setAttachments(attachments.filter((x) => x.snapshotId !== a.snapshotId))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button className="btn !px-2 !py-2" title="上传文件" onClick={() => setShowUpload(true)}>
            <Paperclip size={16} />
          </button>
          <textarea
            className="input min-h-[40px] flex-1 resize-none"
            rows={1}
            placeholder="输入消息…"
            value={input}
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
              取消
            </button>
          ) : (
            <button className="btn btn-primary !px-3 !py-2" onClick={() => void send()} disabled={!input.trim() && attachments.length === 0}>
              <Send size={15} />
              发送
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
