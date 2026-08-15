import { useEffect, useState } from 'react'
import type { ContextRange } from '@shared/types'
import { api } from '../../lib/api'
import { useT } from '../../i18n'

interface Props {
  docId: string
  range: ContextRange
  disabled: boolean
  onChange: (range: ContextRange) => void
  /** 对话已进行后锁定的最小前文（只能扩大不能缩小） */
  minBefore?: number
  /** 对话已进行后锁定的最小后文（只能扩大不能缩小） */
  minAfter?: number
}

export default function ContextPanel({ docId, range, disabled, onChange, minBefore, minAfter }: Props): JSX.Element {
  const t = useT()
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

  const beforeMin = Math.min(minBefore ?? 0, beforeMax)
  const afterMin = Math.min(minAfter ?? 0, afterMax)

  const clampBefore = (v: number): number => Math.min(beforeMax, Math.max(beforeMin, v))
  const clampAfter = (v: number): number => Math.min(afterMax, Math.max(afterMin, v))

  return (
    <div className="rounded-lg border p-3" style={{ background: 'var(--panel)', borderColor: 'var(--border)' }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
          {t('context.title')}
        </span>
        {(minBefore || minAfter) && (
          <span className="text-[11px]" style={{ color: 'var(--warn)' }}>
            {t('context.expandOnly')}
          </span>
        )}
      </div>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span style={{ color: 'var(--muted)' }}>{t('context.before')}</span>
          <span style={{ color: 'var(--text)' }}>{t('context.chars', { n: range.before })}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={beforeMin}
            max={beforeMax}
            step={10}
            value={Math.min(range.before, beforeMax)}
            disabled={beforeDisabled || disabled}
            className="flex-1 accent-[var(--accent)]"
            onChange={(e) => onChange({ ...range, before: clampBefore(Number(e.target.value)) })}
          />
          <input
            type="number"
            className="input !w-20"
            min={beforeMin}
            max={beforeMax}
            value={range.before}
            disabled={beforeDisabled || disabled}
            onChange={(e) => onChange({ ...range, before: clampBefore(Number(e.target.value) || 0) })}
          />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-xs">
          <span style={{ color: 'var(--muted)' }}>{t('context.after')}</span>
          <span style={{ color: 'var(--text)' }}>{t('context.chars', { n: range.after })}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={afterMin}
            max={afterMax}
            step={10}
            value={Math.min(range.after, afterMax)}
            disabled={afterDisabled || disabled}
            className="flex-1 accent-[var(--accent)]"
            onChange={(e) => onChange({ ...range, after: clampAfter(Number(e.target.value)) })}
          />
          <input
            type="number"
            className="input !w-20"
            min={afterMin}
            max={afterMax}
            value={range.after}
            disabled={afterDisabled || disabled}
            onChange={(e) => onChange({ ...range, after: clampAfter(Number(e.target.value) || 0) })}
          />
        </div>
      </div>

      <div className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        {hasSel ? t('context.coreSel') : t('context.coreCursor')}
        {beforeDisabled ? t('context.atStart') : ''}
        {afterDisabled ? t('context.atEnd') : ''}
      </div>
    </div>
  )
}
