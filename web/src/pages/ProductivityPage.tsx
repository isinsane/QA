import { useState } from 'react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { QAProductivity } from '../api/types'
import { DateRangePicker, Empty, rangeFor, type DateRange } from '../components/bits'

type By = QAProductivity['by']

const BY: [By, string][] = [
  ['hour', 'By hour'],
  ['day', 'By day'],
  ['week', 'By week'],
  ['month', 'By month'],
]

/** A local wall-clock "YYYY-MM-DDTHH:MI" (the server sends local times) as a Date to format. */
function wall(s: string): Date {
  const [y, m, d, h, min] = s.split(/[-T:]/).map(Number)
  return new Date(y, m - 1, d, h || 0, min || 0)
}

function bucketLabel(b: string, by: By, oneDay: boolean): string {
  const d = wall(b)
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  switch (by) {
    case 'hour':
      return oneDay ? b.slice(11, 16) : `${day} ${b.slice(11, 16)}`
    case 'day':
      return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    case 'week':
      return `wk ${day}`
    case 'month':
      return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  }
}

function clock(s: string | null, oneDay: boolean): string {
  if (!s) return '—'
  const time = s.slice(11, 16)
  return oneDay ? time : `${wall(s.slice(0, 16)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')

/** What each QA agent did, by when they did it: audits and their other work, hour by hour up to month by month. */
export function ProductivityPage() {
  const [range, setRange] = useState<DateRange>(() => rangeFor('today'))
  const [by, setBy] = useState<By>('hour')
  const res = useApi(() => api.qaProductivity({ from: range.from, to: range.to, by }), [range.from, range.to, by], { pollMs: 60_000 })
  const agents = res.data?.agents ?? []
  const series = res.data?.series ?? []
  const buckets = [...new Set(series.map((s) => s.bucket))].sort()
  const cell = new Map(series.map((s) => [`${s.qa_id}|${s.bucket}`, s]))
  const most = Math.max(1, ...series.map((s) => s.audits))
  const oneDay = range.from === range.to
  const worked = agents.filter((a) => a.audits || a.cant_audit || a.checked || a.coaching)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">QA productivity</h1>
          <p className="page-subtitle">What each QA agent did, by the time they did it. Updates every minute.</p>
        </div>
        <div className="segmented">
          {BY.map(([k, label]) => (
            <button key={k} type="button" className={`segmented-btn${by === k ? ' is-active' : ''}`} onClick={() => setBy(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <DateRangePicker
        value={range}
        presets={['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']}
        onChange={setRange}
      />
      {res.error ? <div className="inline-warning">{res.error}</div> : null}

      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Summary</h2>
            <p className="card-subtitle">
              Audits they submitted in the period. Per hour counts only hours with work. Disputes are the agents' answers to those audits.
            </p>
          </div>
        </div>
        {agents.length === 0 && !res.loading ? <Empty title="No QA agents yet" /> : null}
        {agents.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>QA agent</th>
                  <th>Audits</th>
                  <th title="Audits per hour with any work">Per hour</th>
                  <th title="Average of the scores they gave">Avg score</th>
                  <th>Pass · borderline · fail</th>
                  <th>Critical fails</th>
                  <th>Can't audit</th>
                  <th title="Negatives and team leader escalations they checked">Escalations checked</th>
                  <th>Coaching</th>
                  <th title="Disputed by the agent · of those, the score was changed">Disputed · changed</th>
                  <th>First · last action</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.qa_id}>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span className={`status-dot${a.online ? ' on' : ''}`} title={a.online ? 'Online' : 'Offline'} />
                        <strong>{a.name}</strong>
                      </span>
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {a.team}
                        {a.active ? ` · ${a.in_queue} in queue now` : ' · deactivated'}
                      </div>
                    </td>
                    <td>
                      <strong>{a.audits}</strong>
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {(
                          [
                            [a.sample, 'sample'],
                            [a.live, 'live'],
                            [a.escalation, 'escalation'],
                            [a.focus, 'focus'],
                            [a.rotation, 'rotation'],
                          ] as const
                        )
                          .filter(([n]) => n)
                          .map(([n, k]) => `${n} ${k}`)
                          .join(' · ')}
                      </div>
                    </td>
                    <td>
                      {a.active_hours ? (a.audits / a.active_hours).toFixed(1) : '—'}
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {a.active_hours} h with work
                      </div>
                    </td>
                    <td>{a.avg_score === null ? '—' : `${a.avg_score}%`}</td>
                    <td>
                      {pct(a.pass, a.audits)} · {pct(a.borderline, a.audits)} · {pct(a.fail, a.audits)}
                    </td>
                    <td>{a.critical || <span className="text-tertiary">0</span>}</td>
                    <td>{a.cant_audit || <span className="text-tertiary">0</span>}</td>
                    <td>{a.checked || <span className="text-tertiary">0</span>}</td>
                    <td>{a.coaching || <span className="text-tertiary">0</span>}</td>
                    <td>
                      {a.disputed} · {a.score_changed}
                    </td>
                    <td>
                      {clock(a.first, oneDay)}
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {clock(a.last, oneDay)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Audits {BY.find(([k]) => k === by)?.[1].toLowerCase()}</h2>
            <p className="card-subtitle">Darker means more audits. A small +n is other work: can't audit, escalations checked, coaching.</p>
          </div>
        </div>
        {buckets.length === 0 && !res.loading ? <Empty title="No work in this period" /> : null}
        {buckets.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>QA agent</th>
                  {buckets.map((b) => (
                    <th key={b} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                      {bucketLabel(b, by, oneDay)}
                    </th>
                  ))}
                  <th style={{ textAlign: 'center' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {worked.map((a) => (
                  <tr key={a.qa_id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <strong>{a.name}</strong>
                    </td>
                    {buckets.map((b) => {
                      const c = cell.get(`${a.qa_id}|${b}`)
                      return (
                        <td
                          key={b}
                          title={c ? `${c.audits} audits, ${c.other} other` : 'nothing'}
                          style={{
                            textAlign: 'center',
                            background: c?.audits
                              ? `color-mix(in srgb, var(--brand-500) ${Math.round(10 + (c.audits / most) * 60)}%, transparent)`
                              : undefined,
                          }}
                        >
                          {c?.audits ? c.audits : c ? null : <span className="text-tertiary">·</span>}
                          {c?.other ? <sup className="text-tertiary"> +{c.other}</sup> : null}
                        </td>
                      )
                    })}
                    <td style={{ textAlign: 'center' }}>
                      <strong>{a.audits}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  )
}
