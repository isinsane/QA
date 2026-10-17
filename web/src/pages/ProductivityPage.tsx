import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { useAuth } from '../auth/AuthContext'
import type { QAProductivity } from '../api/types'
import { DateRangePicker, Empty, rangeFor, ScoreBadge, type DateRange } from '../components/bits'
import { Modal } from '../components/Modal'

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
      const audited = series.filter((s) => count(s, AUDITS))
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

/**
 * What each QA agent did, by when they did it: a heat map of their audits,
 * then the period's numbers. QA agents see their team's heat map only, and
 * open only their own work.
 */
export function ProductivityPage() {
  const { user } = useAuth()
  const qa = user?.role === 'qa_agent'
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
          <p className="page-subtitle">
            {qa
              ? "When your team's QA agents worked. Updates every minute."
              : 'When each QA agent worked and how much. Updates every minute.'}
          </p>
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

      <Heatmap
        agents={agents}
        series={res.data?.series ?? []}
        by={by}
        onBy={setBy}
        range={range}
        loading={res.loading && !res.data}
        onlyOpen={qa ? user?.id : undefined}
      />

      {qa ? null : (
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
                    <th title="Focus plans they finished in the period · open now">Focus plans</th>
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
                        {a.focus_done} done
                        {a.focus_open ? (
                          <div className="text-tertiary" style={{ fontSize: 12 }}>
                            {a.focus_open} open
                          </div>
                        ) : null}
                      </td>
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
      )}
    </div>
  )
}

/** The kinds of work, as the server names them. */
type WorkKey = 'sample' | 'live' | 'escalation' | 'focus' | 'rotation' | 'coaching' | 'checked' | 'cant'

const WORK: Record<WorkKey, { many: string; one: string }> = {
  sample: { many: 'sample audits', one: 'Sample audit' },
  live: { many: 'live monitoring', one: 'Live monitoring' },
  escalation: { many: 'escalation audits', one: 'Escalation audit' },
  focus: { many: 'focus plan audits', one: 'Focus plan audit' },
  rotation: { many: 'rotation reviews', one: 'Rotation review' },
  coaching: { many: 'coaching sessions', one: 'Coaching session' },
  checked: { many: 'escalations checked', one: 'Escalation checked' },
  cant: { many: "can't audit", one: "Can't audit" },
}
const AUDITS: WorkKey[] = ['sample', 'live', 'escalation', 'focus', 'rotation']
const ALL: WorkKey[] = [...AUDITS, 'coaching', 'checked', 'cant']
/** Marked in a cell with a colored dot, so they stand out among the audits. */
const MARKED: WorkKey[] = ['live', 'coaching', 'checked', 'cant']

type Show = 'all' | 'audits' | 'live' | 'coaching' | 'checked' | 'cant'
const SHOW: [Show, string, WorkKey[]][] = [
  ['all', 'All work', ALL],
  ['audits', 'Audits', AUDITS],
  ['live', 'Live monitoring', ['live']],
  ['coaching', 'Coaching', ['coaching']],
  ['checked', 'Escalations checked', ['checked']],
  ['cant', "Can't audit", ['cant']],
]

/** "1 coaching session", "3 coaching sessions". */
const phrase = (n: number, k: WorkKey) => `${n} ${n === 1 ? WORK[k].one.toLowerCase() : WORK[k].many}`

const count = (b: Bucket | undefined, keys: WorkKey[]) => (b ? keys.reduce((n, k) => n + b[k], 0) : 0)

/** The start of the bucket after this one (end of a cell, excluded). */
function nextBucket(key: string, by: By): string {
  const d = wall(key)
  if (by === 'hour') d.setHours(d.getHours() + 1)
  else if (by === 'day') d.setDate(d.getDate() + 1)
  else if (by === 'week') d.setDate(d.getDate() + 7)
  else d.setMonth(d.getMonth() + 1)
  return `${ymd(d)}T${pad(d.getHours())}:00`
}

/** Work per QA agent per hour / day / week / month: rows are QA agents, darker is busier. Click a cell for the work itself. */
function Heatmap({
  agents,
  series,
  by,
  onBy,
  range,
  loading,
  onlyOpen,
}: {
  agents: Agent[]
  series: Bucket[]
  by: By
  onBy: (b: By) => void
  range: DateRange
  loading: boolean
  /** A QA agent's id: only their own cells open (what a teammate did is the supervisor's to know). */
  onlyOpen?: string
}) {
  const [show, setShow] = useState<Show>('all')
  const [open, setOpen] = useState<{ agent: Agent; col: Col } | null>(null)
  const [, showLabel, keys] = SHOW.find(([k]) => k === show)!
  const cols = columns(by, range.from, range.to, series)
  const cell = new Map(series.map((s) => [`${s.qa_id}|${s.bucket}`, s]))
  const most = Math.max(1, ...series.map((s) => count(s, keys)))
  const colTotal = cols.map((c) => series.filter((s) => s.bucket === c.key).reduce((n, s) => n + count(s, keys), 0))
  const agentTotal = new Map(
    agents.map((a) => [a.qa_id, series.filter((s) => s.qa_id === a.qa_id).reduce((n, s) => n + count(s, keys), 0)]),
  )
  const total = colTotal.reduce((a, b) => a + b, 0)
  const peak = colTotal.indexOf(Math.max(...colTotal))
  const working = agents.filter((a) => agentTotal.get(a.qa_id)).length
  const maxCol = Math.max(1, ...colTotal)
  const maxAgent = Math.max(1, ...agentTotal.values())
  const marks = MARKED.filter((k) => keys.includes(k) && keys.length > 1)
  // Header groups: a day over its hours, a month over its days.
  const groups: { name: string; span: number }[] = []
  for (const c of cols) {
    if (groups.length && groups[groups.length - 1].name === c.group) groups[groups.length - 1].span++
    else groups.push({ name: c.group, span: 1 })
  }

  return (
    <section className="card">
      <div className="card-header hm-header">
        <div>
          <h2 className="card-title">Activity</h2>
          <p className="card-subtitle">
            What each QA agent did per {by}. Hover a cell for the breakdown, click {onlyOpen ? 'one of yours' : 'it'} to see each piece of
            work.
          </p>
        </div>
        <div className="segmented">
          {BY.map(([k, label]) => (
            <button key={k} type="button" className={`segmented-btn${by === k ? ' is-active' : ''}`} onClick={() => onBy(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="hm-toolbar">
        <div className="segmented">
          {SHOW.map(([k, label]) => (
            <button key={k} type="button" className={`segmented-btn${show === k ? ' is-active' : ''}`} onClick={() => setShow(k)}>
              {MARKED.includes(k as WorkKey) ? <i className={`mk mk-${k}`} /> : null}
              {label}
            </button>
          ))}
        </div>
        <div className="hm-legend" aria-hidden>
          Less
          {[0, 1, 2, 3, 4, 5].map((l) => (
            <i key={l} className="hm-cell" data-l={l} />
          ))}
          More
          {marks.map((k) => (
            <span key={k} className="hm-mark-key">
              <i className={`mk mk-${k}`} /> {WORK[k].many}
            </span>
          ))}
        </div>
      </div>
      <div className="hm-stats">
        <div>
          <span className="hm-stat-value">{total}</span>
          <span className="hm-stat-label">{show === 'all' ? 'pieces of work' : showLabel.toLowerCase()}</span>
        </div>
        <div>
          <span className="hm-stat-value">
            {working}
            <span className="text-tertiary"> / {agents.filter((a) => a.active).length}</span>
          </span>
          <span className="hm-stat-label">QA agents with any</span>
        </div>
        <div>
          <span className="hm-stat-value">{total && peak >= 0 ? colTotal[peak] : '—'}</span>
          <span className="hm-stat-label">
            busiest {by}
            {total && peak >= 0 ? `: ${cols[peak].title}` : ''}
          </span>
        </div>
      </div>
      {loading ? <div className="card-body skeleton" style={{ height: 160 }} /> : null}
      {!loading && cols.length === 0 ? <Empty title="No work in this period yet" /> : null}
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
                  <td key={c.key} title={`${c.title}: ${colTotal[i]}`}>
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
                    const n = count(b, keys)
                    const lines = ALL.filter((k) => b?.[k]).map((k) => phrase(b![k], k))
                    const opens = count(b, ALL) > 0 && (!onlyOpen || onlyOpen === a.qa_id)
                    return (
                      <td
                        key={c.key}
                        className={`hm-cell${opens ? ' is-clickable' : ''}`}
                        data-l={level(n, most)}
                        title={`${a.name} · ${c.title}\n${lines.length ? lines.join('\n') : 'Nothing'}${opens ? '\nClick to see each one' : ''}`}
                        onClick={() => (opens ? setOpen({ agent: a, col: c }) : undefined)}
                      >
                        {n || ''}
                        {b && marks.some((k) => b[k]) ? (
                          <span className="hm-marks">
                            {marks
                              .filter((k) => b[k])
                              .map((k) => (
                                <i key={k} className={`mk mk-${k}`} />
                              ))}
                          </span>
                        ) : null}
                      </td>
                    )
                  })}
                  <td className="hm-total">
                    <span className="hm-total-bar">
                      <i style={{ width: `${((agentTotal.get(a.qa_id) ?? 0) / maxAgent) * 100}%` }} />
                    </span>
                    {agentTotal.get(a.qa_id) ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? (
        <WorkModal
          agent={open.agent}
          col={open.col}
          end={nextBucket(open.col.key, by)}
          sameDay={by === 'hour' || by === 'day'}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  )
}

/** Everything one QA agent did in one cell, in order, each opening the audit or coaching it was. */
function WorkModal({ agent, col, end, sameDay, onClose }: { agent: Agent; col: Col; end: string; sameDay: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const items = useApi(() => api.qaWork({ qa_id: agent.qa_id, start: col.key, end }), [agent.qa_id, col.key, end])
  const rows = items.data ?? []
  const kinds = ALL.map((k) => [k, rows.filter((r) => r.type === k).length] as const).filter(([, n]) => n)
  return (
    <Modal
      title={agent.name}
      subtitle={`${col.title}${rows.length ? ` · ${kinds.map(([k, n]) => phrase(n, k)).join(' · ')}` : ''}`}
      size="lg"
      onClose={onClose}
    >
      {items.error ? <div className="inline-warning">{items.error}</div> : null}
      {items.loading && !items.data ? <div className="skeleton" style={{ height: 120 }} /> : null}
      {rows.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>What</th>
                <th>Agent</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((it, i) => {
                const to = it.task_id ? `/tasks/${it.task_id}` : it.coaching_id ? '/coaching' : null
                return (
                  <tr key={i} className={to ? 'is-clickable' : undefined} onClick={() => (to ? navigate(to) : undefined)}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                      {sameDay ? it.at.slice(11, 16) : clock(it.at, false)}
                    </td>
                    <td>
                      <span className="work-tag">
                        <i className={`mk mk-${it.type}`} />
                        {WORK[it.type as WorkKey]?.one ?? it.type}
                      </span>
                      {it.type_name ? (
                        <div className="text-tertiary" style={{ fontSize: 12 }}>
                          {it.type_name}
                        </div>
                      ) : null}
                    </td>
                    <td>{it.agent || '—'}</td>
                    <td className="dispute-text">
                      {it.score !== null ? (
                        <ScoreBadge score={it.score} result={it.result} critical={it.critical_failed} />
                      ) : (
                        it.note || '—'
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{to ? <ChevronRight size={16} className="text-tertiary" /> : null}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  )
}
