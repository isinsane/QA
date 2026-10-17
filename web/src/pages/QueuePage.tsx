import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Crosshair, Megaphone, Radio, ThumbsDown } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Coaching } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { auditedUnder, Empty, errorText, fmtDate, KindBadge, Labels, ScoreBadge } from '../components/bits'
import { AgentSearch } from '../components/AgentSearch'
import { FocusPlanDialog } from '../components/FocusPlanDialog'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'
import { RaiseQAEscalation } from './ReportedPage'
import { TaskView } from './TaskPage'

/** The QA agent's workspace: their queue on the left, the open audit on the right, each scrolling on its own. */
export function QueuePage() {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const queue = useApi(() => api.myQueue(), [], { pollMs: 30_000 })
  const coachings = useApi(() => api.coachings(), [])
  const disputes = useApi(() => api.myDisputes(), [], { pollMs: 60_000 })
  // Negatives assigned to them: top priority, above everything else.
  const negatives = useApi(() => api.escalations({ state: 'review', source: 'negative' }), [], { pollMs: 30_000 })
  const negList = negatives.data?.tasks ?? []
  const { toasts, push } = useToasts()
  // Their open focus plans: those audits come before the normal queue.
  const plans = useApi(() => api.focusPlans({ status: 'open' }), [], { pollMs: 60_000 })
  const [pane, setPane] = useState<'queue' | 'focus' | 'disputes' | 'coaching'>('queue')
  const [dialog, setDialog] = useState<'live' | 'focus' | 'escalate' | Coaching | null>(null)
  const all = queue.data ?? []
  const focusList = all.filter((t) => t.kind === 'focus')
  const list = all.filter((t) => t.kind !== 'focus')
  const locked = focusList.length > 0
  const openCoaching = (coachings.data ?? []).filter((c) => c.status === 'open')
  const disputeList = disputes.data ?? []

  // Focus audits open: show them first (the queue waits until they're done).
  useEffect(() => {
    if (locked) setPane((p) => (p === 'queue' ? 'focus' : p))
  }, [locked])

  // Land on the first audit when nothing is open yet: a focus audit first.
  const first = (focusList[0] ?? list[0])?.id
  useEffect(() => {
    if (!taskId && first) navigate(`/queue/${first}`, { replace: true })
  }, [taskId, first, navigate])

  return (
    <div className="ws">
      <aside className="card ws-side">
        <div className="ws-side-head">
          <div className="segmented ws-switch" role="tablist">
            {(
              [
                ['queue', 'Queue', list.length, 'badge-brand'],
                ['focus', 'Focus', focusList.length, 'badge-purple'],
                ['disputes', 'Disputes', disputeList.length, 'badge-error'],
                ['coaching', 'Coaching', openCoaching.length, 'badge-purple'],
              ] as const
            ).map(([key, label, n, tone]) => (
              <button
                key={key}
                role="tab"
                aria-selected={pane === key}
                className={`segmented-btn${pane === key ? ' is-active' : ''}`}
                onClick={() => setPane(key)}
              >
                {label} <span className={`badge ${n ? tone : 'badge-gray'}`}>{n}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ws-side-list">
          {negList.length ? (
            <div className="ws-priority">
              <div className="ws-priority-head">
                <ThumbsDown size={14} />
                Negatives to check first
                <span className="badge badge-error">{negList.length}</span>
              </div>
              {negList.map((t) => (
                <button
                  key={t.id}
                  className={`qa-queue-item${t.id === taskId ? ' active' : ''}`}
                  onClick={() => navigate(`/queue/${t.id}`)}
                >
                  <span className="qa-queue-top">
                    <strong>{t.employee_name}</strong>
                    <span className="text-tertiary">{fmtDate(t.created_at)}</span>
                  </span>
                  <span className="qa-queue-meta dispute-text">{t.note}</span>
                </button>
              ))}
            </div>
          ) : null}
          {pane === 'queue' && locked ? (
            <div className="ws-locked">
              <strong>Finish your focus plan first</strong>
              <span>
                {focusList.length} focus audit{focusList.length === 1 ? '' : 's'} left. Your queue opens again when they're done.
              </span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPane('focus')}>
                Go to Focus
              </button>
            </div>
          ) : pane === 'focus' ? (
            <>
              {focusList.length === 0 ? <Empty title="No focus plan open">Plans you or your supervisor create show up here.</Empty> : null}
              {[...(plans.data ?? []), null].map((p) => {
                const audits = focusList.filter((t) => (p ? t.focus_plan_id === p.id : !(plans.data ?? []).some((x) => x.id === t.focus_plan_id)))
                if (!audits.length) return null
                return (
                  <div key={p?.id ?? 'earlier'} className="ws-plan">
                    <div className="ws-plan-head">
                      <strong>{p ? p.agent_name : 'Earlier focus audits'}</strong>
                      {p ? (
                        <span className="text-tertiary">
                          {p.labels.length ? p.labels.join(', ') : 'any code, at random'} · {p.done} of {p.pulled} done
                        </span>
                      ) : null}
                      {p ? <span className="ws-plan-why">{p.reason}</span> : null}
                    </div>
                    {audits.map((t) => (
                      <button
                        key={t.id}
                        className={`qa-queue-item${t.id === taskId ? ' active' : ''}`}
                        onClick={() => navigate(`/queue/${t.id}`)}
                      >
                        <span className="qa-queue-top">
                          <strong>{t.employee_name}</strong>
                          <span className="text-tertiary">{fmtDate(t.work_date)}</span>
                        </span>
                        <span className="qa-queue-meta">{t.task_type_name}</span>
                        <Labels labels={t.labels} />
                      </button>
                    ))}
                  </div>
                )
              })}
            </>
          ) : pane === 'queue' ? (
            <>
              {list.length === 0 && !queue.loading ? (
                <Empty title="Nothing to audit">
                  {user?.is_available ? 'New audits arrive after each import.' : "You're offline. Go online to receive audits."}
                </Empty>
              ) : null}
              {list.map((t) => (
                <button
                  key={t.id}
                  className={`qa-queue-item${t.id === taskId ? ' active' : ''}`}
                  onClick={() => navigate(`/queue/${t.id}`)}
                >
                  <span className="qa-queue-top">
                    <strong>{t.employee_name}</strong>
                    <span className="text-tertiary">{fmtDate(t.work_date)}</span>
                  </span>
                  <span className="qa-queue-meta">
                    {t.task_type_name}
                    <KindBadge kind={t.kind} match={t.match_status} />
                  </span>
                  <Labels labels={t.labels} />
                </button>
              ))}
            </>
          ) : pane === 'disputes' ? (
            <>
              {disputeList.length === 0 ? <Empty title="No disputes">Disputes your supervisor sends you show up here.</Empty> : null}
              {disputeList.map((t) => (
                <button
                  key={t.id}
                  className={`qa-queue-item${t.id === taskId ? ' active' : ''}`}
                  onClick={() => navigate(`/queue/${t.id}`)}
                >
                  <span className="qa-queue-top">
                    <strong>{t.employee_name}</strong>
                    <span className="text-tertiary">{fmtDate(t.work_date)}</span>
                  </span>
                  <span className="qa-queue-meta">
                    {t.task_type_name}
                    <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                  </span>
                </button>
              ))}
            </>
          ) : (
            <>
              {openCoaching.length === 0 ? <Empty title="No coaching to run">Your supervisor assigns coaching sessions here.</Empty> : null}
              {openCoaching.map((c) => (
                <button key={c.id} className="qa-queue-item" onClick={() => setDialog(c)}>
                  <span className="qa-queue-top">
                    <strong>{c.employee_name}</strong>
                    {c.due_date ? <span className="text-tertiary">due {fmtDate(c.due_date)}</span> : null}
                  </span>
                  <span className="qa-queue-meta">{c.topic || `${c.task_ids.length} linked audit(s)`}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="ws-side-foot">
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('live')}>
            <Radio size={15} />
            Live monitoring
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog('focus')}>
            <Crosshair size={15} />
            Focus plan
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog('escalate')}>
            <Megaphone size={15} />
            QA escalation
          </button>
        </div>
      </aside>

      <div className="ws-main">
        {taskId ? (
          <TaskView
            key={taskId}
            taskId={taskId}
            workspace
            onChanged={() => {
              void disputes.reload()
              void negatives.reload()
            }}
            onDone={(next) => {
              void queue.reload()
              void plans.reload()
              navigate(next ? `/queue/${next}` : '/queue')
            }}
          />
        ) : (
          <section className="card ws-empty">
            <Empty title="Pick an audit">Your queue is on the left. Start live monitoring when you begin listening to a call.</Empty>
          </section>
        )}
      </div>

      {dialog === 'live' ? (
        <LiveDialog
          onClose={() => setDialog(null)}
          onStarted={(id) => {
            setDialog(null)
            void queue.reload()
            navigate(`/queue/${id}`)
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      {dialog === 'focus' ? (
        <FocusPlanDialog
          forQA
          onClose={() => setDialog(null)}
          onCreated={(p) => {
            setDialog(null)
            push(
              'success',
              p.pulled < p.asked ? `Focus plan created: ${p.pulled} of ${p.asked} (all there were)` : `Focus plan created: ${p.pulled} audits`,
            )
            void queue.reload()
            void plans.reload()
            setPane('focus')
            navigate('/queue') // lands on the first focus audit
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      {dialog === 'escalate' ? (
        <RaiseQAEscalation
          onClose={() => setDialog(null)}
          onSent={(msg) => {
            setDialog(null)
            push('success', msg)
          }}
        />
      ) : null}
      {dialog && typeof dialog === 'object' ? (
        <CoachingDialog
          coaching={dialog}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null)
            push('success', 'Coaching recorded')
            void coachings.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

export interface DialogProps {
  onClose: () => void
  onError: (e: string) => void
}

/** Picks one of the team's task types and one of its agents. */
function useTeamPickers(source?: 'sheet') {
  const types = useApi(() => api.taskTypes(), [])
  const agents = useApi(() => api.teamAgents(), [])
  const typeList = (types.data ?? []).filter((t) => t.active && t.source !== 'manual' && (!source || t.source === source))
  // Only the agents the picked type audits: calls agents for calls, sales for sales.
  const agentsFor = (typeId: string) =>
    (agents.data ?? []).filter((a) =>
      auditedUnder(
        typeList.find((t) => t.id === typeId),
        a.department,
      ),
    )
  return { typeList, agentsFor }
}

function LiveDialog({ onClose, onStarted, onError }: DialogProps & { onStarted: (id: string) => void }) {
  const { typeList, agentsFor } = useTeamPickers('sheet')
  const [typeId, setTypeId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [busy, setBusy] = useState(false)
  const type = typeId || typeList[0]?.id || ''
  // Who is on the call is all it takes to start: the call's details are not
  // known yet, so they are filled in on the audit as the call goes.
  const agents = agentsFor(type).map((a) => ({ ...a, team: '', types: [] }))

  return (
    <Modal
      title="Start live monitoring"
      subtitle="The start time is stamped now. When that day's Vonage sheet is uploaded, the audit is linked to the agent's call that started within 20 seconds of it, or flagged."
      size="md"
      onClose={onClose}
      onSubmit={() => {
        setBusy(true)
        api
          .startLive(type, agentId, {})
          .then((r) => onStarted(r.id))
          .catch((err) => onError(errorText(err)))
          .finally(() => setBusy(false))
      }}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !type || !agentId}>
            Start now
          </button>
        </>
      }
    >
      {typeList.length > 1 ? (
        <div className="field">
          <label className="field-label">Type</label>
          <select
            className="select"
            value={type}
            onChange={(e) => {
              setTypeId(e.target.value)
              setAgentId('')
            }}
          >
            {typeList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">Agent on the call</label>
        <AgentSearch agents={agents} value={agentId} label="Agent on the call" onChange={setAgentId} />
      </div>
      <p className="hint-text" style={{ margin: 0 }}>
        Fill in the call's details (who called, the code) on the audit as the call goes, and the order numbers under the scorecard.
        Saving them keeps your answers.
      </p>
    </Modal>
  )
}

export function CoachingDialog({ coaching: c, onClose, onDone, onError }: DialogProps & { coaching: Coaching; onDone: () => void }) {
  const [notes, setNotes] = useState('')
  const [outcome, setOutcome] = useState('')
  return (
    <Modal
      title={`Coaching: ${c.employee_name}`}
      subtitle={`Assigned by ${c.created_by_name ?? 'supervisor'}${c.due_date ? ` · due ${fmtDate(c.due_date)}` : ''}`}
      size="md"
      onClose={onClose}
      onSubmit={() =>
        void api
          .completeCoaching(c.id, notes, outcome)
          .then(onDone)
          .catch((err) => onError(errorText(err)))
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={!notes.trim()}>
            Mark done
          </button>
        </>
      }
    >
      <dl className="kv" style={{ padding: 0 }}>
        <dt>Topic</dt>
        <dd>{c.topic || '—'}</dd>
        <dt>Linked audits</dt>
        <dd>
          {c.task_ids.length
            ? c.task_ids.map((id, i) => (
                <a key={id} href={`/tasks/${id}`} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                  Audit {i + 1}
                </a>
              ))
            : '—'}
        </dd>
      </dl>
      <div className="field">
        <label className="field-label">What was covered</label>
        <textarea className="textarea" rows={5} autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label">Outcome / next steps</label>
        <input className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
      </div>
    </Modal>
  )
}
