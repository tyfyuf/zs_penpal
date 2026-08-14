import { useEffect, useState } from 'react'
import type { ContextRange } from '@shared/types'
import { api } from '../../lib/api'

interface Props {
  docId: string
  range: ContextRange
  disabled: boolean
  onChange: (range: ContextRange) => void
}

export default function ContextPanel({ docId, range, disabled, onChange }: Props): JSX.Element {
  const [docLen, setDocLen] = useState<number | null>(null)

  useEffect(() => {
    void api.invoke('doc:read', docId).then(({ content }) => setDocLen(content.length))
  }, [docId])

  const hasSel =
    range.selectionFrom !== undefined && range.selectionTo !== undefined && range.selectionTo > range.selectionFrom
  const coreStart = hasSel ? range.selectionFrom! : range.anchor
  const coreEnd = hasSel ? range.selectionTo! : range.anchor
  const beforeMax = Math.max(0, coreStart)
  const afterMax = docLen == null ? 100000 : Math.max(0, docLen - coreEnd)
  const beforeDisabled = beforeMax <= 0
  const afterDisabled = afterMax <= 0

  return (
    <div
      className="rounded-lg border p-3"
      style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}
    >
      <div className="mb-2 text-xs font-semibold" style={{ color: 'var(--muted)' }}>
        上下文范围
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span style={{ color: 'var(--muted)' }}>前文</span>
          <span style={{ color: 'var(--text)' }}>{range.before} 字</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={beforeMax}
            step={10}
            value={Math.min(range.before, beforeMax)}
            disabled={beforeDisabled || disabled}
            className="flex-1 accent-[var(--accent)]"
            onChange={(e) => onChange({ ...range, before: Number(e.target.value) })}
          />
          <input
            type="number"
            className="input !w-20"
            min={0}
            value={range.before}
            disabled={beforeDisabled || disabled}
            onChange={(e) => onChange({ ...range, before: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span style={{ color: 'var(--muted)' }}>后文</span>
          <span style={{ color: 'var(--text)' }}>{range.after} 字</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={afterMax}
            step={10}
            value={Math.min(range.after, afterMax)}
            disabled={afterDisabled || disabled}
            className="flex-1 accent-[var(--accent)]"
            onChange={(e) => onChange({ ...range, after: Number(e.target.value) })}
          />
          <input
            type="number"
            className="input !w-20"
            min={0}
            value={range.after}
            disabled={afterDisabled || disabled}
            onChange={(e) => onChange({ ...range, after: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>
      </div>

      <div className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        {hasSel ? '已按选区确定核心内容' : '以光标位置为中心'}
        {beforeDisabled ? ' · 光标位于文档开头，前文不可调' : ''}
        {afterDisabled ? ' · 光标位于文档结尾，后文不可调' : ''}
      </div>
    </div>
  )
}
