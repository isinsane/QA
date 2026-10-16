import { useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Coaching } from '../api/types'
import { useAuth, useReadOnly } from '../auth/AuthContext'
import { daysAgo, Empty, errorText, fmtDate, KindBadge, ScoreBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'
import { CoachingDialog } from './QueuePage'

const KIND: Record<Coaching['kind'], string> = { coaching: 'Coaching', refresher: 'Refresher' }

const SHOW: [string, string, (c: Coaching) => boolean][] = [
  ['all', 'All sessions', () => true],
  ['open', 'Open', (c) => c.status === 'open'],
  ['assigned', 'Assigned by a supervisor', (c) => !c.logged],
  ['logged', 'Logged by QA', (c) => c.logged],
  ['refresher', 'Refresher sessions', (c) => c.kind === 'refresher'],
]

function Status({ c }: { c: Coaching }) {
  if (c.status === 'open') return <span className="badge badge-gray">open</span>
  if (c.logged) return <span className="badge badge-purple">logged by QA</span>
  return c.ack_at ? (
    <span className="badge badge-success">done · acknowledged</span>
  ) : (
    <span className="badge badge-brand">done · awaiting agent</span>
  )
}

/** Supervisors assign coaching and follow it; QA agents run what they're
 * given and log sessions they already held (no acknowledgement needed). */
export function CoachingPage() {
  const { user } = useAuth()
  const qa = user?.role === 'qa_agent'
  const readOnly = useReadOnly()
  const list = useApi(() => api.coachings(), [])
  const { toasts, push } = useToasts()
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<Coaching | null>(null)
  const [show, setShow] = useState('all')
  const rows = (list.data ?? []).filter(SHOW.find(([k]) => k === show)?.[2] ?? (() => true))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Coaching</h1>
          <p className="page-subtitle">
            {qa
              ? 'Sessions you run. Log one you already held with New session; linking audits is optional.'
              : 'Assign a coaching on a topic or on specific audits; the QA agent runs it and the agent acknowledges it. Sessions QA agents logged show here too.'}
          </p>
        </div>
        <div className="page-actions">
          {readOnly ? null : (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={16} />
              {qa ? 'New session' : 'New coaching'}
            </button>
          )}
        </div>
      </div>
      <section className="card">
        <div className="card-header">
          <select className="select" style={{ width: 240 }} aria-label="Show" value={show} onChange={(e) => setShow(e.target.value)}>
            {SHOW.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {rows.length === 0 && !list.loading ? <Empty title="No sessions here" /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Type</th>
                  <th>Topic / audits</th>
                  {qa ? null : <th>QA agent</th>}
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="is-clickable" onClick={() => setOpen(c)}>
                    <td>
                      <strong>{c.employee_name}</strong>
                    </td>
                    <td>{KIND[c.kind] ?? c.kind}</td>
                    <td>
                      {c.topic}
                      {c.task_ids.length ? (
                        <span className="text-tertiary">
                          {' '}
                          {c.topic ? '· ' : ''}
                          {c.task_ids.length} audit(s)
                        </span>
                      ) : null}
                    </td>
                    {qa ? null : <td>{c.qa_name}</td>}
                    <td>{c.status === 'done' ? fmtDate(c.completed_at) : c.due_date ? `due ${fmtDate(c.due_date)}` : '—'}</td>
                    <td>
                      <Status c={c} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {creating && qa ? (
        <LogSession
          onClose={() => setCreating(false)}
          onLogged={() => {
            setCreating(false)
            push('success', 'Session logged')
            void list.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      {creating && !qa ? (
        <NewCoaching
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            push('success', 'Coaching assigned')
            void list.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      {open && qa && open.status === 'open' ? (
        <CoachingDialog
          coaching={open}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null)
            push('success', 'Coaching recorded')
            void list.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : open ? (
        <Modal
          title={`${KIND[open.kind] ?? 'Coaching'}: ${open.employee_name}`}
          subtitle={`${open.logged ? 'Logged' : 'Run'} by ${open.qa_name}${open.due_date ? ` · due ${fmtDate(open.due_date)}` : ''}`}
          size="md"
          onClose={() => setOpen(null)}
          footer={
            <button className="btn btn-secondary" onClick={() => setOpen(null)}>
              Close
            </button>
          }
        >
          <dl className="kv" style={{ padding: 0 }}>
            <dt>Topic</dt>
            <dd>{open.topic || '—'}</dd>
            <dt>Linked audits</dt>
            <dd>
              {open.task_ids.length
                ? open.task_ids.map((id, i) => (
                    <a key={id} href={`/tasks/${id}`} style={{ marginRight: 10 }}>
                      Audit {i + 1}
                    </a>
                  ))
                : '—'}
            </dd>
            <dt>Status</dt>
            <dd>{open.status === 'open' ? 'Open' : `Done ${fmtDate(open.completed_at)}`}</dd>
            <dt>What was covered</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{open.notes || '—'}</dd>
            <dt>Outcome</dt>
            <dd>{open.outcome || '—'}</dd>
            <dt>Agent</dt>
            <dd>
              {open.logged
                ? "Logged by the QA agent; the agent isn't asked to acknowledge it"
                : open.ack_at
                  ? `Acknowledged ${fmtDate(open.ack_at)}${open.ack_comment ? `: "${open.ack_comment}"` : ''}`
                  : 'Not acknowledged yet'}
            </dd>
          </dl>
        </Modal>
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

/** The agent's submitted audits and valid escalations from the last 60 days, to link. */
function AuditPicker({ agentId, picked, onToggle }: { agentId: string; picked: string[]; onToggle: (id: string) => void }) {
  const audits = useApi(() => api.tasks({ state: 'completed', employee_id: agentId, from: daysAgo(60) }), [agentId])
  const rows = audits.data?.tasks ?? []
  return (
    <div className="field">
      <label className="field-label">
        Link audits from the last 60 days (optional) {picked.length ? `· ${picked.length} selected` : ''}
      </label>
      {rows.length === 0 && !audits.loading ? (
        <span className="text-tertiary">Nothing evaluated for this agent.</span>
      ) : (
        <div className="check-list">
          {rows.map((t) => (
            <label key={t.id}>
              <input type="checkbox" checked={picked.includes(t.id)} onChange={() => onToggle(t.id)} />
              <span style={{ flex: 1 }}>
                {fmtDate(t.work_date)} · {t.task_type_name} <KindBadge kind={t.kind} />{' '}
                <span className="text-secondary">
                  {t.kind === 'sample' || t.kind === 'live' ? t.labels.join(', ') || 'no code/tag' : t.note}
                </span>
              </span>
              {t.score !== null ? <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} /> : null}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const toggled = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

/** A QA agent logs a session they already held, with any agent. */
function LogSession({ onClose, onLogged, onError }: { onClose: () => void; onLogged: () => void; onError: (e: string) => void }) {
  const agents = useApi(() => api.reportAgents('/qa-escalations'), [])
  const [f, setF] = useState({ agent: '', kind: 'coaching', topic: '', notes: '', outcome: '', tasks: [] as string[] })
  const teams = [...new Set((agents.data ?? []).map((a) => a.team || 'No team'))].sort()
  const ready = f.agent && f.notes.trim() && (f.topic.trim() || f.tasks.length)

  return (
    <Modal
      title="New session"
      subtitle="A session you already held. It's saved as done; the agent isn't asked to acknowledge it, and supervisors see it."
      size="lg"
      onClose={onClose}
      onSubmit={() =>
        void api
          .logCoaching({ employee_id: f.agent, kind: f.kind, topic: f.topic, task_ids: f.tasks, notes: f.notes, outcome: f.outcome })
          .then(onLogged)
          .catch((err) => onError(errorText(err)))
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            Done
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Agent</label>
          <select className="select" value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value, tasks: [] })}>
            <option value="">Pick the agent…</option>
            {teams.map((team) => (
              <optgroup key={team} label={team}>
                {(agents.data ?? [])
                  .filter((a) => (a.team || 'No team') === team)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.alias_name ? ` (${a.alias_name})` : ''}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Type</label>
          <select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="coaching">Coaching session</option>
            <option value="refresher">Refresher session</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label className="field-label">Topic {f.tasks.length ? '(optional)' : ''}</label>
        <input
          className="input"
          maxLength={200}
          placeholder="e.g. Warranty, call opening"
          value={f.topic}
          onChange={(e) => setF({ ...f, topic: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="field-label">What you did</label>
        <textarea className="textarea" rows={5} maxLength={5000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
      <div className="field">
        <label className="field-label">Outcome / next steps (optional)</label>
        <input className="input" maxLength={2000} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} />
      </div>
      {f.agent ? <AuditPicker agentId={f.agent} picked={f.tasks} onToggle={(id) => setF({ ...f, tasks: toggled(f.tasks, id) })} /> : null}
    </Modal>
  )
}

function NewCoaching({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (e: string) => void }) {
  const agents = useApi(() => api.users('employee'), [])
  const qas = useApi(() => api.users('qa_agent'), [])
  const [f, setF] = useState({ agent: '', topic: '', qa: '', due: '', tasks: [] as string[] })
  const agent = (agents.data ?? []).find((a) => a.id === f.agent)
  const teamQAs = (qas.data ?? []).filter((q) => q.active && (!agent || q.department_id === agent.department_id))

  return (
    <Modal
      title="New coaching"
      subtitle="Give a topic, link audits, or both. The QA agent runs it and the agent acknowledges it."
      size="lg"
      onClose={onClose}
      onSubmit={() =>
        void api
          .createCoaching({ employee_id: f.agent, topic: f.topic, task_ids: f.tasks, assigned_qa_id: f.qa, due_date: f.due })
          .then(onCreated)
          .catch((err) => onError(errorText(err)))
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!f.agent || !f.qa || (!f.topic.trim() && f.tasks.length === 0)}>
            Assign coaching
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Agent</label>
          <select className="select" value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value, tasks: [], qa: '' })}>
            <option value="">Pick the agent…</option>
            {(agents.data ?? [])
              .filter((a) => a.active)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Run by (QA agent)</label>
          <select className="select" value={f.qa} onChange={(e) => setF({ ...f, qa: e.target.value })} disabled={!f.agent}>
            <option value="">{f.agent ? 'Pick a QA agent…' : 'Pick the agent first'}</option>
            {teamQAs.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">Topic (e.g. Warranty)</label>
          <input className="input" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">Due</label>
          <input className="input" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
        </div>
      </div>
      {f.agent ? <AuditPicker agentId={f.agent} picked={f.tasks} onToggle={(id) => setF({ ...f, tasks: toggled(f.tasks, id) })} /> : null}
    </Modal>
  )
}
