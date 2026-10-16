import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Crosshair, Megaphone, Radio } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Coaching } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { auditedUnder, daysAgo, Empty, errorText, fmtDate, KindBadge, Labels, localDate, ScoreBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'
import { RaiseQAEscalation } from './ReportedPage'
import { LiveFieldInputs, TaskView } from './TaskPage'

/** The QA agent's workspace: their queue on the left, the open audit on the right, each scrolling on its own. */
export function QueuePage() {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const queue = useApi(() => api.myQueue(), [], { pollMs: 30_000 })
  const coachings = useApi(() => api.coachings(), [])
  const disputes = useApi(() => api.myDisputes(), [], { pollMs: 60_000 })
  const { toasts, push } = useToasts()
  const [pane, setPane] = useState<'queue' | 'disputes' | 'coaching'>('queue')
  const [dialog, setDialog] = useState<'live' | 'focus' | 'escalate' | Coaching | null>(null)
  const list = queue.data ?? []
  const openCoaching = (coachings.data ?? []).filter((c) => c.status === 'open')
  const disputeList = disputes.data ?? []

  // Land on the first audit when nothing is open yet.
  const first = list[0]?.id
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
          {pane === 'queue' ? (
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
            onChanged={() => void disputes.reload()}
            onDone={(next) => {
              void queue.reload()
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
        <FocusDialog
          onClose={() => setDialog(null)}
          onPulled={(n) => {
            setDialog(null)
            push('success', `${n} interaction(s) added to your queue`)
            void queue.reload()
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
  const [details, setDetails] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const type = typeId || typeList[0]?.id || ''
  const fields = useApi(() => (type ? api.liveFields(type) : Promise.resolve(null)), [type])
  const f = fields.data
  const missing = (f?.fields ?? []).filter((k) => !(f?.optional ?? [f?.label]).includes(k) && !details[k]?.trim())

  return (
    <Modal
      title="Start live monitoring"
      subtitle="The start time is stamped now. When that day's Vonage sheet is uploaded, the audit is linked to the agent's call that started within 20 seconds of it, or flagged."
      size="md"
      onClose={onClose}
      onSubmit={() => {
        setBusy(true)
        api
          .startLive(type, agentId, details)
          .then((r) => onStarted(r.id))
          .catch((err) => onError(errorText(err)))
          .finally(() => setBusy(false))
      }}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !type || !agentId || !f || missing.length > 0}>
            Start now
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Type</label>
          <select
            className="select"
            value={type}
            onChange={(e) => {
              setTypeId(e.target.value)
              setAgentId('')
              setDetails({})
            }}
          >
            {typeList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Agent on the call</label>
          <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Pick the agent…</option>
            {agentsFor(type).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.alias_name ? ` (${a.alias_name})` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      {f ? (
        <>
          <div className="form-section" style={{ margin: 0 }}>
            The call, as Vonage shows it
          </div>
          <LiveFieldInputs taskTypeId={type} fields={f.fields} label={f.label} optional={f.optional} value={details} onChange={setDetails} />
          <p className="hint-text">Everything except the code is required. You can still correct these while the audit is in your queue.</p>
        </>
      ) : null}
    </Modal>
  )
}

function FocusDialog({ onClose, onPulled, onError }: DialogProps & { onPulled: (n: number) => void }) {
  const { typeList, agentsFor } = useTeamPickers()
  const [f, setF] = useState({ type: '', agent: '', from: daysAgo(7), to: localDate(new Date()), label: '', count: 5 })
  const type = f.type || typeList[0]?.id || ''
  const labels = useApi(
    () => (type && f.agent ? api.focusLabels({ task_type_id: type, employee_id: f.agent, from: f.from, to: f.to }) : Promise.resolve([])),
    [type, f.agent, f.from, f.to],
  )
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }))

  return (
    <Modal
      title="Focus plan"
      subtitle="Pull several not-yet-audited interactions of one agent, all with the same tag or code, into your queue. Focus-plan audits don't count in the agent's scores."
      size="md"
      onClose={onClose}
      onSubmit={() => {
        setBusy(true)
        api
          .focusPlan({ task_type_id: type, employee_id: f.agent, label: f.label, count: f.count, from: f.from, to: f.to })
          .then((r) => onPulled(r.pulled))
          .catch((err) => onError(errorText(err)))
          .finally(() => setBusy(false))
      }}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !type || !f.agent || !f.label}>
            Pull into my queue
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Type</label>
          <select className="select" value={type} onChange={(e) => set({ type: e.target.value, label: '' })}>
            {typeList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Agent</label>
          <select className="select" value={f.agent} onChange={(e) => set({ agent: e.target.value, label: '' })}>
            <option value="">Pick the agent…</option>
            {agentsFor(type).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">From</label>
          <input className="input" type="date" value={f.from} onChange={(e) => set({ from: e.target.value, label: '' })} />
        </div>
        <div className="field">
          <label className="field-label">To</label>
          <input className="input" type="date" value={f.to} onChange={(e) => set({ to: e.target.value, label: '' })} />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">Tag / code</label>
          <select className="select" value={f.label} onChange={(e) => set({ label: e.target.value })} disabled={!f.agent}>
            <option value="">
              {f.agent ? (labels.data?.length ? 'Pick one…' : 'Nothing left to audit in this range') : 'Pick an agent first'}
            </option>
            {(labels.data ?? []).map((l) => (
              <option key={l.label} value={l.label}>
                {l.label} ({l.rows} available)
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">How many</label>
          <input
            className="input"
            type="number"
            min={1}
            max={50}
            value={f.count}
            onChange={(e) => set({ count: Number(e.target.value) })}
          />
        </div>
      </div>
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
