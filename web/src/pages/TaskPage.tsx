import { Fragment, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ArrowLeft, Copy, ExternalLink, Pencil, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Answer, Kind, TaskDetail } from '../api/types'
import { AckBadge, errorText, fmtDate, fmtDateTime, KindBadge, Labels, ScoreBadge, StateBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ScorecardForm } from '../components/ScorecardForm'
import { ToastStack, useToasts } from '../components/Toasts'

/** Standalone page: /tasks/:id (managers) and /my-scores/:id (employees). */
export function TaskPage() {
  const { taskId = '' } = useParams()
  const back = useLocation().pathname.startsWith('/my-scores') ? '/my-scores' : '/tasks'
  return (
    <div className="page">
      <Link to={back} className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} />
        Back
      </Link>
      <TaskView taskId={taskId} />
    </div>
  )
}

/** Kinds reported from outside QA and reviewed by the supervisor first. */
const REPORTED: Partial<Record<Kind, { what: string; note: string; confirm: string; noun: string }>> = {
  negative: { what: 'Negative review', note: 'The error', confirm: 'Confirm negative', noun: 'negative' },
  tl_escalation: { what: 'Team leader escalation', note: 'What happened', confirm: 'Confirm escalation', noun: 'escalation' },
}

const ACTION_LABEL: Record<string, string> = {
  assigned: 'Assigned',
  submitted: 'Submitted',
  evaluation_edited: 'Evaluation edited',
  reassigned: 'Reassigned',
  cancelled: 'Cancelled',
  cant_audit: "Couldn't be audited",
  live_started: 'Live monitoring started',
  escalated: 'Escalated by supervisor',
  focus_plan: 'Pulled into a focus plan',
  acknowledged: 'Agent acknowledged',
  disputed: 'Agent disputed',
  dispute_forwarded: 'Dispute sent to the QA agent',
  dispute_upheld: 'Dispute answered: score kept',
  rotation_case: 'Rotation case',
  rotation_second_review: 'Rotation second review',
  negative_reported: 'Negative reported',
  negative_confirmed: 'Negative confirmed by the supervisor',
  tl_escalation_reported: 'Escalated by the team leader',
  tl_escalation_confirmed: 'Escalation confirmed by the supervisor',
}

export function TaskView({
  taskId,
  workspace,
  onDone,
  onChanged,
}: {
  taskId: string
  /** In the QA workspace: the details and the scorecard scroll side by side. */
  workspace?: boolean
  onDone?: (nextId: string | null) => void
  /** After any change (submit, edit, dispute answer), so lists around it refresh. */
  onChanged?: () => void
}) {
  const detail = useApi(() => api.task(taskId), [taskId])
  const { toasts, push } = useToasts()
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const [editing, setEditing] = useState(false)
  const [dialog, setDialog] = useState<'cant' | 'cancel' | 'reassign' | 'edit' | 'ack' | 'dispute' | 'uphold' | 'forward' | 'confirm' | null>(null)
  const [busy, setBusy] = useState(false)
  const d = detail.data

  useEffect(() => {
    const byId: Record<string, Answer> = {}
    for (const a of d?.task.answers ?? []) byId[a.metric_id] = a
    setAnswers(byId)
    setEditing(false)
  }, [d])

  if (detail.error) return <div className="inline-warning">{detail.error}</div>
  if (!d) return <div className="skeleton" style={{ height: 320 }} />

  const t = d.task
  const card = t.scorecard ?? d.task_type.scorecard
  const formOpen = d.can_evaluate || editing
  const list = Object.values(answers)
  const rep = REPORTED[t.kind]
  const forwardNote = [...(d.audit ?? [])].reverse().find((a) => a.action === 'dispute_forwarded')?.detail.reason as string | undefined

  async function act(fn: () => Promise<unknown>, ok: string, next?: (r: unknown) => void) {
    setBusy(true)
    try {
      const r = await fn()
      push('success', ok)
      setDialog(null)
      onChanged?.()
      if (next) next(r)
      else await detail.reload()
    } catch (err) {
      push('error', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={workspace ? 'ws-task' : undefined}>
      <div className="task-head">
        <h1>{d.task_type.name}</h1>
        <StateBadge state={t.state} />
        <KindBadge kind={t.kind} match={t.match_status} />
        {t.state === 'completed' ? <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} /> : null}
        {t.state === 'completed' && (t.kind === 'sample' || t.kind === 'live' || t.kind === 'escalation') ? (
          <AckBadge status={t.ack_status} />
        ) : null}
        <span className="text-secondary">
          {d.employee.name} · worked {fmtDate(t.work_date)}
          {d.qa_name ? ` · QA: ${d.qa_name}` : ''}
        </span>
      </div>
      {t.cancel_reason ? <div className="inline-warning">Cancelled: {t.cancel_reason}</div> : null}
      {t.kind === 'escalation' && t.note ? <div className="inline-warning">Escalated by the supervisor: {t.note}</div> : null}
      {rep ? (
        <div className="inline-warning neg-note">
          <strong>
            {rep.what}
            {d.reported_by ? `, from ${d.reported_by}` : ''}.
          </strong>
          <span>
            {rep.note}: "{t.note}"
          </span>
          {t.state === 'review' && d.can_confirm ? (
            <span>Check it, then confirm it as reported, send it to a QA agent to audit, or dismiss it.</span>
          ) : null}
          {!d.can_confirm && !d.can_manage && !d.can_evaluate && !d.can_edit && !d.reported_by ? (
            <span>For your information: it doesn't change your quality score, and there's nothing to answer.</span>
          ) : null}
        </div>
      ) : null}
      {t.kind === 'focus' ? <div className="inline-note">{t.note || 'Focus plan'}. Doesn't count in the agent's scores.</div> : null}
      {t.kind === 'rotation' ? (
        <div className="inline-note">Rotation case (QA over QA). Doesn't count in the agent's scores; score it as you normally would.</div>
      ) : null}
      {t.kind === 'live' ? (
        <div className={t.match_status === 'flagged' ? 'inline-warning' : 'inline-note'}>
          Live monitoring started {fmtDateTime(t.live_started_at)}.{' '}
          {t.match_status === 'pending'
            ? "It is matched to the call when that day's Vonage sheet is uploaded."
            : t.match_status === 'matched'
              ? 'Matched to the call below (started within 20 seconds).'
              : "Flagged: no call by this agent started within 20 seconds of it in that day's Vonage sheet."}
        </div>
      ) : null}
      {t.ack_status === 'disputed' ? (
        <div className="inline-warning">
          The agent disputes this: "{t.ack_comment}".{' '}
          {d.can_forward
            ? 'Review it, then send it to the QA agent who scored it, keep the score, or edit the evaluation.'
            : d.can_uphold
              ? 'Keep the score with a reply, or edit the evaluation to change it.'
              : 'With the supervisor.'}
        </div>
      ) : null}
      {t.ack_status === 'dispute_qa' ? (
        <div className="inline-warning">
          The agent disputes this: "{t.ack_comment}". The supervisor sent it to {d.qa_name ?? 'the QA agent who scored it'}
          {forwardNote ? `: "${forwardNote}"` : ''}.{' '}
          {d.can_uphold ? 'Keep the score with a reply to the agent, or edit the evaluation to change it.' : 'Waiting for the QA team.'}
        </div>
      ) : null}
      {t.ack_status === 'acknowledged' && t.ack_comment ? <div className="inline-note">Agent's comment: "{t.ack_comment}"</div> : null}
      {t.ack_status === 'upheld' || t.ack_status === 'changed' ? (
        <div className="inline-note">
          Dispute "{t.ack_comment}" answered: {t.ack_status === 'upheld' ? 'score kept' : 'score changed'}
          {t.dispute_resolution ? ` — ${t.dispute_resolution}` : ''}.
        </div>
      ) : null}
      {d.can_ack ? (
        <div className="inline-note">
          Please read your evaluation, then
          <button className="btn btn-primary btn-sm" onClick={() => setDialog('ack')}>
            Acknowledge
          </button>
          or
          <button className="btn btn-secondary btn-sm" onClick={() => setDialog('dispute')}>
            Dispute
          </button>
        </div>
      ) : null}

      <div className="task-layout">
        <div className="task-col form-grid">
          {t.kind === 'live' ? (
            <LiveCard
              detail={d}
              onSaved={() => {
                push('success', 'Call details saved')
                void detail.reload()
              }}
              onError={(e) => push('error', e)}
            />
          ) : null}
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">{d.task_type.source === 'tickets_api' ? 'Ticket' : 'Call'}</h2>
              <CopyID id={t.external_id} label={d.task_type.source === 'tickets_api' ? 'Ticket ID' : 'Interaction ID'} />
            </div>
            <dl className="kv">
              <dt>Agent</dt>
              <dd>
                {d.employee.name}
                {d.employee.agent_code ? <span className="text-tertiary mono"> · {d.employee.agent_code}</span> : null}
              </dd>
              <dt>{d.task_type.source === 'tickets_api' ? 'Tags' : 'Disposition code'}</dt>
              <dd>
                <Labels labels={t.labels} empty={d.task_type.source === 'tickets_api' ? 'no tag' : 'no code'} />
              </dd>
              {d.task_type.source === 'tickets_api' ? <TicketFields data={t.data} /> : <SheetFields data={t.data} columns={d.columns} />}
            </dl>
          </section>
          {d.task_type.source === 'tickets_api' ? <EDeskInfo taskId={t.id} /> : null}
          {d.audit?.length ? (
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">History</h2>
              </div>
              <ul className="audit-list">
                {d.audit.map((a) => (
                  <li key={a.id}>
                    <strong>{ACTION_LABEL[a.action] ?? a.action}</strong>
                    <span className="text-tertiary">
                      {' '}
                      · {a.actor_name ?? 'system'} · {fmtDateTime(a.created_at)}
                    </span>
                    {typeof a.detail.reason === 'string' && a.detail.reason ? (
                      <div className="text-secondary">{a.detail.reason}</div>
                    ) : null}
                    {a.action === 'evaluation_edited' ? (
                      <div className="text-secondary">
                        Score {String((a.detail.before as { score?: number })?.score ?? '—')}% →{' '}
                        {String((a.detail.after as { score?: number })?.score ?? '—')}%
                      </div>
                    ) : null}
                    {typeof a.detail.qa_name === 'string' ? <div className="text-secondary">to {a.detail.qa_name}</div> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="task-col">
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">Scorecard</h2>
              <div className="page-actions">
                {d.can_confirm ? (
                  <button className="btn btn-primary btn-sm" onClick={() => setDialog('confirm')}>
                    {rep?.confirm ?? 'Confirm'}
                  </button>
                ) : null}
                {d.can_manage ? (
                  <>
                    <button className="btn btn-secondary btn-sm" onClick={() => setDialog('reassign')}>
                      {t.state === 'review' ? 'Send to a QA agent' : 'Reassign'}
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setDialog('cancel')}>
                      {rep ? 'Dismiss' : 'Cancel audit'}
                    </button>
                  </>
                ) : null}
                {d.can_forward ? (
                  <button className="btn btn-primary btn-sm" onClick={() => setDialog('forward')}>
                    Send to QA
                  </button>
                ) : null}
                {d.can_uphold ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => setDialog('uphold')}>
                    Keep score
                  </button>
                ) : null}
                {d.can_edit && !editing ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
                    Edit evaluation
                  </button>
                ) : null}
              </div>
            </div>
            {rep && t.state === 'completed' && !t.answers?.length ? (
              <div className="card-body text-secondary">Confirmed by the supervisor as reported; it wasn't audited by QA.</div>
            ) : rep && t.state === 'review' ? (
              <div className="card-body text-secondary">Waiting for the supervisor. If it's sent to a QA agent, they audit it with this scorecard.</div>
            ) : card.length === 0 ? (
              <div className="card-body inline-warning">This task type has no metrics yet. A supervisor adds them on Task types.</div>
            ) : t.state === 'completed' || formOpen ? (
              <ScorecardForm
                card={card}
                answers={answers}
                thresholds={{ pass: d.task_type.pass_threshold, borderline: d.task_type.borderline_threshold ?? 0 }}
                readOnly={!formOpen}
                onChange={setAnswers}
                footer={
                  formOpen ? (
                    d.can_evaluate ? (
                      <>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => setDialog('cant')}>
                          Can't audit
                        </button>
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => api.submit(t.id, list),
                              'Evaluation submitted',
                              (r) => (onDone ? onDone((r as { next_task_id: string | null }).next_task_id) : void detail.reload()),
                            )
                          }
                        >
                          Submit evaluation
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-secondary" onClick={() => void detail.reload()}>
                          Discard
                        </button>
                        <button className="btn btn-primary" disabled={busy} onClick={() => setDialog('edit')}>
                          Save changes
                        </button>
                      </>
                    )
                  ) : null
                }
              />
            ) : (
              <div className="card-body text-secondary">Not evaluated yet.</div>
            )}
          </section>
        </div>
      </div>

      {dialog === 'cant' ? (
        <ReasonDialog
          title="Can't audit this"
          placeholder="e.g. recording not found in Vonage, wrong agent"
          action="Remove from my queue"
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(reason) =>
            void act(
              () => api.cantAudit(t.id, reason),
              'Removed from your queue',
              (r) => (onDone ? onDone((r as { next_task_id: string | null }).next_task_id) : void detail.reload()),
            )
          }
        />
      ) : null}
      {dialog === 'confirm' ? (
        <ReasonDialog
          title={`Confirm this ${rep?.noun ?? 'report'}`}
          placeholder="Note (optional), e.g. listened to the call, the agent gave the wrong ETA"
          action={rep?.confirm ?? 'Confirm'}
          busy={busy}
          optional
          onClose={() => setDialog(null)}
          onSubmit={(note) => void act(() => api.confirmReported(t.id, note), 'Confirmed')}
        />
      ) : null}
      {dialog === 'cancel' ? (
        <ReasonDialog
          title={rep ? `Dismiss this ${rep.noun}` : 'Cancel this audit'}
          placeholder={rep ? "Why it isn't the agent's fault" : 'Why it should not be audited'}
          action={rep ? 'Dismiss' : 'Cancel audit'}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => void act(() => api.cancel(t.id, reason), 'Audit cancelled')}
        />
      ) : null}
      {dialog === 'edit' ? (
        <ReasonDialog
          title="Save edited evaluation"
          placeholder={
            t.ack_status === 'disputed' || t.ack_status === 'dispute_qa' ? 'Reply to the agent (accepts the dispute)' : 'Reason for the change (kept in the history)'
          }
          action="Save"
          busy={busy}
          optional
          onClose={() => setDialog(null)}
          onSubmit={(reason) => void act(() => api.editEvaluation(t.id, list, reason), 'Evaluation updated')}
        />
      ) : null}
      {dialog === 'ack' ? (
        <ReasonDialog
          title="Acknowledge this evaluation"
          placeholder="Comment for your QA team (optional)"
          action="Acknowledge"
          busy={busy}
          optional
          onClose={() => setDialog(null)}
          onSubmit={(c) => void act(() => api.acknowledge(t.id, c), 'Acknowledged')}
        />
      ) : null}
      {dialog === 'dispute' ? (
        <ReasonDialog
          title="Dispute this evaluation"
          placeholder="What do you disagree with, and why?"
          action="Send dispute"
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(c) => void act(() => api.dispute(t.id, c), 'Dispute sent to your supervisor')}
        />
      ) : null}
      {dialog === 'forward' ? (
        <ReasonDialog
          title="Send to the QA agent"
          placeholder={`Note for ${d.qa_name ?? 'the QA agent'} (optional)`}
          action="Send to QA"
          busy={busy}
          optional
          onClose={() => setDialog(null)}
          onSubmit={(note) => void act(() => api.forwardDispute(t.id, note), 'Sent to the QA agent')}
        />
      ) : null}
      {dialog === 'uphold' ? (
        <ReasonDialog
          title="Keep the score"
          placeholder="Reply to the agent: why the score stands"
          action="Keep score"
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(c) => void act(() => api.uphold(t.id, c), 'Dispute answered')}
        />
      ) : null}
      {dialog === 'reassign' ? (
        <ReassignDialog
          detail={d}
          busy={busy}
          onClose={() => setDialog(null)}
          onPick={(qa) => void act(() => api.reassign(t.id, qa), 'Reassigned')}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

function CopyID({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="copy-id">
      <span className="text-tertiary">{label}</span>
      <span className="mono">{id}</span>
      <button
        className="btn btn-secondary btn-sm btn-icon"
        title="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(id).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        <Copy size={14} />
      </button>
      {copied ? <span className="text-tertiary">copied</span> : null}
    </span>
  )
}

function SheetFields({ data, columns }: { data: Record<string, unknown>; columns?: string[] }) {
  const keys = (columns?.length ? columns : Object.keys(data)).filter((k) => k !== 'live_entered')
  return (
    <>
      {keys.map((k) => (
        <FieldRow key={k} label={k} value={data[k]} />
      ))}
    </>
  )
}

function FieldRow({ label, value }: { label: string; value: unknown }) {
  const text =
    value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {/^https?:\/\//.test(text) ? (
          <a href={text} target="_blank" rel="noreferrer">
            {text}
          </a>
        ) : (
          text
        )}
      </dd>
    </>
  )
}

function TicketFields({ data }: { data: Record<string, unknown> }) {
  const channel = (data.channel as { name?: string } | undefined)?.name
  const agents = Array.isArray(data.agents) ? (data.agents as string[]).join(', ') : ''
  return (
    <>
      <FieldRow label="Status" value={data.status} />
      <FieldRow label="Kind" value={data.kind} />
      <FieldRow label="Channel" value={channel} />
      <FieldRow label="Replies that day" value={data.replies_in_range} />
      <FieldRow label="First reply" value={fmtDateTime(data.first_reply as string)} />
      <FieldRow label="Last reply" value={fmtDateTime(data.last_reply as string)} />
      <FieldRow label="Answered by" value={agents} />
      {data.tags_known === false ? <FieldRow label="Tags" value="not known yet (ticket not re-read since tags were kept)" /> : null}
      {typeof data.edesk_url === 'string' ? (
        <>
          <dt />
          <dd>
            <a className="btn btn-secondary btn-sm" href={data.edesk_url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              Open in eDesk
            </a>
          </dd>
        </>
      ) : null}
    </>
  )
}

/** General info from eDesk's own API, fetched on first open and cached. */
function EDeskInfo({ taskId }: { taskId: string }) {
  const [refresh, setRefresh] = useState(0)
  const info = useApi(() => api.taskEDesk(taskId, refresh > 0), [taskId, refresh])
  const d = info.data
  const order = d?.sales_order as
    | {
        seller_order_id?: string
        status?: string
        total_amount?: number
        order_items?: { quantity?: number; product?: { title?: string; sku?: string } }[]
        tracking_codes?: { tracking_code?: string; tracking_carrier_name?: string; tracking_link?: string }[]
      }
    | undefined
  const items = useMemo(
    () =>
      (order?.order_items ?? []).map((i) => `${i.quantity ?? 1} × ${i.product?.title ?? ''} ${i.product?.sku ? `(${i.product.sku})` : ''}`),
    [order],
  )

  return (
    <section className="card">
      <div className="card-header">
        <h2 className="card-title">eDesk</h2>
        <button className="btn btn-ghost btn-sm btn-icon" title="Fetch again" onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw size={14} />
        </button>
      </div>
      {info.error ? <div className="card-body text-secondary">{info.error}</div> : null}
      {!d && !info.error ? <div className="card-body skeleton" style={{ height: 80 }} /> : null}
      {d ? (
        <dl className="kv">
          <FieldRow label="Subject" value={d.subject} />
          <FieldRow label="Type" value={d.type} />
          <FieldRow label="Status" value={d.status} />
          <FieldRow label="AI classification" value={d.ai_classification} />
          <FieldRow label="Total replies" value={d.replies} />
          <FieldRow label="Order" value={order?.seller_order_id} />
          <FieldRow label="Order status" value={order?.status} />
          {items.length ? <FieldRow label="Items" value={items.join('; ')} /> : null}
          {order?.tracking_codes?.length ? (
            <FieldRow
              label="Tracking"
              value={order.tracking_codes.map((c) => `${c.tracking_carrier_name ?? ''} ${c.tracking_code ?? ''}`.trim()).join(', ')}
            />
          ) : null}
          <FieldRow label="Last message" value={d.last_updated_at} />
        </dl>
      ) : null}
    </section>
  )
}

function ReasonDialog({
  title,
  placeholder,
  action,
  busy,
  optional,
  onClose,
  onSubmit,
}: {
  title: string
  placeholder: string
  action: string
  busy: boolean
  optional?: boolean
  onClose: () => void
  onSubmit: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      onSubmit={() => onSubmit(reason.trim())}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Back
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || (!optional && !reason.trim())}>
            {action}
          </button>
        </>
      }
    >
      <textarea
        className="textarea"
        rows={4}
        autoFocus
        placeholder={placeholder}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  )
}

function ReassignDialog({
  detail,
  busy,
  onClose,
  onPick,
}: {
  detail: TaskDetail
  busy: boolean
  onClose: () => void
  onPick: (qaId: string) => void
}) {
  const qas = useApi(() => api.users('qa_agent'), [])
  const options = (qas.data ?? []).filter((u) => u.active && u.department_id === detail.task_type.department_id)
  return (
    <Modal
      title="Reassign to"
      subtitle="QA agents of this team"
      size="sm"
      onClose={onClose}
      footer={
        <button className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      {options.length === 0 && !qas.loading ? <span className="text-secondary">No active QA agents in this team.</span> : null}
      <div className="check-list" style={{ maxHeight: 360 }}>
        {options.map((u) => (
          <button
            key={u.id}
            type="button"
            className="btn btn-ghost"
            style={{ justifyContent: 'space-between', width: '100%' }}
            disabled={busy || u.id === detail.task.assigned_qa_id}
            onClick={() => onPick(u.id)}
          >
            {u.name}
            <span className="text-tertiary">
              {u.id === detail.task.assigned_qa_id ? 'has it now' : u.is_available ? 'online' : 'offline'}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** Phone numbers match when one ends with the other (country code or not). */
function sameValue(a: string, b: string) {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '')
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (x && y && /^\d+$/.test(x) && /^\d+$/.test(y)) return x.endsWith(y) || y.endsWith(x)
  return x === y
}

/** What the QA agent typed while listening to a live call, checked against the sheet once matched. */
function LiveCard({ detail: d, onSaved, onError }: { detail: TaskDetail; onSaved: () => void; onError: (e: string) => void }) {
  const t = d.task
  const entered = (t.data.live_entered ?? {}) as Record<string, string>
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const [busy, setBusy] = useState(false)
  const editing = draft !== null
  const fields = useApi(() => (editing ? api.liveFields(d.task_type.id) : Promise.resolve(null)), [d.task_type.id, editing])
  const matched = t.match_status === 'matched'
  const keys = Object.keys(entered)
  const differs = (k: string) => matched && t.data[k] !== undefined && !sameValue(String(t.data[k] ?? ''), entered[k] ?? '')
  const mismatches = keys.filter(differs)

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Call details (entered live)</h2>
          <p className="card-subtitle">
            {matched
              ? mismatches.length
                ? `The sheet's call differs on ${mismatches.join(', ')}.`
                : "Matches the sheet's call."
              : 'Checked against the sheet when that day is uploaded.'}
          </p>
        </div>
        {d.can_evaluate && !editing ? (
          <button className="btn btn-secondary btn-sm" onClick={() => setDraft({ ...entered })}>
            <Pencil size={14} />
            Edit
          </button>
        ) : null}
      </div>
      {draft ? (
        <div className="card-body form-grid">
          {fields.data ? (
            <LiveFieldInputs
              taskTypeId={d.task_type.id}
              fields={fields.data.fields}
              label={fields.data.label}
              value={draft}
              onChange={setDraft}
            />
          ) : (
            <div className="skeleton" style={{ height: 80 }} />
          )}
          <div className="builder-row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy || !fields.data}
              onClick={() => {
                setBusy(true)
                api
                  .setLiveDetails(t.id, draft)
                  .then(() => {
                    setDraft(null)
                    onSaved()
                  })
                  .catch((err) => onError(errorText(err)))
                  .finally(() => setBusy(false))
              }}
            >
              Save details
            </button>
          </div>
        </div>
      ) : keys.length ? (
        <dl className="kv">
          {keys.map((k) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>
                {entered[k] || '—'}
                {differs(k) ? (
                  <span className="badge badge-warning" style={{ marginLeft: 8 }}>
                    sheet: {String(t.data[k] || '—')}
                  </span>
                ) : null}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <div className="card-body text-secondary">Nothing was entered for this call.</div>
      )}
    </section>
  )
}

/** The sheet's columns as inputs, for a QA agent listening to a live call. */
export function LiveFieldInputs({
  taskTypeId,
  fields,
  label,
  value,
  onChange,
}: {
  taskTypeId: string
  fields: string[]
  label: string
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const codes = useApi(() => api.taskTypeLabels(taskTypeId), [taskTypeId])
  const set = (k: string, v: string) => onChange({ ...value, [k]: v })
  return (
    <div className="form-row">
      {fields.map((k) => (
        <div className="field" key={k}>
          <label className="field-label">
            {k}
            {k === label ? ' (if any)' : ''}
          </label>
          {/direction/i.test(k) ? (
            <select className="select" value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
              <option value="">Pick…</option>
              <option>Inbound</option>
              <option>Outbound</option>
            </select>
          ) : (
            <input
              className="input"
              list={k === label ? `codes-${taskTypeId}` : undefined}
              inputMode={/connect|phone|number/i.test(k) ? 'tel' : undefined}
              value={value[k] ?? ''}
              onChange={(e) => set(k, e.target.value)}
            />
          )}
        </div>
      ))}
      <datalist id={`codes-${taskTypeId}`}>
        {(codes.data ?? []).map((c) => (
          <option key={c.label} value={c.label} />
        ))}
      </datalist>
    </div>
  )
}
