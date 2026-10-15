import { useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Coaching } from '../api/types'
import { daysAgo, Empty, errorText, fmtDate, ScoreBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'

/** Supervisors assign coaching to a QA agent and follow it to the agent's acknowledgement. */
export function CoachingPage() {
  const list = useApi(() => api.coachings(), [])
  const { toasts, push } = useToasts()
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<Coaching | null>(null)
  const rows = list.data ?? []

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Coaching</h1>
          <p className="page-subtitle">Assign a coaching on a topic or on specific audits; the QA agent runs it and the agent acknowledges it.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            New coaching
          </button>
        </div>
      </div>
      <section className="card">
        {rows.length === 0 && !list.loading ? <Empty title="No coaching yet" /> : null}
        {rows.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Topic / audits</th>
                  <th>QA agent</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="is-clickable" onClick={() => setOpen(c)}>
                    <td>
                      <strong>{c.employee_name}</strong>
                    </td>
                    <td>
                      {c.topic}
                      {c.task_ids.length ? <span className="text-tertiary"> {c.topic ? '· ' : ''}{c.task_ids.length} audit(s)</span> : null}
                    </td>
                    <td>{c.qa_name}</td>
                    <td>{fmtDate(c.due_date)}</td>
                    <td>
                      {c.status === 'open' ? (
                        <span className="badge badge-gray">open</span>
                      ) : c.ack_at ? (
                        <span className="badge badge-success">done · acknowledged</span>
                      ) : (
                        <span className="badge badge-brand">done · awaiting agent</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {creating ? (
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
      {open ? (
        <Modal
          title={`Coaching: ${open.employee_name}`}
          subtitle={`Run by ${open.qa_name}${open.due_date ? ` · due ${fmtDate(open.due_date)}` : ''}`}
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
            <dd>{open.ack_at ? `Acknowledged ${fmtDate(open.ack_at)}${open.ack_comment ? `: "${open.ack_comment}"` : ''}` : 'Not acknowledged yet'}</dd>
          </dl>
        </Modal>
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

function NewCoaching({ onClose, onCreated, onError }: { onClose: () => void; onCreated: () => void; onError: (e: string) => void }) {
  const agents = useApi(() => api.users('employee'), [])
  const qas = useApi(() => api.users('qa_agent'), [])
  const [f, setF] = useState({ agent: '', topic: '', qa: '', due: '', tasks: [] as string[] })
  const agent = (agents.data ?? []).find((a) => a.id === f.agent)
  const audits = useApi(
    () => (f.agent ? api.tasks({ state: 'completed', employee_id: f.agent, from: daysAgo(60) }) : Promise.resolve(null)),
    [f.agent],
  )
  const teamQAs = (qas.data ?? []).filter((q) => q.active && (!agent || q.department_id === agent.department_id))
  const toggle = (id: string) =>
    setF((prev) => ({ ...prev, tasks: prev.tasks.includes(id) ? prev.tasks.filter((x) => x !== id) : [...prev.tasks, id] }))

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
      {f.agent ? (
        <div className="field">
          <label className="field-label">
            Link audits from the last 60 days {f.tasks.length ? `· ${f.tasks.length} selected` : ''}
          </label>
          {(audits.data?.tasks ?? []).length === 0 ? (
            <span className="text-tertiary">No evaluated audits for this agent.</span>
          ) : (
            <div className="check-list">
              {(audits.data?.tasks ?? []).map((t) => (
                <label key={t.id}>
                  <input type="checkbox" checked={f.tasks.includes(t.id)} onChange={() => toggle(t.id)} />
                  <span style={{ flex: 1 }}>
                    {fmtDate(t.work_date)} · {t.task_type_name} · <span className="text-secondary">{t.labels.join(', ') || 'no code/tag'}</span>
                  </span>
                  <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                </label>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  )
}
