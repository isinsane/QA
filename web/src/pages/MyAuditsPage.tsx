import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { DateRange } from '../components/bits'
import { AckBadge, DateRangePicker, Empty, fmtDate, KindBadge, Pager, rangeFor, ScoreBadge } from '../components/bits'

const SHOW: [string, string][] = [
  ['completed', 'All submitted'],
  ['pass', 'Passed'],
  ['borderline', 'Borderline'],
  ['fail', 'Failed'],
  ['disputed', 'Disputed'],
  ['change_pending', 'Change waiting for approval'],
]

/** A QA agent's own submitted audits (or their whole team's). Open one of theirs to edit it: notes save at once, score changes go to a supervisor. */
export function MyAuditsPage() {
  const navigate = useNavigate()
  const [range, setRange] = useState<DateRange>(() => rangeFor('this_month'))
  const [state, setState] = useState('completed')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [team, setTeam] = useState(false)
  const list = useApi(
    () => api.tasks({ ...(team ? { team: 1 } : { mine: 1 }), state, q, from: range.from, to: range.to, page }),
    [team, state, q, range.from, range.to, page],
  )
  const rows = list.data?.tasks ?? []

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">My audits</h1>
          <p className="page-subtitle">
            {team
              ? 'Every audit of your team, by any QA agent. You can edit only your own.'
              : 'Everything you submitted. Open one to edit it: notes save at once; a change to the score goes to a supervisor for approval.'}
          </p>
        </div>
        <div className="segmented">
          {[false, true].map((v) => (
            <button
              key={String(v)}
              type="button"
              className={`segmented-btn${team === v ? ' is-active' : ''}`}
              onClick={() => {
                setTeam(v)
                setPage(1)
              }}
            >
              {v ? 'My team' : 'Mine'}
            </button>
          ))}
        </div>
      </div>
      <DateRangePicker
        value={range}
        presets={['this_week', 'last_week', 'this_month', 'last_month', 'all']}
        onChange={(r) => {
          setRange(r)
          setPage(1)
        }}
      />
      <section className="card">
        <div className="card-header">
          <input
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Agent, interaction / ticket ID or order number"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
          />
          <select
            className="select"
            style={{ width: 240 }}
            aria-label="Show"
            value={state}
            onChange={(e) => {
              setState(e.target.value)
              setPage(1)
            }}
          >
            {SHOW.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {rows.length === 0 && !list.loading ? <Empty title="No audits here" /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Interaction</th>
                  <th>Worked</th>
                  <th>Score</th>
                  <th>Agent's answer</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="is-clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                    <td>
                      <strong>{t.employee_name}</strong>
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {t.task_type_name} <KindBadge kind={t.kind} />
                      </div>
                    </td>
                    <td className="mono">{t.external_id}</td>
                    <td>{fmtDate(t.work_date)}</td>
                    <td>
                      <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                      {t.change_pending ? (
                        <span className="badge badge-warning" style={{ marginLeft: 6 }}>
                          change waiting
                        </span>
                      ) : null}
                    </td>
                    <td>{t.kind === 'sample' || t.kind === 'live' || t.kind === 'escalation' ? <AckBadge status={t.ack_status} /> : null}</td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={16} className="text-tertiary" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <Pager page={page} total={list.data?.total ?? 0} size={list.data?.page_size ?? 50} onPage={setPage} />
      </section>
    </div>
  )
}
