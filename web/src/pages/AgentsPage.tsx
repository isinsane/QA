import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { DateRangePicker, Empty, fmtDate, rangeFor, type DateRange } from '../components/bits'
import { ExportButton } from '../components/ExportButton'
import { Bar, pct } from '../components/ReportCards'

/** Every active agent in every team, with their numbers for the period; open one for the full analysis. */
export function AgentsPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<DateRange>(() => rangeFor('this_month'))
  const [q, setQ] = useState('')
  const [team, setTeam] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const list = useApi(() => api.agents({ from: range.from, to: range.to }), [range.from, range.to])
  const all = list.data?.agents ?? []
  const teams = [...new Set(all.map((a) => a.team || 'No team'))].sort()
  const needle = q.trim().toLowerCase()
  const rows = all.filter(
    (a) =>
      (!team || (a.team || 'No team') === team) &&
      (!needle || a.name.toLowerCase().includes(needle) || a.alias_name.toLowerCase().includes(needle)),
  )

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Agents</h1>
          <p className="page-subtitle">Every agent in every team. Open one for their scores, weak points, escalations and coaching.</p>
        </div>
        <div className="page-actions">
          <ExportButton
            label={picked.size ? `Export ${picked.size} picked` : `Export ${rows.length === all.length ? 'all' : rows.length} to Excel`}
            params={() => ({
              ids: picked.size ? [...picked].join(',') : rows.length === all.length ? undefined : rows.map((a) => a.id).join(','),
              from: range.from,
              to: range.to,
            })}
          />
        </div>
      </div>
      <DateRangePicker value={range} presets={['this_week', 'last_week', 'this_month', 'last_month', 'last_30']} onChange={setRange} />
      <section className="card">
        <div className="card-header">
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Search by name or alias"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select className="select" style={{ width: 220 }} aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        {rows.length === 0 && !list.loading ? <Empty title="No agents match" /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      aria-label="Pick all shown"
                      checked={rows.length > 0 && rows.every((a) => picked.has(a.id))}
                      onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((a) => a.id)) : new Set())}
                    />
                  </th>
                  <th>Agent</th>
                  <th>Team</th>
                  <th style={{ width: 90 }}>Audits</th>
                  <th style={{ width: 200 }}>Average</th>
                  <th style={{ width: 200 }}>Pass rate</th>
                  <th style={{ width: 110 }}>Escalations</th>
                  <th>Last audit</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="is-clickable" onClick={() => navigate(`/agents/${a.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Pick ${a.name}`}
                        checked={picked.has(a.id)}
                        onChange={() =>
                          setPicked((prev) => {
                            const next = new Set(prev)
                            if (!next.delete(a.id)) next.add(a.id)
                            return next
                          })
                        }
                      />
                    </td>
                    <td>
                      <strong>{a.name}</strong>
                      {a.alias_name ? (
                        <div className="text-tertiary" style={{ fontSize: 12 }}>
                          {a.alias_name}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {a.team || '—'}
                      {a.hr_department ? (
                        <div className="text-tertiary" style={{ fontSize: 12 }}>
                          {a.hr_department}
                        </div>
                      ) : null}
                    </td>
                    <td>{a.evaluations}</td>
                    <td>{a.evaluations ? <Bar value={a.avg_score} /> : <span className="text-tertiary">—</span>}</td>
                    <td>{a.evaluations ? <Bar value={a.pass_rate} /> : <span className="text-tertiary">{pct(null)}</span>}</td>
                    <td>
                      {a.escalations ? (
                        <span className="badge badge-error">{a.escalations}</span>
                      ) : (
                        <span className="text-tertiary">0</span>
                      )}
                    </td>
                    <td>{fmtDate(a.last_audit)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={16} className="text-tertiary" />
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
