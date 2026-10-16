import { Fragment, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Copy, ExternalLink, Pencil, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Answer, Kind, Metric, TaskDetail } from '../api/types'
import { AckBadge, errorText, fmtDate, fmtDateTime, KindBadge, Labels, ScoreBadge, StateBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ScorecardForm } from '../components/ScorecardForm'
import { ToastStack, useToasts } from '../components/Toasts'
import { useAuth } from '../auth/AuthContext'

/** Standalone page: /tasks/:id (managers) and /my-scores/:id (employees). */
export function TaskPage() {
  const { taskId = '' } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const fallback = useLocation().pathname.startsWith('/my-scores') ? '/my-scores' : user?.role === 'qa_agent' ? '/escalations' : '/tasks'
  return (
    <div className="page">
      <button
        className="btn btn-ghost btn-sm"
        style={{ marginBottom: 12 }}
        // Back where they came from (All tasks, Escalations, an agent's page…); a link opened on its own has nowhere to go back to.
        onClick={() => (window.history.state?.idx ? navigate(-1) : navigate(fallback))}
      >
        <ArrowLeft size={15} />
        Back
      </button>
      <TaskView taskId={taskId} />
    </div>
  )
}

/** Escalations: checked, then marked Valid (the agent's mistake) or Not valid. Never scored. */
const REPORTED: Partial<Record<Kind, { what: string; note: string }>> = {
  negative: { what: 'Negative review', note: 'The error' },
  tl_escalation: { what: 'Team leader escalation', note: 'What happened' },
  qa_escalation: { what: 'QA escalation', note: 'What happened' },
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
  negative_confirmed: 'Marked valid',
  negative_dismissed: 'Marked not valid',
  tl_escalation_reported: 'Escalated by the team leader',
  tl_escalation_confirmed: 'Marked valid',
  tl_escalation_dismissed: 'Marked not valid',
  qa_escalation_reported: 'Escalated by a QA agent',
  qa_escalation_confirmed: 'Marked valid',
  qa_escalation_dismissed: 'Marked not valid',
  change_requested: 'Score change asked for',
  change_rejected: 'Score change rejected',
}

/** "Score 80% → 90%", or that only notes changed. */
function scoreMove(detail: Record<string, unknown>) {
  const before = (detail.before as { score?: number | null } | undefined)?.score ?? null
  const after = (detail.after as { score?: number | null } | undefined)?.score ?? null
  return before === after ? 'Notes or comments only; score unchanged' : `Score ${before ?? '—'}% → ${after ?? '—'}%`
}

const shownValue = (v: string | undefined) => (v === undefined || v === '' ? '—' : v === 'na' ? 'N/A' : v)

/** Scored metrics whose answer differs: what a pending change would do. */
function changedMetrics(card: Metric[], before: Answer[] | null, after: Answer[] | undefined) {
  const val = (as: Answer[] | null | undefined, id: string) => {
    const a = as?.find((x) => x.metric_id === id)
    return `${shownValue(a?.value)}${a?.critical_fail ? ' · fails the audit' : ''}`
  }
  return card
    .filter((m) => m.type !== 'text' && val(before, m.id) !== val(after, m.id))
    .map((m) => ({ label: m.label, from: val(before, m.id), to: val(after, m.id) }))
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
  const [dialog, setDialog] = useState<
    'cant' | 'cancel' | 'reassign' | 'edit' | 'ack' | 'dispute' | 'uphold' | 'forward' | 'valid' | 'invalid' | 'approve' | 'reject' | null
  >(null)
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
  const pending = d.changes?.[0]?.status === 'pending' ? d.changes[0] : null
  // A QA agent's change to a scored answer needs a reason: the supervisor approves it.
  const scoreChanges = !d.can_approve && changedMetrics(card, t.answers, list).length > 0

  async function act(fn: () => Promise<unknown>, ok: string | ((r: unknown) => string), next?: (r: unknown) => void) {
    setBusy(true)
    try {
      const r = await fn()
      push('success', typeof ok === 'string' ? ok : ok(r))
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
        {rep ? (
          <span className={`badge ${t.state === 'completed' ? 'badge-error' : t.state === 'cancelled' ? 'badge-gray' : 'badge-warning'}`}>
            {t.state === 'completed' ? 'valid' : t.state === 'cancelled' ? 'not valid' : 'to check'}
          </span>
        ) : (
          <StateBadge state={t.state} />
        )}
        <KindBadge kind={t.kind} match={t.match_status} />
        {t.state === 'completed' && !rep ? <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} /> : null}
        {t.state === 'completed' && (t.kind === 'sample' || t.kind === 'live' || t.kind === 'escalation') ? (
          <AckBadge status={t.ack_status} />
        ) : null}
        <span className="text-secondary">
          {d.employee.name} · worked {fmtDate(t.work_date)}
          {d.qa_name ? ` · QA: ${d.qa_name}` : ''}
        </span>
      </div>
      {t.cancel_reason && !rep ? <div className="inline-warning">Cancelled: {t.cancel_reason}</div> : null}
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
          {d.can_decide ? <span>Check it, then mark it Valid (the agent's mistake: it goes on their profile) or Not valid.</span> : null}
          {!d.can_decide && !d.can_manage && !d.can_evaluate && !d.can_edit && !d.reported_by ? (
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
      {pending ? (
        <div className="inline-warning change-note">
          <span>
            <strong>{pending.requested_by_name}</strong> asked to change the score from {pending.score_before ?? '—'}% to{' '}
            {pending.score ?? '—'}%: "{pending.reason}".{' '}
            {d.can_approve ? 'Approve it to apply it, or reject it.' : 'Waiting for a supervisor; until then the audit keeps its score.'}
          </span>
          <ul className="change-list">
            {changedMetrics(card, t.answers, pending.answers).map((c) => (
              <li key={c.label}>
                {c.label}: <s className="text-tertiary">{c.from}</s> → <strong>{c.to}</strong>
              </li>
            ))}
          </ul>
          {d.can_approve ? (
            <span className="builder-row">
              <button className="btn btn-primary btn-sm" onClick={() => setDialog('approve')}>
                Approve
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setDialog('reject')}>
                Reject
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
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
                    {a.action === 'evaluation_edited' || a.action === 'change_requested' ? (
                      <div className="text-secondary">
                        {scoreMove(a.detail)}
                        {typeof a.detail.requested_by === 'string' ? ` · asked for by ${a.detail.requested_by}, approved` : ''}
                        {typeof a.detail.approval_note === 'string' && a.detail.approval_note ? `: ${a.detail.approval_note}` : ''}
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
          {rep && !t.answers?.length ? (
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">Decision</h2>
                <div className="page-actions">
                  {d.can_manage && t.kind !== 'qa_escalation' ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => setDialog('reassign')}>
                      Reassign
                    </button>
                  ) : null}
                  {d.can_decide ? (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDialog('invalid')}>
                        Not valid
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={() => setDialog('valid')}>
                        Valid
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="card-body">
                {t.state === 'review' ? (
                  <p className="text-secondary" style={{ margin: 0 }}>
                    {t.kind === 'qa_escalation'
                      ? 'Waiting for the supervisor to decide it.'
                      : d.qa_name
                        ? `Being checked by ${d.qa_name}. The supervisor can decide it too.`
                        : 'Waiting for a QA agent of the team to check it.'}
                  </p>
                ) : (
                  <p style={{ margin: 0 }}>
                    <strong>{t.state === 'completed' ? "Valid: the agent's mistake." : 'Not valid.'}</strong> {t.finding || t.cancel_reason}
                  </p>
                )}
              </div>
            </section>
          ) : (
            <section className="card">
              <div className="card-header">
                <h2 className="card-title">Scorecard</h2>
                <div className="page-actions">
                  {d.can_manage ? (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDialog('reassign')}>
                        Reassign
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setDialog('cancel')}>
                        Cancel audit
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
              {card.length === 0 ? (
                <div className="card-body inline-warning">This task type has no metrics yet. A supervisor adds them on Task types.</div>
              ) : t.state === 'completed' || formOpen ? (
                <ScorecardForm
                  card={card}
                  answers={answers}
                  thresholds={{
                    pass: d.task_type.pass_threshold,
                    borderline: d.task_type.borderline_threshold ?? 0,
                  }}
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
          )}
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
      {dialog === 'valid' || dialog === 'invalid' ? (
        <ReasonDialog
          title={dialog === 'valid' ? "Valid: the agent's mistake" : 'Not valid'}
          placeholder={
            dialog === 'valid'
              ? 'What you found, e.g. listened to the call, the agent gave the wrong ETA'
              : "What you found: why it isn't the agent's mistake"
          }
          action={dialog === 'valid' ? 'Mark valid' : 'Mark not valid'}
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(note) =>
            void act(
              () => api.decide(t.id, dialog === 'valid', note),
              dialog === 'valid' ? "Marked valid: it is on the agent's profile" : 'Marked not valid',
            )
          }
        />
      ) : null}
      {dialog === 'cancel' ? (
        <ReasonDialog
          title="Cancel this audit"
          placeholder="Why it should not be audited"
          action="Cancel audit"
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(reason) => void act(() => api.cancel(t.id, reason), 'Audit cancelled')}
        />
      ) : null}
      {dialog === 'edit' ? (
        <ReasonDialog
          title="Save edited evaluation"
          placeholder={
            scoreChanges
              ? 'Why the score should change (the supervisor sees it before approving)'
              : d.can_approve && (t.ack_status === 'disputed' || t.ack_status === 'dispute_qa')
                ? 'Reply to the agent (accepts the dispute)'
                : 'Reason for the change (kept in the history)'
          }
          action={scoreChanges ? 'Send for approval' : 'Save'}
          busy={busy}
          optional={!scoreChanges}
          onClose={() => setDialog(null)}
          onSubmit={(reason) =>
            void act(
              () => api.editEvaluation(t.id, list, reason),
              (r) => ((r as { pending: boolean }).pending ? 'Sent to the supervisor: score changes need approval' : 'Evaluation updated'),
            )
          }
        />
      ) : null}
      {dialog === 'approve' && pending ? (
        <ReasonDialog
          title="Approve the score change"
          placeholder="Note for the QA agent (optional)"
          action="Approve"
          busy={busy}
          optional
          onClose={() => setDialog(null)}
          onSubmit={(note) => void act(() => api.approveChange(pending.id, note), 'Approved: the new score applies')}
        />
      ) : null}
      {dialog === 'reject' && pending ? (
        <ReasonDialog
          title="Reject the score change"
          placeholder="Why, for the QA agent"
          action="Reject"
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={(note) => void act(() => api.rejectChange(pending.id, note), 'Rejected: the score stays')}
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

/** The clipboard API only exists on HTTPS or localhost; the LAN server is plain HTTP, so fall back to the old way. */
function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text)
  const box = document.createElement('textarea')
  box.value = text
  box.style.position = 'fixed'
  box.style.opacity = '0'
  document.body.appendChild(box)
  box.select()
  const ok = document.execCommand('copy')
  box.remove()
  return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'))
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
          void copyText(id).then(() => {
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
        order_items?: {
          quantity?: number
          product?: { title?: string; sku?: string }
        }[]
        tracking_codes?: {
          tracking_code?: string
          tracking_carrier_name?: string
          tracking_link?: string
        }[]
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

export function ReasonDialog({
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
              optional={fields.data.optional}
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
  optional = [label],
  value,
  onChange,
}: {
  taskTypeId: string
  fields: string[]
  label: string
  /** Fields that may stay empty: the code, phone and order number. */
  optional?: string[]
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
            {optional.includes(k) ? ' (if any)' : ''}
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
