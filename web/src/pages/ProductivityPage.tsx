import { useState } from 'react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { QAProductivity } from '../api/types'
import { DateRangePicker, Empty, rangeFor, type DateRange } from '../components/bits'

type By = QAProductivity['by']
type Agent = QAProductivity['agents'][number]
type Bucket = QAProductivity['series'][number]

const BY: [By, string][] = [
  ['hour', 'Hour'],
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
]

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** A local wall-clock "YYYY-MM-DD[THH:MI]" (the server sends local times) as a Date to format. */
function wall(s: string): Date {
  const [y, m, d, h, min] = s.split(/[-T:]/).map(Number)
  return new Date(y, m - 1, d, h || 0, min || 0)
}

const dayName = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

/** One column of the heat map; key is the server's bucket. */
interface Col {
  key: string
  label: string
  group: string // the header row above (a day for hours, a month for days)
  title: string
}

/**
 * Every bucket of the period, so idle hours and days show as gaps. By hour:
 * one day is its 24 hours; several are the days with work, from the earliest
 * to the latest hour anyone audited.
 */
function columns(by: By, from: string, to: string, series: Bucket[]): Col[] {
  const days: Date[] = []
  for (let d = wall(from); d <= wall(to); d.setDate(d.getDate() + 1)) days.push(new Date(d))
  const unique = (cols: Col[]) => cols.filter((c, i) => cols.findIndex((x) => x.key === c.key) === i)
  switch (by) {
    case 'hour': {
      if (!series.length) return []
      const audited = series.filter((s) => s.audits)
      const hours = (audited.length ? audited : series).map((s) => Number(s.bucket.slice(11, 13)))
      const lo = from === to ? 0 : Math.min(...hours)
      const hi = from === to ? 23 : Math.max(...hours)
      const worked = new Set(series.map((s) => s.bucket.slice(0, 10)))
      return days
        .filter((d) => worked.has(ymd(d)))
        .flatMap((d) =>
          Array.from({ length: hi - lo + 1 }, (_, i) => {
            const h = lo + i
            return {
              key: `${ymd(d)}T${pad(h)}:00`,
              label: pad(h),
              group: dayName(d),
              title: `${dayName(d)}, ${pad(h)}:00–${pad((h + 1) % 24)}:00`,
            }
          }),
        )
    }
    case 'day':
      return days.map((d) => ({
        key: `${ymd(d)}T00:00`,
        label: String(d.getDate()),
        group: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        title: dayName(d),
      }))
    case 'week':
      return unique(
        days.map((d) => {
          const monday = new Date(d)
          monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
          const label = monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          return { key: `${ymd(monday)}T00:00`, label, group: '', title: `Week of ${label}` }
        }),
      )
    case 'month':
      return unique(
        days.map((d) => {
          const first = new Date(d.getFullYear(), d.getMonth(), 1)
          const label = first.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
          return { key: `${ymd(first)}T00:00`, label, group: '', title: label }
        }),
      )
  }
}

const NAME_W = 210 // px: the QA agent column of the heat map
const TOTAL_W = 120

/** 0 for nothing, then 1–5 by share of the busiest cell. */
const level = (n: number, most: number) => (n ? Math.min(5, Math.max(1, Math.ceil((n / most) * 5))) : 0)

function clock(s: string | null, oneDay: boolean): string {
  if (!s) return '—'
  const time = s.slice(11, 16)
  return oneDay ? time : `${wall(s.slice(0, 10)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')

/** What each QA agent did, by when they did it: a heat map of their audits, then the period's numbers. */
export function ProductivityPage() {
  const [range, setRange] = useState<DateRange>(() => rangeFor('today'))
  const [by, setBy] = useState<By>('hour')
  const res = useApi(() => api.qaProductivity({ from: range.from, to: range.to, by }), [range.from, range.to, by], { pollMs: 60_000 })
  const agents = res.data?.agents ?? []
  const oneDay = range.from === range.to

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">QA productivity</h1>
          <p className="page-subtitle">When each QA agent worked and how much. Updates every minute.</p>
        </div>
      </div>
      <div className="dash-filters">
        <DateRangePicker
          value={range}
          presets={['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']}
          onChange={setRange}
        />
      </div>
      {res.error ? <div className="inline-warning">{res.error}</div> : null}

      <Heatmap agents={agents} series={res.data?.series ?? []} by={by} onBy={setBy} range={range} loading={res.loading && !res.data} />

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
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
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
    </div>
  )
}

/** Audits per QA agent per hour / day / week / month: rows are QA agents, darker is busier. */
function Heatmap({
  agents,
  series,
  by,
  onBy,
  range,
  loading,
}: {
  agents: Agent[]
  series: Bucket[]
  by: By
  onBy: (b: By) => void
  range: DateRange
  loading: boolean
}) {
  const cols = columns(by, range.from, range.to, series)
  const cell = new Map(series.map((s) => [`${s.qa_id}|${s.bucket}`, s]))
  const most = Math.max(1, ...series.map((s) => s.audits))
  const colTotal = cols.map((c) => series.filter((s) => s.bucket === c.key).reduce((n, s) => n + s.audits, 0))
  const total = colTotal.reduce((a, b) => a + b, 0)
  const peak = colTotal.indexOf(Math.max(...colTotal))
  const working = agents.filter((a) => a.audits > 0).length
  // Header groups: a day over its hours, a month over its days.
  const groups: { name: string; span: number }[] = []
  for (const c of cols) {
    if (groups.length && groups[groups.length - 1].name === c.group) groups[groups.length - 1].span++
    else groups.push({ name: c.group, span: 1 })
  }
  const unit = by === 'hour' ? 'hour' : by
  const maxCol = Math.max(1, ...colTotal)
  const maxAgent = Math.max(1, ...agents.map((a) => a.audits))

  return (
    <section className="card">
      <div className="card-header hm-header">
        <div>
          <h2 className="card-title">Activity</h2>
          <p className="card-subtitle">Audits each QA agent submitted per {unit}. Hover a cell for details.</p>
        </div>
        <div className="segmented">
          {BY.map(([k, label]) => (
            <button key={k} type="button" className={`segmented-btn${by === k ? ' is-active' : ''}`} onClick={() => onBy(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="hm-stats">
        <div>
          <span className="hm-stat-value">{total}</span>
          <span className="hm-stat-label">audits</span>
        </div>
        <div>
          <span className="hm-stat-value">
            {working}
            <span className="text-tertiary"> / {agents.filter((a) => a.active).length}</span>
          </span>
          <span className="hm-stat-label">QA agents with audits</span>
        </div>
        <div>
          <span className="hm-stat-value">{total && peak >= 0 ? colTotal[peak] : '—'}</span>
          <span className="hm-stat-label">
            busiest {unit}
            {total && peak >= 0 ? `: ${cols[peak].title}` : ''}
          </span>
        </div>
        <div className="hm-legend" aria-hidden>
          Less
          {[0, 1, 2, 3, 4, 5].map((l) => (
            <i key={l} className="hm-cell" data-l={l} />
          ))}
          More
          <span className="hm-other-key">
            <i /> other work
          </span>
        </div>
      </div>
      {loading ? <div className="card-body skeleton" style={{ height: 160 }} /> : null}
      {!loading && cols.length === 0 ? <Empty title="No audits in this period yet" /> : null}
      {!loading && cols.length ? (
        <div className="hm-wrap">
          <table
            className="hm"
            style={{
              minWidth: NAME_W + TOTAL_W + cols.length * 30,
              maxWidth: NAME_W + TOTAL_W + cols.length * (by === 'week' || by === 'month' ? 160 : 90),
            }}
          >
            <colgroup>
              <col style={{ width: NAME_W }} />
              {cols.map((c) => (
                <col key={c.key} />
              ))}
              <col style={{ width: TOTAL_W }} />
            </colgroup>
            <thead>
              <tr className="hm-bars">
                <th className="hm-name">All QA agents</th>
                {cols.map((c, i) => (
                  <td key={c.key} title={`${c.title}: ${colTotal[i]} audit${colTotal[i] === 1 ? '' : 's'}`}>
                    <div className="hm-bar-box">
                      {colTotal[i] ? <span>{colTotal[i]}</span> : null}
                      <i style={{ height: `${(colTotal[i] / maxCol) * 36}px` }} />
                    </div>
                  </td>
                ))}
                <td className="hm-total">{total}</td>
              </tr>
              {groups.length > 1 ? (
                <tr>
                  <th className="hm-name" />
                  {groups.map((g, i) => (
                    <th key={i} colSpan={g.span} className="hm-group">
                      {g.name}
                    </th>
                  ))}
                  <th />
                </tr>
              ) : null}
              <tr className="hm-labels">
                <th className="hm-name">{groups.length === 1 ? groups[0].name : null}</th>
                {cols.map((c) => (
                  <th key={c.key} title={c.title}>
                    {c.label}
                  </th>
                ))}
                <th className="hm-total">Total</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.qa_id}>
                  <th className="hm-name" scope="row">
                    <span className={`status-dot${a.online ? ' on' : ''}`} title={a.online ? 'Online now' : 'Offline'} />
                    <span>
                      {a.name}
                      <small>{a.team}</small>
                    </span>
                  </th>
                  {cols.map((c) => {
                    const b = cell.get(`${a.qa_id}|${c.key}`)
                    const n = b?.audits ?? 0
                    return (
                      <td
                        key={c.key}
                        className={`hm-cell${b?.other ? ' has-other' : ''}`}
                        data-l={level(n, most)}
                        title={`${a.name} · ${c.title}: ${n} audit${n === 1 ? '' : 's'}${b?.other ? `, ${b.other} other` : ''}`}
                      >
                        {n || ''}
                      </td>
                    )
                  })}
                  <td className="hm-total">
                    <span className="hm-total-bar">
                      <i style={{ width: `${(a.audits / maxAgent) * 100}%` }} />
                    </span>
                    {a.audits}
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
