import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Crosshair } from 'lucide-react'
import type { ContextRange } from '@shared/types'
import { api } from '../../lib/api'
import { useT } from '../../i18n'

interface Props {
  docId: string
  range: ContextRange
  disabled: boolean
  onChange: (range: ContextRange) => void
  /** Whether this panel should initially use its compact collapsed presentation. */
  defaultCollapsed: boolean
  /** Minimum preceding context locked after the conversation has started. */
  minBefore?: number
  /** Minimum following context locked after the conversation has started. */
  minAfter?: number
}

interface AnchorPreview {
  kind: 'cursor' | 'selection'
  before?: string
  text?: string
  after?: string
}

const PREVIEW_LIMIT = 300

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function truncateMiddle(text: string, limit = PREVIEW_LIMIT): string {
  if (text.length <= limit) return text
  const head = Math.ceil((limit - 1) / 2)
  const tail = Math.floor((limit - 1) / 2)
  return `${text.slice(0, head)}\u2026${text.slice(-tail)}`
}

function buildAnchorPreview(content: string, range: ContextRange): AnchorPreview | null {
  const hasSelection =
    range.selectionFrom !== undefined && range.selectionTo !== undefined && range.selectionTo > range.selectionFrom
  if (hasSelection) {
    const start = clamp(range.selectionFrom!, 0, content.length)
    const end = clamp(range.selectionTo!, start, content.length)
    const text = content.slice(start, end).trim()
    return text ? { kind: 'selection', text: truncateMiddle(text) } : null
  }

  const anchor = clamp(range.anchor, 0, content.length)
  const lineStart = content.lastIndexOf('\n', Math.max(0, anchor - 1)) + 1
  const nextBreak = content.indexOf('\n', anchor)
  const lineEnd = nextBreak === -1 ? content.length : nextBreak
  const before = content.slice(lineStart, anchor)
  const after = content.slice(anchor, lineEnd)
  if (!(before + after).trim()) return null

  const beforeLimit = Math.ceil((PREVIEW_LIMIT - 1) / 2)
  const afterLimit = Math.floor((PREVIEW_LIMIT - 1) / 2)
  return {
    kind: 'cursor',
    before: before.length > beforeLimit ? `\u2026${before.slice(-beforeLimit + 1)}` : before,
    after: after.length > afterLimit ? `${after.slice(0, afterLimit - 1)}\u2026` : after
  }
}

function rangeFill(value: number, min: number, max: number): string {
  if (max <= min) return '0%'
  return `${Math.round(((clamp(value, min, max) - min) / (max - min)) * 100)}%`
}

export default function ContextPanel({
  docId,
  range,
  disabled,
  onChange,
  defaultCollapsed,
  minBefore,
  minAfter
}: Props): JSX.Element {
  const t = useT()
  const [docContent, setDocContent] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [previewOpen, setPreviewOpen] = useState(false)
  const anchorPreviewId = useId()

  useEffect(() => {
    let cancelled = false
    setDocContent(null)
    setPreviewOpen(false)
    void api.invoke('doc:read', docId)
      .then(({ content }) => {
        if (!cancelled) setDocContent(content)
      })
      .catch(() => {
        if (!cancelled) setDocContent('')
      })
    return () => {
      cancelled = true
    }
  }, [docId])

  const hasSel =
    range.selectionFrom !== undefined && range.selectionTo !== undefined && range.selectionTo > range.selectionFrom
  const coreStart = hasSel ? range.selectionFrom! : range.anchor
  const coreEnd = hasSel ? range.selectionTo! : range.anchor
  const beforeMax = Math.max(0, coreStart)
  const afterMax = docContent == null ? 100000 : Math.max(0, docContent.length - coreEnd)
  const beforeDisabled = beforeMax <= 0
  const afterDisabled = afterMax <= 0
  const beforeMin = Math.min(minBefore ?? 0, beforeMax)
  const afterMin = Math.min(minAfter ?? 0, afterMax)
  const preview = useMemo(
    () => (docContent == null ? null : buildAnchorPreview(docContent, range)),
    [docContent, range]
  )

  const clampBefore = (value: number): number => clamp(value, beforeMin, beforeMax)
  const clampAfter = (value: number): number => clamp(value, afterMin, afterMax)
  const setBefore = (value: number): void => onChange({ ...range, before: clampBefore(value) })
  const setAfter = (value: number): void => onChange({ ...range, after: clampAfter(value) })
  const rangeSummary = `${t('context.before')} ${t('context.chars', { n: range.before })} \u00b7 ${t('context.after')} ${t('context.chars', { n: range.after })}`

  return (
    <section
      className={`context-panel ${collapsed ? 'context-panel--collapsed' : ''}`}
      aria-label={t('context.title')}
    >
      <div className="context-panel__header">
        <div className="context-panel__title-group">
          <Crosshair size={13} aria-hidden="true" />
          <span className="context-panel__title">{t('context.title')}</span>
          <div
            className="context-anchor-preview"
            onMouseEnter={() => setPreviewOpen(true)}
            onMouseLeave={() => setPreviewOpen(false)}
            onFocusCapture={() => setPreviewOpen(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setPreviewOpen(false)
            }}
          >
            <button type="button" className="context-anchor-preview__trigger" aria-describedby={anchorPreviewId}>
              {t('context.anchor')}
            </button>
            {previewOpen && (
              <div id={anchorPreviewId} className="context-anchor-preview__popover" role="tooltip">
                <div className="context-anchor-preview__label">
                  {preview?.kind === 'selection' ? t('context.anchorSelection') : t('context.anchorCursor')}
                </div>
                {docContent == null ? (
                  <div className="context-anchor-preview__text">{t('context.anchorLoading')}</div>
                ) : preview?.kind === 'selection' ? (
                  <div className="context-anchor-preview__text">{preview.text}</div>
                ) : preview ? (
                  <div className="context-anchor-preview__text">
                    {preview.before}<span className="context-anchor-preview__marker" aria-label={t('context.anchorPosition')}>{'\u2502'}</span>{preview.after}
                  </div>
                ) : (
                  <div className="context-anchor-preview__text">{t('context.anchorUnavailable')}</div>
                )}
              </div>
            )}
          </div>
          {(minBefore || minAfter) && <span className="context-panel__lock">{t('context.expandOnly')}</span>}
        </div>
        {collapsed && <span className="context-panel__summary">{rangeSummary}</span>}
        <button
          type="button"
          className="context-panel__collapse"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          title={collapsed ? t('context.expand') : t('context.collapse')}
        >
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
          <span>{collapsed ? t('context.expand') : t('context.collapse')}</span>
        </button>
      </div>

      {!collapsed && (
        <div className="context-panel__body">
          <label className="context-panel__number context-panel__number--before">
            <span>{t('context.before')}</span>
            <input
              type="number"
              min={beforeMin}
              max={beforeMax}
              step={10}
              value={clampBefore(range.before)}
              disabled={beforeDisabled || disabled}
              aria-label={t('context.before')}
              onChange={(event) => setBefore(Number(event.target.value) || 0)}
            />
            <span>{t('context.charUnit')}</span>
          </label>

          <div className="context-dual-slider" aria-label={t('context.title')}>
            <input
              type="range"
              min={beforeMin}
              max={beforeMax}
              step={10}
              value={clampBefore(range.before)}
              disabled={beforeDisabled || disabled}
              className="context-dual-slider__input context-dual-slider__input--before"
              style={{ ['--range-fill' as string]: rangeFill(range.before, beforeMin, beforeMax) }}
              aria-label={t('context.before')}
              onChange={(event) => setBefore(Number(event.target.value))}
            />
            <span className="context-dual-slider__anchor" title={hasSel ? t('context.coreSel') : t('context.coreCursor')}>
              <span>{t('context.anchor')}</span>
            </span>
            <input
              type="range"
              min={afterMin}
              max={afterMax}
              step={10}
              value={clampAfter(range.after)}
              disabled={afterDisabled || disabled}
              className="context-dual-slider__input context-dual-slider__input--after"
              style={{ ['--range-fill' as string]: rangeFill(range.after, afterMin, afterMax) }}
              aria-label={t('context.after')}
              onChange={(event) => setAfter(Number(event.target.value))}
            />
          </div>

          <label className="context-panel__number context-panel__number--after">
            <span>{t('context.after')}</span>
            <input
              type="number"
              min={afterMin}
              max={afterMax}
              step={10}
              value={clampAfter(range.after)}
              disabled={afterDisabled || disabled}
              aria-label={t('context.after')}
              onChange={(event) => setAfter(Number(event.target.value) || 0)}
            />
            <span>{t('context.charUnit')}</span>
          </label>
        </div>
      )}
    </section>
  )
}
