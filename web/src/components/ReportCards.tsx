import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Reports } from '../api/types'
import { Empty, fmtDate } from './bits'

// Report cards shared by the dashboard and an agent's page.

const axisProps = {
  stroke: 'var(--viz-axis)',
  tick: { fill: 'var(--text-tertiary)', fontSize: 11 },
  tickLine: false,
} as const

export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`)

/** A bar with the value next to it, for tables of percentages. */
export function Bar({ value }: { value: number | null }) {
  return (
    <div className="weight">
      <span className="weight-bar">
        <span style={{ width: `${value ?? 0}%` }} />
      </span>
      <span className="weight-value" style={{ minWidth: 36, textAlign: 'right' }}>
        {pct(value)}
      </span>
    </div>
  )
}

export function ScoreTrendCard({ data }: { data: Reports['trend'] }) {
  const trend = data.map((t) => ({ ...t, label: `wk ${fmtDate(t.week).replace(/, \d{4}$/, '')}` }))
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Average score by week</h2>
          <p className="card-subtitle">Sample, live and escalation audits.</p>
        </div>
      </div>
      <div className="card-body" style={{ height: 300 }}>
        {trend.length === 0 ? (
          <Empty title="No evaluations in this range" />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
              <XAxis dataKey="label" {...axisProps} minTickGap={24} />
              <YAxis {...axisProps} width={36} domain={[0, 100]} unit="%" />
              <Tooltip
                cursor={{ stroke: 'var(--viz-axis)' }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="viz-tooltip">
                      <div className="viz-tooltip-label">{label}</div>
                      <div className="viz-tooltip-row">
                        <span className="viz-tooltip-swatch" style={{ background: 'var(--viz-1)' }} />
                        <span className="viz-tooltip-name">Average</span>
                        <span className="viz-tooltip-value">{pct(payload[0].value as number)}</span>
                      </div>
                      <div className="viz-tooltip-row">
                        <span className="viz-tooltip-name">Evaluations</span>
                        <span className="viz-tooltip-value">{(payload[0].payload as { evaluations: number }).evaluations}</span>
                      </div>
                    </div>
                  ) : null
                }
              />
              <Line
                type="monotone"
                dataKey="avg_score"
                name="Average"
                stroke="var(--viz-1)"
                strokeWidth={2}
                dot={{ r: 4, fill: 'var(--viz-1)', stroke: 'var(--bg-surface)', strokeWidth: 2 }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  )
}

/** Share of points earned per metric, weakest first: what to coach on. */
export function WeakestMetricsCard({ metrics }: { metrics: Reports['metrics'] }) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Metrics, weakest first</h2>
          <p className="card-subtitle">Share of points earned; "zero" counts answers that earned nothing.</p>
        </div>
      </div>
      {metrics.length === 0 ? <Empty title="No scored metrics yet" /> : null}
      <ul className="outcome-list dash-scroll">
        {metrics.map((m) => (
          <li className="outcome-row" key={m.id}>
            <span className="outcome-name">{m.label}</span>
            <span className="outcome-bar">
              <span className="outcome-bar-fill" style={{ width: `${m.avg_pct ?? 0}%`, background: 'var(--viz-1)' }} />
            </span>
            <span className="outcome-value">
              {pct(m.avg_pct)}
              <span className="outcome-share">
                {m.zero} zero · {m.answered} answered
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ByLabelCard({ byLabel }: { byLabel: Reports['by_label'] }) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">By disposition code / tag</h2>
          <p className="card-subtitle">Lowest average first shows where agents struggle.</p>
        </div>
      </div>
      {byLabel.length === 0 ? <Empty title="Nothing scored yet" /> : null}
      {byLabel.length ? (
        <div className="table-scroll dash-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Code / tag</th>
                <th style={{ width: 90 }}>Audits</th>
                <th style={{ width: 200 }}>Average</th>
              </tr>
            </thead>
            <tbody>
              {[...byLabel]
                .sort((a, b) => (a.avg_score ?? 0) - (b.avg_score ?? 0))
                .map((l) => (
                  <tr key={l.label}>
                    <td>{l.label}</td>
                    <td>{l.evaluations}</td>
                    <td>
                      <Bar value={l.avg_score} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
