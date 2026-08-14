import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { UsageSnapshot } from '@shared/types'

export default function UsageCharts({ snapshot }: { snapshot: UsageSnapshot }): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex gap-6 text-sm">
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            今日总消耗
          </div>
          <div className="font-semibold">{snapshot.todayTotal.toLocaleString()} tokens</div>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            历史总消耗
          </div>
          <div className="font-semibold">{snapshot.lifetime.total.toLocaleString()} tokens</div>
        </div>
        <div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            未计入调用
          </div>
          <div className="font-semibold">{snapshot.lifetime.uncounted}</div>
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium" style={{ color: 'var(--muted)' }}>
          近 30 天 Token 消耗趋势
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={snapshot.last30Days} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <Tooltip contentStyle={{ background: 'var(--panel2)', border: '1px solid var(--border)', fontSize: 12 }} />
            <Line type="monotone" dataKey="total" stroke="var(--accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium" style={{ color: 'var(--muted)' }}>
          当日每小时 Token 消耗趋势
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={snapshot.today} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="hour" tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--muted)' }} />
            <Tooltip contentStyle={{ background: 'var(--panel2)', border: '1px solid var(--border)', fontSize: 12 }} />
            <Line type="monotone" dataKey="total" stroke="var(--ok)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
