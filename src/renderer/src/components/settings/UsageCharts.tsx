import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { UsageSnapshot } from '@shared/types'
import { useT } from '../../i18n'

export default function UsageCharts({ snapshot }: { snapshot: UsageSnapshot }): JSX.Element {
  const t = useT()
  const lifetimeSummary = snapshot.lifetime.summary ?? 0
  const summaryRatio = snapshot.lifetime.total > 0 ? Math.round((lifetimeSummary / snapshot.lifetime.total) * 100) : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-6 text-sm">
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {t('usage.todayTotal')}
          </div>
          <div className="font-semibold">{snapshot.todayTotal.toLocaleString()} {t('usage.tokens')}</div>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {t('usage.summaryToday')}
          </div>
          <div className="font-semibold">{snapshot.todaySummary.toLocaleString()} {t('usage.tokens')}</div>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {t('usage.lifetimeTotal')}
          </div>
          <div className="font-semibold">{snapshot.lifetime.total.toLocaleString()} {t('usage.tokens')}</div>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {t('usage.summaryLifetime')}
          </div>
          <div className="font-semibold">
            {lifetimeSummary.toLocaleString()} {t('usage.tokens')}（{summaryRatio}%）
          </div>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {t('usage.uncounted')}
          </div>
          <div className="font-semibold">{snapshot.lifetime.uncounted}</div>
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium" style={{ color: 'var(--muted)' }}>
          {t('usage.chart30')}
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={snapshot.last30Days} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <Tooltip contentStyle={{ background: 'var(--panel2)', border: '1px solid var(--border)', fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" name={t('usage.legendTotal')} dataKey="total" stroke="var(--accent)" strokeWidth={2} dot={false} />
            <Line type="monotone" name={t('usage.legendSummary')} dataKey="summary" stroke="var(--warn)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium" style={{ color: 'var(--muted)' }}>
          {t('usage.chartToday')}
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={snapshot.today} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="hour" tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <Tooltip contentStyle={{ background: 'var(--panel2)', border: '1px solid var(--border)', fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" name={t('usage.legendTotal')} dataKey="total" stroke="var(--ok)" strokeWidth={2} dot={false} />
            <Line type="monotone" name={t('usage.legendSummary')} dataKey="summary" stroke="var(--warn)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
