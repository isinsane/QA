import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Plus } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { FocusPlan } from '../api/types'
import { useAuth, useReadOnly } from '../auth/AuthContext'
import { Empty, errorText, fmtDate, fmtDateTime, Labels, ScoreBadge } from '../components/bits'
import { FocusPlanDialog } from '../components/FocusPlanDialog'
import { Modal } from '../components/Modal'
import { WeakestMetricsCard } from '../components/ReportCards'
import { ToastStack, useToasts } from '../components/Toasts'

type Status = FocusPlan['status']

const TABS: [Status, string, string][] = [
  ['open', 'Open', 'Being done now. The QA agent does these before their normal queue.'],
  ['done', 'Done', 'Every audit of the plan done.'],
  ['cancelled', 'Cancelled', 'Stopped by a supervisor; audits not done went back to the not-sampled pool.'],
]

const what = (p: FocusPlan) => (p.labels.length ? p.labels.join(', ') : 'Any code, at random')

/** Every focus plan of the team: who planned what for whom and why, and what the audits found. Agents never see any of it. */
export function FocusPlansPage() {
  const { user } = useAuth()
  const plans = !useReadOnly() && (user?.role === 'supervisor' || user?.role === 'admin')
  const [tab, setTab] = useState<Status>('open')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const { toasts, push } = useToasts()
  const list = useApi(() => api.focusPlans({ status: tab, page }), [tab, page], { pollMs: 60_000 })
  const rows = list.data ?? []

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Focus plans</h1>
          <p className="page-subtitle">
            Focus audits of one agent's work, planned by a QA agent or a supervisor. They never count in the agent's scores, and the agent
            never sees them.
          </p>
        </div>
        {plans ? (
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={16} />
              New focus plan
            </button>
          </div>
        ) : null}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab${tab === key ? ' active' : ''}`}
            onClick={() => {
              setTab(key)
              setPage(1)
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="card">
        <div className="card-header">
          <p className="card-subtitle">{TABS.find(([k]) => k === tab)?.[2]}</p>
        </div>
        {rows.length === 0 && !list.loading ? <Empty title="No focus plans here" /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>What</th>
                  <th style={{ width: '28%' }}>Why</th>
                  <th>QA agent</th>
                  <th>Progress</th>
                  <th>Average</th>
                  <th>Planned</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="is-clickable" onClick={() => setOpen(p.id)}>
                    <td>
                      <strong>{p.agent_name}</strong>
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {p.task_type_name} · {fmtDate(p.from_date)} – {fmtDate(p.to_date)}
                      </div>
                    </td>
                    <td className="dispute-text">{what(p)}</td>
                    <td className="dispute-text">{p.reason}</td>
                    <td>{p.qa_name}</td>
                    <td>
                      {p.done} of {p.pulled}
                      {p.pulled < p.asked ? (
                        <div className="text-tertiary" style={{ fontSize: 12 }}>
                          asked {p.asked}
                        </div>
                      ) : null}
                    </td>
                    <td>{p.avg_score === null ? '—' : `${p.avg_score}%`}</td>
                    <td>
                      {fmtDate(p.created_at)}
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        by {p.created_by_name}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={16} className="text-tertiary" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {rows.length === 50 || page > 1 ? (
          <div className="card-foot">
            <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="text-secondary">Page {page}</span>
            <button className="btn btn-secondary btn-sm" disabled={rows.length < 50} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        ) : null}
      </section>
      {creating ? (
        <FocusPlanDialog
          forQA={false}
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false)
            push(
              'success',
              `Focus plan created for ${p.pulled} audit${p.pulled === 1 ? '' : 's'}${p.pulled < p.asked ? ` (all there were of ${p.asked})` : ''}`,
            )
            setTab('open')
            void list.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      {open ? (
        <PlanDialog
          id={open}
          canCancel={plans}
          onClose={() => setOpen(null)}
          onCancelled={() => {
            setOpen(null)
            push('success', 'Focus plan cancelled')
            void list.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

/** One plan: what and why, what its audits found, and each audit. */
function PlanDialog({
  id,
  canCancel,
  onClose,
  onCancelled,
  onError,
}: {
  id: string
  canCancel: boolean
  onClose: () => void
  onCancelled: () => void
  onError: (e: string) => void
}) {
  const navigate = useNavigate()
  const d = useApi(() => api.focusPlan(id), [id])
  const [cancelling, setCancelling] = useState(false)
  const [reason, setReason] = useState('')
  const p = d.data?.plan
  const r = d.data?.results
  return (
    <Modal
      title={p ? `${p.agent_name}: focus plan` : 'Focus plan'}
      subtitle={p ? `${what(p)} · ${p.task_type_name} · work of ${fmtDate(p.from_date)} – ${fmtDate(p.to_date)}` : undefined}
      size="lg"
      onClose={onClose}
      onSubmit={
        cancelling
          ? () =>
              void api
                .cancelFocusPlan(id, reason)
                .then(onCancelled)
                .catch((err) => onError(errorText(err)))
          : undefined
      }
      footer={
        p && canCancel && p.status === 'open' ? (
          cancelling ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setCancelling(false)}>
                Keep it
              </button>
              <button type="submit" className="btn btn-danger" disabled={!reason.trim()}>
                Cancel the plan
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setCancelling(true)}>
              Cancel plan…
            </button>
          )
        ) : undefined
      }
    >
      {d.error ? <div className="inline-warning">{d.error}</div> : null}
      {!p ? <div className="skeleton" style={{ height: 160 }} /> : null}
      {p ? (
        <div className="form-grid">
          <dl className="kv">
            <dt>Why</dt>
            <dd>{p.reason}</dd>
            <dt>QA agent</dt>
            <dd>{p.qa_name}</dd>
            <dt>Planned</dt>
            <dd>
              {fmtDateTime(p.created_at)} by {p.created_by_name}
            </dd>
            <dt>Progress</dt>
            <dd>
              {p.done} of {p.pulled} done{p.pulled < p.asked ? ` (asked ${p.asked}; that was all there was)` : ''}
              {p.status === 'cancelled' ? ` · cancelled ${fmtDate(p.closed_at)}: ${p.cancel_reason}` : ''}
              {p.status === 'done' ? ` · finished ${fmtDate(p.closed_at)}` : ''}
            </dd>
            {r && p.done ? (
              <>
                <dt>Results</dt>
                <dd>
                  {p.avg_score}% average · {r.pass} pass · {r.borderline} borderline · {r.fail} fail
                </dd>
              </>
            ) : null}
          </dl>
          {cancelling ? (
            <div className="field">
              <label className="field-label">Why cancel it? The audits not done go back to the not-sampled pool.</label>
              <textarea className="textarea" rows={2} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          ) : null}
          {p.done && d.data?.metrics.length ? <WeakestMetricsCard metrics={d.data.metrics} /> : null}
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Worked</th>
                  <th>Code / tag</th>
                  <th>Score</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(d.data?.audits ?? []).map((t) => (
                  <tr key={t.id} className="is-clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                    <td>{fmtDate(t.work_date)}</td>
                    <td>
                      <Labels labels={t.labels} />
                    </td>
                    <td>
                      {t.state === 'completed' ? (
                        <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                      ) : t.state === 'cancelled' ? (
                        <span className="badge badge-gray">can't audit</span>
                      ) : (
                        <span className="badge badge-brand">to do</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={16} className="text-tertiary" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Modal>
  )
}
