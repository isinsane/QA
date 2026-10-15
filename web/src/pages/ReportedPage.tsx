import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Plus } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Kind, Role, TaskRow } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { Empty, errorText, fmtDate, fmtDateTime, ScoreBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'

/** Work reported by someone outside QA, reviewed by the agent's supervisor. */
export interface ReportKind {
  kind: Kind
  path: string
  role: Role
  title: string
  reportTitle: string
  reportButton: string
  reporterSubtitle: string
  managerSubtitle: string
  agentLabel: string
  errorLabel: string
  errorPlaceholder: string
  mineTitle: string
  confirmLabel: string
}

export const NEGATIVES: ReportKind = {
  kind: 'negative',
  path: '/negatives',
  role: 'negative_agent',
  title: 'Negatives',
  reportTitle: 'Report a negative',
  reportButton: 'Report a negative',
  reporterSubtitle: "The agent's supervisor checks it, then confirms it or sends it to a QA agent to audit.",
  managerSubtitle: "Negative reviews reported against your agents. They don't change quality scores.",
  agentLabel: 'Agent who caused the negative review',
  errorLabel: 'The error the agent made',
  errorPlaceholder: 'What happened, and what the customer said in the review',
  mineTitle: 'What I reported',
  confirmLabel: 'Confirm negative',
}

export const TL_ESCALATIONS: ReportKind = {
  kind: 'tl_escalation',
  path: '/tl-escalations',
  role: 'team_leader',
  title: 'Team leader escalations',
  reportTitle: 'Escalate an interaction',
  reportButton: 'New escalation',
  reporterSubtitle: 'For an order or call of an agent on your team. Your supervisor checks it, then confirms it or sends it to a QA agent to audit.',
  managerSubtitle: "Interactions your team leaders escalated. They don't change quality scores.",
  agentLabel: 'Agent',
  errorLabel: 'What happened',
  errorPlaceholder: 'What the agent did, and why it needs a look',
  mineTitle: 'My escalations',
  confirmLabel: 'Confirm escalation',
}

/** The reporter sees the form and what they sent; supervisors and admins review. */
export function ReportedPage({ cfg }: { cfg: ReportKind }) {
  const { user } = useAuth()
  return user?.role === cfg.role ? <ReporterPage cfg={cfg} /> : <ReviewPage cfg={cfg} />
}

/** Where a report stands, in words. */
function ReportStatus({ t }: { t: TaskRow }) {
  switch (t.state) {
    case 'review':
      return <span className="badge badge-warning">with the supervisor</span>
    case 'ready':
    case 'assigned':
      return <span className="badge badge-brand">with QA{t.qa_name ? `: ${t.qa_name}` : ''}</span>
    case 'cancelled':
      return <span className="badge badge-gray">dismissed</span>
    case 'completed':
      return t.score === null ? (
        <span className="badge badge-error">confirmed</span>
      ) : (
        <span className="neg-audited">
          audited <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
        </span>
      )
  }
  return null
}

function ReportForm({ cfg, onSent, onCancel }: { cfg: ReportKind; onSent: (msg: string) => void; onCancel?: () => void }) {
  const agents = useApi(() => api.reportAgents(cfg.path), [cfg.path])
  const [f, setF] = useState({ external_id: '', employee_id: '', task_type_id: '', error: '' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const agent = (agents.data ?? []).find((a) => a.id === f.employee_id)
  const teams = [...new Set((agents.data ?? []).map((a) => a.team || 'No team'))].sort()
  const typeId = f.task_type_id || agent?.types[0]?.id || ''
  const ready = f.external_id.trim() && agent && agent.types.length > 0 && f.error.trim()

  async function send() {
    setBusy(true)
    setProblem('')
    try {
      const r = await api.report(cfg.path, { external_id: f.external_id.trim(), employee_id: f.employee_id, error: f.error.trim(), task_type_id: typeId })
      onSent(`Sent: ${agent?.name}, ${f.external_id.trim()}. It goes to the ${agent?.team} supervisor (${r.task_type}).`)
      setF({ external_id: '', employee_id: '', task_type_id: '', error: '' })
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="form-grid"
      style={{ gap: 18 }}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) void send()
      }}
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Order number / call ID</label>
          <input className="input mono" autoFocus value={f.external_id} onChange={(e) => setF({ ...f, external_id: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">{cfg.agentLabel}</label>
          <select className="select" value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value, task_type_id: '' })}>
            <option value="">{agents.data && agents.data.length === 0 ? 'No agents on your team' : 'Pick the agent…'}</option>
            {teams.map((team) => (
              <optgroup key={team} label={team}>
                {(agents.data ?? [])
                  .filter((a) => (a.team || 'No team') === team)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.alias_name ? ` (${a.alias_name})` : ''}
                      {a.department ? ` · ${a.department}` : ''}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>
      {agent ? (
        agent.types.length === 0 ? (
          <div className="inline-warning" style={{ margin: 0 }}>
            No task type audits {agent.name}'s work yet, so this can't be sent. Ask an admin to set one up.
          </div>
        ) : agent.types.length > 1 ? (
          <div className="field" style={{ maxWidth: 360 }}>
            <label className="field-label">Which work it was about</label>
            <select className="select" value={typeId} onChange={(e) => setF({ ...f, task_type_id: e.target.value })}>
              {agent.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="hint-text" style={{ margin: 0 }}>
            Goes to the {agent.team} supervisor, as {agent.types[0].name}.
          </p>
        )
      ) : null}
      <div className="field">
        <label className="field-label">{cfg.errorLabel}</label>
        <textarea
          className="textarea"
          rows={5}
          maxLength={2000}
          placeholder={cfg.errorPlaceholder}
          value={f.error}
          onChange={(e) => setF({ ...f, error: e.target.value })}
        />
      </div>
      {problem ? (
        <div className="inline-warning" style={{ margin: 0 }}>
          {problem}
        </div>
      ) : null}
      <div className="builder-row" style={{ justifyContent: 'flex-end' }}>
        {onCancel ? (
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          Send to the supervisor
        </button>
      </div>
    </form>
  )
}

/** The reporter's page: the form, then what they sent and where it stands. */
function ReporterPage({ cfg }: { cfg: ReportKind }) {
  const mine = useApi(() => api.myReports(cfg.path), [cfg.path])
  const { toasts, push } = useToasts()
  const rows = mine.data ?? []
  return (
    <div className="page neg-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{cfg.reportTitle}</h1>
          <p className="page-subtitle">{cfg.reporterSubtitle}</p>
        </div>
      </div>
      <section className="card">
        <div className="card-body">
          <ReportForm
            cfg={cfg}
            onSent={(msg) => {
              push('success', msg)
              void mine.reload()
            }}
          />
        </div>
      </section>
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">{cfg.mineTitle}</h2>
        </div>
        {rows.length === 0 && !mine.loading ? <Empty title="Nothing sent yet" /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>Order / call</th>
                  <th>Agent</th>
                  <th style={{ width: '40%' }}>{cfg.errorLabel}</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{fmtDate(t.created_at)}</td>
                    <td className="mono">{t.external_id}</td>
                    <td>{t.employee_name}</td>
                    <td className="dispute-text">{t.note}</td>
                    <td>
                      <ReportStatus t={t} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      <ToastStack toasts={toasts} />
    </div>
  )
}

type Tab = 'review' | 'open' | 'completed' | 'cancelled'

const TABS: [Tab, string, string][] = [
  ['review', 'To review', 'Check each one, then confirm it as reported, send it to a QA agent to audit, or dismiss it.'],
  ['open', 'With QA', 'Sent to a QA agent; it is at the top of their queue.'],
  ['completed', 'Done', 'Confirmed by a supervisor, or audited by QA.'],
  ['cancelled', 'Dismissed', 'Dismissed by the supervisor.'],
]

/** Supervisors and admins: reports about their team's agents. */
function ReviewPage({ cfg }: { cfg: ReportKind }) {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('review')
  const [page, setPage] = useState(1)
  const [reporting, setReporting] = useState(false)
  const { toasts, push } = useToasts()
  const list = useApi(() => api.tasks({ kind: cfg.kind, state: tab, page }), [cfg.kind, tab, page], { pollMs: 60_000 })
  const waiting = useApi(() => api.tasks({ kind: cfg.kind, state: 'review' }), [cfg.kind], { pollMs: 60_000 })
  const rows = list.data?.tasks ?? []
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.page_size ?? 50)))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{cfg.title}</h1>
          <p className="page-subtitle">{cfg.managerSubtitle}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={() => setReporting(true)}>
            <Plus size={16} />
            {cfg.reportButton}
          </button>
        </div>
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
            {key === 'review' && waiting.data?.total ? (
              <span className="badge badge-error" style={{ marginLeft: 8 }}>
                {waiting.data.total}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <section className="card">
        <div className="card-header">
          <p className="card-subtitle">{TABS.find(([k]) => k === tab)?.[2]}</p>
        </div>
        {rows.length === 0 && !list.loading ? <Empty title={tab === 'review' ? 'Nothing to review' : 'None here'} /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Order / call</th>
                  <th style={{ width: '38%' }}>{cfg.errorLabel}</th>
                  <th>Sent by</th>
                  {tab !== 'review' ? <th>Status</th> : null}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="is-clickable" onClick={() => navigate(`/tasks/${t.id}`)}>
                    <td>
                      <strong>{t.employee_name}</strong>
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {t.task_type_name}
                      </div>
                    </td>
                    <td className="mono">{t.external_id}</td>
                    <td className="dispute-text">{t.note}</td>
                    <td>
                      {t.reported_by || '—'}
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {fmtDateTime(t.created_at)}
                      </div>
                    </td>
                    {tab !== 'review' ? (
                      <td>
                        <ReportStatus t={t} />
                      </td>
                    ) : null}
                    <td style={{ textAlign: 'right' }}>
                      <ChevronRight size={16} className="text-tertiary" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {pages > 1 ? (
          <div className="card-foot">
            <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span className="text-secondary">
              Page {page} of {pages}
            </span>
            <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        ) : null}
      </section>
      {reporting ? (
        <Modal title={cfg.reportTitle} subtitle="It goes to the agent's supervisor for review." size="lg" onClose={() => setReporting(false)}>
          <ReportForm
            cfg={cfg}
            onCancel={() => setReporting(false)}
            onSent={(msg) => {
              setReporting(false)
              push('success', msg)
              void list.reload()
              void waiting.reload()
            }}
          />
        </Modal>
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}
