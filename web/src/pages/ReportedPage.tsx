import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, Plus } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Kind, Role, TaskRow } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { Empty, errorText, fmtDate, fmtDateTime, KindBadge, ScoreBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'

/** An escalation someone raises about an agent; it is checked, then marked Valid or Not valid. */
export interface ReportKind {
  kind: Kind
  path: string
  role: Role
  reportTitle: string
  reporterSubtitle: string
  agentLabel: string
  errorLabel: string
  errorPlaceholder: string
  mineTitle: string
  /** Who checks it, e.g. "a QA agent of the Calls team". */
  sendTo: (team: string) => string
}

const qaOf = (team: string) => `a QA agent of the ${team || 'agent’s'} team`

export const NEGATIVES: ReportKind = {
  kind: 'negative',
  path: '/negatives',
  role: 'negative_agent',
  reportTitle: 'Report a negative',
  reporterSubtitle: "A QA agent of the agent's team checks it and marks it valid (the agent's mistake) or not valid.",
  agentLabel: 'Agent who caused the negative review',
  errorLabel: 'The error the agent made',
  errorPlaceholder: 'What happened, and what the customer said in the review',
  mineTitle: 'What I reported',
  sendTo: qaOf,
}

export const TL_ESCALATIONS: ReportKind = {
  kind: 'tl_escalation',
  path: '/tl-escalations',
  role: 'team_leader',
  reportTitle: 'Escalate an interaction',
  reporterSubtitle:
    "For an order or call of any agent, in any team. A QA agent of their team checks it and marks it valid (the agent's mistake) or not valid.",
  agentLabel: 'Agent',
  errorLabel: 'What happened',
  errorPlaceholder: 'What the agent did, and why it needs a look',
  mineTitle: 'My escalations',
  sendTo: qaOf,
}

export const QA_ESCALATIONS: ReportKind = {
  kind: 'qa_escalation',
  path: '/qa-escalations',
  role: 'qa_agent',
  reportTitle: 'QA escalation',
  reporterSubtitle: "The agent's supervisor checks it and marks it valid or not valid.",
  agentLabel: 'Agent',
  errorLabel: 'What happened',
  errorPlaceholder: 'What the agent did, and why it needs a look',
  mineTitle: 'Raised by me',
  sendTo: (team) => `the ${team} supervisor`,
}

/** The reporter's page: the form, then what they sent. */
export function ReportedPage({ cfg }: { cfg: ReportKind }) {
  const { user } = useAuth()
  return user?.role === cfg.role ? <ReporterPage cfg={cfg} /> : <EscalationsPage />
}

/** Where an escalation stands, in words. */
function ReportStatus({ t }: { t: TaskRow }) {
  switch (t.state) {
    case 'review':
      return (
        <span className="badge badge-warning">
          {t.kind === 'qa_escalation' ? 'with the supervisor' : t.qa_name ? `being checked: ${t.qa_name}` : 'waiting to be checked'}
        </span>
      )
    case 'ready':
    case 'assigned':
      return <span className="badge badge-brand">with QA{t.qa_name ? `: ${t.qa_name}` : ''}</span>
    case 'cancelled':
      return <span className="badge badge-gray">not valid</span>
    case 'completed':
      return t.score === null ? (
        <span className="badge badge-error">valid</span>
      ) : (
        <span className="neg-audited">
          audited <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
        </span>
      )
  }
  return null
}

export function ReportForm({ cfg, onSent, onCancel }: { cfg: ReportKind; onSent: (msg: string) => void; onCancel?: () => void }) {
  const agents = useApi(() => api.reportAgents(cfg.path), [cfg.path])
  const [f, setF] = useState({
    external_id: '',
    employee_id: '',
    task_type_id: '',
    error: '',
  })
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
      const r = await api.report(cfg.path, {
        external_id: f.external_id.trim(),
        employee_id: f.employee_id,
        error: f.error.trim(),
        task_type_id: typeId,
      })
      onSent(`Sent: ${agent?.name}, ${f.external_id.trim()}. It goes to ${cfg.sendTo(agent?.team ?? '')} (${r.task_type}).`)
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
            <option value="">{agents.data && agents.data.length === 0 ? 'No agents yet' : 'Pick the agent…'}</option>
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
            Goes to {cfg.sendTo(agent.team)}, as {agent.types[0].name}.
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
          Send
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
                  <th style={{ width: '36%' }}>{cfg.errorLabel}</th>
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
                      {t.finding ? <div className="text-tertiary dispute-text">{t.finding}</div> : null}
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

type Tab = 'review' | 'valid' | 'not_valid' | 'raised'

const TABS: [Tab, string, string][] = [
  ['review', 'To check', "Check each one, then mark it Valid (the agent's mistake: it goes on their profile) or Not valid."],
  ['valid', 'Valid', "The agent's mistake. Shown on the agent's profile; it doesn't change their quality score."],
  ['not_valid', 'Not valid', "Checked and found not to be the agent's mistake."],
  ['raised', 'Raised by me', 'QA escalations you raised. The supervisor decides them.'],
]

const SOURCES: [Kind, string][] = [
  ['negative', 'Negatives'],
  ['tl_escalation', 'Team leaders'],
  ['qa_escalation', 'QA agents'],
]

/** Escalations (negatives, team leader and QA escalations): QA agents check
 * them, supervisors decide QA escalations and keep an eye on the rest. */
export function EscalationsPage() {
  const { user } = useAuth()
  const qa = user?.role === 'qa_agent'
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('review')
  const [source, setSource] = useState('')
  const [mine, setMine] = useState(qa)
  const [page, setPage] = useState(1)
  const [raising, setRaising] = useState(false)
  const { toasts, push } = useToasts()
  const params = tab === 'raised' ? { raised: 1, state: 'all', page } : { state: tab, source, mine: mine ? 1 : undefined, page }
  const list = useApi(() => api.escalations(params), [tab, source, mine, page], { pollMs: 60_000 })
  const waiting = useApi(() => api.escalations({ state: 'review', mine: qa ? 1 : undefined }), [qa], { pollMs: 60_000 })
  const rows = list.data?.tasks ?? []
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.page_size ?? 50)))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Escalations</h1>
          <p className="page-subtitle">Negatives, team leader and QA escalations. They don't change quality scores.</p>
        </div>
        {qa ? (
          <div className="page-actions">
            <button className="btn btn-secondary" onClick={() => setRaising(true)}>
              <Plus size={16} />
              QA escalation
            </button>
          </div>
        ) : null}
      </div>
      <div className="tabs" role="tablist">
        {TABS.filter(([key]) => qa || key !== 'raised').map(([key, label]) => (
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
          {tab !== 'raised' ? (
            <div className="page-actions">
              {qa && tab === 'review' ? (
                <label className="field-inline">
                  <input
                    type="checkbox"
                    checked={mine}
                    onChange={(e) => {
                      setMine(e.target.checked)
                      setPage(1)
                    }}
                  />
                  Assigned to me
                </label>
              ) : null}
              <select
                className="select"
                style={{ width: 180 }}
                aria-label="Source"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value)
                  setPage(1)
                }}
              >
                <option value="">All sources</option>
                {SOURCES.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        {rows.length === 0 && !list.loading ? <Empty title={tab === 'review' ? 'Nothing to check' : 'None here'} /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Order / call</th>
                  <th style={{ width: '34%' }}>What happened</th>
                  <th>Raised by</th>
                  <th>{tab === 'review' ? 'Checker' : tab === 'raised' ? 'Status' : 'Finding'}</th>
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
                      <KindBadge kind={t.kind} /> {t.reported_by || '—'}
                      <div className="text-tertiary" style={{ fontSize: 12 }}>
                        {fmtDateTime(t.created_at)}
                      </div>
                    </td>
                    <td className="dispute-text">
                      {tab === 'review' ? (
                        t.kind === 'qa_escalation' ? (
                          'Supervisor'
                        ) : (
                          t.qa_name || <span className="text-tertiary">nobody yet</span>
                        )
                      ) : tab === 'raised' ? (
                        <ReportStatus t={t} />
                      ) : (
                        t.finding || '—'
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
      {raising ? (
        <RaiseQAEscalation
          onClose={() => setRaising(false)}
          onSent={(msg) => {
            setRaising(false)
            push('success', msg)
            setTab('raised')
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

/** The QA escalation form in a dialog (Escalations page and the workspace). */
export function RaiseQAEscalation({ onClose, onSent }: { onClose: () => void; onSent: (msg: string) => void }) {
  return (
    <Modal title="QA escalation" subtitle={QA_ESCALATIONS.reporterSubtitle} size="lg" onClose={onClose}>
      <ReportForm cfg={QA_ESCALATIONS} onCancel={onClose} onSent={onSent} />
    </Modal>
  )
}
