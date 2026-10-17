import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Award, ClipboardCheck, Megaphone, Target } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Coaching } from '../api/types'
import { initials, useAuth } from '../auth/AuthContext'
import {
  AckBadge,
  DateRangePicker,
  Empty,
  fmtDate,
  KindBadge,
  Labels,
  Pager,
  rangeFor,
  ScoreBadge,
  type DateRange,
} from '../components/bits'
import { ByLabelCard, pct, ScoreTrendCard, WeakestMetricsCard } from '../components/ReportCards'
import { ExportButton } from '../components/ExportButton'
import { StatCard } from '../components/StatCard'

/** One agent's analysis, for QA agents and supervisors: scores, weak points, escalations and coaching. */
export function AgentPage() {
  const { agentId = '' } = useParams()
  const navigate = useNavigate()
  const qaBlind = useAuth().user?.role === 'qa_agent' // only supervisors know who audited
  const [range, setRange] = useState<DateRange>(() => rangeFor('this_month'))
  const [page, setPage] = useState(1)
  const period = { employee_id: agentId, from: range.from, to: range.to }
  const info = useApi(() => api.agent(agentId), [agentId])
  const rep = useApi(() => api.reports(period), [agentId, range.from, range.to])
  const audits = useApi(() => api.tasks({ ...period, kind: 'audits', state: 'completed', page }), [agentId, range.from, range.to, page])
  const escalations = useApi(() => api.tasks({ ...period, kind: 'escalations', state: 'completed' }), [agentId, range.from, range.to])
  const coaching = useApi(() => api.coachings({ employee_id: agentId }), [agentId])
  const a = info.data
  const r = rep.data
  const esc = escalations.data?.tasks ?? []
  const p = a?.profile ?? {}

  if (info.error) return <div className="page inline-warning">{info.error}</div>

  return (
    <div className="page profile">
      <button
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() => (window.history.state?.idx ? navigate(-1) : navigate('/agents'))}
      >
        <ArrowLeft size={15} />
        Back
      </button>
      <section className="card profile-head">
        <div className="profile-avatar" aria-hidden>
          {initials(a?.name ?? '')}
        </div>
        <div className="profile-who">
          <h1 className="profile-name">
            {a?.name ?? '…'}
            {a?.alias_name ? <span className="text-tertiary"> · known as {a.alias_name}</span> : null}
            {a && !a.active ? (
              <span className="badge badge-gray" style={{ marginLeft: 8 }}>
                inactive
              </span>
            ) : null}
          </h1>
          <div className="text-secondary">
            {[p.job_title, a?.team, p.department, p.supervisor ? `Supervisor: ${p.supervisor}` : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span style={{ marginLeft: 'auto' }}>
          <ExportButton params={() => ({ ids: agentId, from: range.from, to: range.to })} />
        </span>
      </section>

      <DateRangePicker
        value={range}
        presets={['this_week', 'last_week', 'this_month', 'last_month', 'last_30']}
        onChange={(x) => {
          setRange(x)
          setPage(1)
        }}
      />

      {rep.error ? <div className="inline-warning">{rep.error}</div> : null}
      <div className={`report-body dash-stack${rep.loading && r ? ' is-stale' : ''}`}>
        <div className="stat-grid" style={{ margin: 0 }}>
          <StatCard
            label="Average score"
            value={pct(r?.totals.avg_score)}
            icon={<Target size={18} />}
            tone="brand"
            hint={`${r?.totals.critical_fails ?? 0} critical fail${r?.totals.critical_fails === 1 ? '' : 's'}`}
          />
          <StatCard
            label="Audits"
            value={r?.totals.evaluations ?? '—'}
            icon={<ClipboardCheck size={18} />}
            tone="brand"
            hint={`${r?.totals.disputed ?? 0} disputed · ${r?.totals.unacknowledged ?? 0} not acknowledged`}
          />
          <StatCard
            label="Pass rate"
            value={pct(r?.totals.pass_rate)}
            icon={<Award size={18} />}
            tone="success"
            hint={`${pct(r?.totals.borderline_rate)} borderline · ${pct(r?.totals.fail_rate)} fail`}
          />
          <StatCard
            label="Valid escalations"
            value={escalations.data?.total ?? '—'}
            icon={<Megaphone size={18} />}
            tone={escalations.data?.total ? 'warning' : 'brand'}
            hint={`${esc.filter((t) => t.kind === 'negative').length} negatives · not in the score`}
          />
        </div>

        <div className="dash-grid">
          <ScoreTrendCard data={r?.trend ?? []} />
          <WeakestMetricsCard metrics={r?.metrics ?? []} />
        </div>

        <div className="dash-grid">
          <ByLabelCard byLabel={r?.by_label ?? []} />
          <section className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">Valid escalations</h2>
                <p className="card-subtitle">Negatives, team leader and QA escalations found to be the agent's mistake.</p>
              </div>
            </div>
            {esc.length === 0 && !escalations.loading ? <Empty title="None in this period" /> : null}
            <ul className="attention-list dash-scroll">
              {esc.map((t) => (
                <li key={t.id} className="is-clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                  <KindBadge kind={t.kind} />
                  <span className="attention-what">
                    <strong className="dispute-text">{t.note}</strong>
                    <span className="text-tertiary">
                      {fmtDate(t.work_date)} · {t.external_id}
                      {t.finding ? ` · ${t.finding}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Audits</h2>
              <p className="card-subtitle">Sample, live and supervisor escalation audits in this period, newest first.</p>
            </div>
          </div>
          {(audits.data?.tasks ?? []).length === 0 && !audits.loading ? <Empty title="No audits in this period" /> : null}
          {(audits.data?.tasks ?? []).length ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Worked</th>
                    <th>Task type</th>
                    <th>Code / tag</th>
                    <th>Score</th>
                    <th>Agent's answer</th>
                    {qaBlind ? null : <th>QA</th>}
                  </tr>
                </thead>
                <tbody>
                  {(audits.data?.tasks ?? []).map((t) => (
                    <tr key={t.id} className="is-clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                      <td>{fmtDate(t.work_date)}</td>
                      <td>
                        {t.task_type_name} <KindBadge kind={t.kind} />
                      </td>
                      <td>
                        <Labels labels={t.labels} />
                      </td>
                      <td>
                        <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                      </td>
                      <td>
                        <AckBadge status={t.ack_status} hidden={!t.revealed_at} />
                      </td>
                      {qaBlind ? null : <td>{t.qa_name ?? '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <Pager page={page} total={audits.data?.total ?? 0} size={audits.data?.page_size ?? 50} onPage={setPage} />
        </section>

        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Coaching sessions</h2>
              <p className="card-subtitle">Every session, newest first.</p>
            </div>
          </div>
          {(coaching.data ?? []).length === 0 && !coaching.loading ? <Empty title="No coaching yet" /> : null}
          <ul className="attention-list">
            {(coaching.data ?? []).map((c: Coaching) => (
              <li key={c.id}>
                <span className="badge badge-purple">{c.kind === 'refresher' ? 'refresher' : 'coaching'}</span>
                <span className="attention-what">
                  <strong>{c.topic || `${c.task_ids.length} linked audit(s)`}</strong>
                  <span className="text-tertiary">
                    {c.qa_name} ·{' '}
                    {c.status === 'done' ? fmtDate(c.completed_at) : `open${c.due_date ? `, due ${fmtDate(c.due_date)}` : ''}`}
                    {c.notes ? ` · ${c.notes}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
