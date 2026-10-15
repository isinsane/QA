import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Award, ClipboardCheck, MessageSquareWarning, Target, X } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { DateRangePicker, Empty, fmtDate, Labels, rangeFor, ScoreBadge, type DateRange } from '../components/bits'
import { StatCard } from '../components/StatCard'
import { KIND_LABEL } from '../scorecard'

const axisProps = {
  stroke: 'var(--viz-axis)',
  tick: { fill: 'var(--text-tertiary)', fontSize: 11 },
  tickLine: false,
} as const

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`)

type Tab = 'quality' | 'agents' | 'operations' | 'calibration'

/** A bar with the value next to it, for tables of percentages. */
function Bar({ value }: { value: number | null }) {
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

export function DashboardPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<DateRange>(() => rangeFor('this_month'))
  const [g, setG] = useState({ task_type_id: '', employee_id: '' })
  const f = { ...g, from: range.from, to: range.to }
  const [employeeName, setEmployeeName] = useState('')
  const [tab, setTab] = useState<Tab>('quality')
  const types = useApi(() => api.taskTypes(), [])
  const rep = useApi(() => api.reports(f), [JSON.stringify(f)])
  const r = rep.data

  const activity = useMemo(() => {
    const byQA = new Map<string, { evaluations: number; days: number }>()
    for (const a of r?.qa_activity ?? []) {
      const cur = byQA.get(a.qa_name) ?? { evaluations: 0, days: 0 }
      byQA.set(a.qa_name, { evaluations: cur.evaluations + a.evaluations, days: cur.days + 1 })
    }
    return [...byQA.entries()].sort((a, b) => b[1].evaluations - a[1].evaluations)
  }, [r])

  const trend = (r?.trend ?? []).map((t) => ({ ...t, label: `wk ${fmtDate(t.week).replace(/, \d{4}$/, '')}` }))
  const flagged = (r?.kinds ?? []).find((k) => k.kind === 'live')?.flagged ?? 0
  const tabs: [Tab, string][] = [
    ['quality', 'Quality'],
    ['agents', `Agents${r ? ` (${(r.employees ?? []).length})` : ''}`],
    ['operations', 'Operations'],
    ['calibration', 'QA calibration'],
  ]

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Quality by the day the work was done.</p>
        </div>
        <select
          className="select"
          style={{ width: 'auto', minWidth: 200 }}
          value={g.task_type_id}
          onChange={(e) => setG({ ...g, task_type_id: e.target.value })}
          aria-label="Task type"
        >
          <option value="">All task types</option>
          {(types.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      <div className="dash-filters">
        <DateRangePicker
          value={range}
          presets={['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_30']}
          onChange={setRange}
        />
        {g.employee_id ? (
          <button className="filter-chip active" onClick={() => setG({ ...g, employee_id: '' })}>
            Agent: {employeeName} <X size={12} />
          </button>
        ) : null}
      </div>

      {rep.error ? <div className="inline-warning">{rep.error}</div> : null}
      <div className={`report-body dash-stack${rep.loading && r ? ' is-stale' : ''}`}>
        <div className="stat-grid" style={{ margin: 0 }}>
          <StatCard
            label="Evaluations"
            value={r?.totals.evaluations ?? '—'}
            icon={<ClipboardCheck size={18} />}
            tone="brand"
            hint={`${(r?.employees ?? []).length} agent${(r?.employees ?? []).length === 1 ? '' : 's'} audited`}
          />
          <StatCard
            label="Average score"
            value={pct(r?.totals.avg_score)}
            icon={<Target size={18} />}
            tone="brand"
            hint={`${r?.totals.critical_fails ?? 0} critical fail${r?.totals.critical_fails === 1 ? '' : 's'}`}
          />
          <StatCard
            label="Pass rate"
            value={pct(r?.totals.pass_rate)}
            icon={<Award size={18} />}
            tone="success"
            hint={`${pct(r?.totals.borderline_rate)} borderline · ${pct(r?.totals.fail_rate)} fail`}
          />
          <StatCard
            label="Disputed"
            value={r?.totals.disputed ?? '—'}
            icon={<MessageSquareWarning size={18} />}
            tone={r?.totals.disputed ? 'warning' : 'brand'}
            hint={`${r?.totals.unacknowledged ?? 0} not acknowledged yet`}
          />
        </div>

        <div className="tabs" role="tablist" style={{ margin: 0 }}>
          {tabs.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'quality' ? (
          <>
            <div className="dash-grid">
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

              <section className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Metrics, weakest first</h2>
                    <p className="card-subtitle">Share of points earned; "zero" counts answers that earned nothing.</p>
                  </div>
                </div>
                {(r?.metrics ?? []).length === 0 ? <Empty title="No scored metrics yet" /> : null}
                <ul className="outcome-list dash-scroll">
                  {(r?.metrics ?? []).map((m) => (
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
            </div>

            <div className="dash-grid">
              <section className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">By disposition code / tag</h2>
                    <p className="card-subtitle">Lowest average first shows where agents struggle.</p>
                  </div>
                </div>
                {(r?.by_label ?? []).length === 0 ? <Empty title="Nothing scored yet" /> : null}
                {(r?.by_label ?? []).length ? (
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
                        {[...(r?.by_label ?? [])]
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

              <section className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Failed audits</h2>
                    <p className="card-subtitle">{(r?.failed ?? []).length} in this range. Click one to open it.</p>
                  </div>
                </div>
                {(r?.failed ?? []).length === 0 ? <Empty title="No failed audits in this range" /> : null}
                {(r?.failed ?? []).length ? (
                  <div className="table-scroll dash-scroll">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th>Code / tags</th>
                          <th>Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(r?.failed ?? []).map((t) => (
                          <tr key={t.id} className="is-clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                            <td>
                              <strong>{t.employee_name}</strong>
                              <div className="text-tertiary" style={{ fontSize: 12 }}>
                                {fmtDate(t.work_date)} · {t.task_type_name} · {t.qa_name}
                              </div>
                            </td>
                            <td>
                              <Labels labels={t.labels} />
                            </td>
                            <td>
                              <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </section>
            </div>
          </>
        ) : null}

        {tab === 'agents' ? (
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Agents</h2>
                <p className="card-subtitle">Lowest average first. Click an agent to filter the whole dashboard to them.</p>
              </div>
            </div>
            {(r?.employees ?? []).length === 0 ? <Empty title="No evaluations yet" /> : null}
            {(r?.employees ?? []).length > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th style={{ width: 110 }}>Evaluations</th>
                      <th style={{ width: 220 }}>Average</th>
                      <th style={{ width: 220 }}>Pass rate</th>
                      <th style={{ width: 110 }}>Borderline</th>
                      <th style={{ width: 110 }}>Critical fails</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r?.employees ?? []).map((e) => (
                      <tr
                        key={e.employee_id}
                        className={`is-clickable${g.employee_id === e.employee_id ? ' is-picked' : ''}`}
                        onClick={() => {
                          setEmployeeName(e.name)
                          setG({ ...g, employee_id: e.employee_id })
                          setTab('quality')
                        }}
                      >
                        <td>
                          <strong>{e.name}</strong>
                        </td>
                        <td>{e.evaluations}</td>
                        <td>
                          <Bar value={e.avg_score} />
                        </td>
                        <td>
                          <Bar value={e.pass_rate} />
                        </td>
                        <td>{pct(e.borderline_rate)}</td>
                        <td>{e.critical_fails ? <span className="badge badge-error">{e.critical_fails}</span> : <span className="text-tertiary">0</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}

        {tab === 'operations' ? (
          <>
            <div className="kind-grid">
              {(r?.kinds ?? []).map((k) => (
                <div className="card kind-tile" key={k.kind}>
                  <span className="stat-label">{KIND_LABEL[k.kind]}</span>
                  <strong>{k.evaluations}</strong>
                  <span className="text-tertiary">
                    done · {k.open} open
                    {k.kind === 'live' && flagged ? <span className="badge badge-error" style={{ marginLeft: 6 }}>{flagged} no call found</span> : null}
                  </span>
                </div>
              ))}
            </div>

            <section className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Queue status</h2>
                  <p className="card-subtitle">Everything imported for work done in this range, by where it stands now.</p>
                </div>
              </div>
              {(r?.queue ?? []).length === 0 ? <Empty title="Nothing imported in this range" /> : null}
              {(r?.queue ?? []).length ? (
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Task type</th>
                        <th>Imported</th>
                        <th>Not sampled</th>
                        <th>Waiting for QA</th>
                        <th>In QA queues</th>
                        <th>Evaluated</th>
                        <th>Cancelled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(r?.queue ?? []).map((q) => (
                        <tr key={q.task_type_id}>
                          <td>
                            <strong>{q.task_type_name}</strong>
                          </td>
                          <td>{q.imported}</td>
                          <td className="text-tertiary">{q.unsampled}</td>
                          <td>{q.ready ? <span className="badge badge-warning">{q.ready}</span> : 0}</td>
                          <td>{q.assigned}</td>
                          <td>{q.completed}</td>
                          <td className="text-tertiary">{q.cancelled}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>

            <section className="card">
              <div className="card-header">
                <h2 className="card-title">QA activity</h2>
              </div>
              {activity.length === 0 ? <Empty title="No evaluations in this range" /> : null}
              {activity.length ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>QA agent</th>
                      <th>Evaluations</th>
                      <th>Days active</th>
                      <th>Per active day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map(([name, a]) => (
                      <tr key={name}>
                        <td>
                          <strong>{name}</strong>
                        </td>
                        <td>{a.evaluations}</td>
                        <td>{a.days}</td>
                        <td>{(a.evaluations / a.days).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          </>
        ) : null}

        {tab === 'calibration' ? (
          (r?.calibration.qa ?? []).length === 0 ? (
            <section className="card">
              <Empty title="No rotation cases scored by two QA agents yet">Turn rotation on for a task type on Task types.</Empty>
            </section>
          ) : (
            <div className="dash-grid">
              <section className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Per QA agent</h2>
                    <p className="card-subtitle">
                      Lean is how far above (+, more lenient) or below (−, stricter) their colleague a QA agent scores on average.
                    </p>
                  </div>
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>QA agent</th>
                      <th>Cases</th>
                      <th>Average gap</th>
                      <th>Lean</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r?.calibration.qa ?? []).map((q) => (
                      <tr key={q.qa_name}>
                        <td>
                          <strong>{q.qa_name}</strong>
                        </td>
                        <td>{q.reviews}</td>
                        <td>{q.avg_gap} pts</td>
                        <td>
                          <span className={`badge ${Math.abs(q.avg_lean) >= 10 ? 'badge-warning' : 'badge-gray'}`}>
                            {q.avg_lean > 0 ? `+${q.avg_lean}` : q.avg_lean}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="card">
                <div className="card-header">
                  <div>
                    <h2 className="card-title">Cases</h2>
                    <p className="card-subtitle">Each case scored blind by two QA agents.</p>
                  </div>
                </div>
                <div className="table-scroll dash-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Case</th>
                        <th>First</th>
                        <th>Second</th>
                        <th>Gap</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(r?.calibration.pairs ?? []).map((p) => (
                        <tr key={p.case_id} className="is-clickable" onClick={() => navigate(`/tasks/${p.case_id}`)}>
                          <td>
                            <strong>{p.employee_name}</strong>
                            <div className="text-tertiary" style={{ fontSize: 12 }}>
                              {fmtDate(p.work_date)} · {p.task_type_name}
                            </div>
                          </td>
                          <td>
                            {p.first_qa}: {p.first_score ?? '—'}%
                          </td>
                          <td>
                            {p.second_qa}: {p.second_score ?? '—'}%
                          </td>
                          <td>
                            <strong>{p.gap ?? '—'}</strong>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )
        ) : null}
      </div>
    </div>
  )
}
