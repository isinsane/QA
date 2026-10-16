import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { Coaching, TaskRow } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import {
  AckBadge,
  DateRangePicker,
  Empty,
  errorText,
  fmtDate,
  KindBadge,
  Labels,
  rangeFor,
  ScoreBadge,
  type DateRange,
} from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')

const avgOf = (scores: (number | null)[]) => {
  const xs = scores.filter((x): x is number => x !== null)
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null
}

const REPORTED_BADGE: Partial<Record<string, string>> = {
  negative: 'negative review',
  tl_escalation: 'TL escalation',
  qa_escalation: 'QA escalation',
}

/** A report confirmed without a QA audit has no score. */
function Score({ t }: { t: TaskRow }) {
  if (REPORTED_BADGE[t.kind] && t.score === null) return <span className="badge badge-error">{REPORTED_BADGE[t.kind]}</span>
  return <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
}

/** The agent's page: their score for a period, every audit of their work, and what waits for their answer. */
export function MyScoresPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const scores = useApi(() => api.myScores(), [])
  const summary = useApi(() => api.mySummary(), [])
  const coachings = useApi(() => api.coachings(), [])
  const { toasts, push } = useToasts()
  const [open, setOpen] = useState<Coaching | null>(null)
  const [range, setRange] = useState<DateRange>(() => rangeFor('this_month'))
  const all = scores.data ?? []
  const list = all.filter((t) => (!range.from || t.work_date >= range.from) && (!range.to || t.work_date <= range.to))
  // Escalations (valid ones only reach here): shown apart, read-only, and kept out of the score.
  const audits = list.filter((t) => !REPORTED_BADGE[t.kind])
  const reported = list.filter((t) => REPORTED_BADGE[t.kind])
  const negatives = reported.filter((t) => t.kind === 'negative').length
  const avg = avgOf(audits.map((t) => t.score))
  const passed = audits.filter((t) => t.result === 'pass').length
  const toAnswer = all.filter((t) => t.ack_status === '' && !REPORTED_BADGE[t.kind])
  const coachingList = coachings.data ?? []
  // Sessions a QA agent logged after the fact aren't acknowledged.
  const coachingToAck = coachingList.filter((c) => c.status === 'done' && !c.ack_at && !c.logged)
  const p = user?.profile ?? {}

  return (
    <div className="page profile">
      <section className="card profile-head">
        <div className="profile-avatar" aria-hidden>
          {initials(user?.name ?? '')}
        </div>
        <div className="profile-who">
          <h1 className="profile-name">
            {user?.name}
            {user?.alias_name ? <span className="text-tertiary"> · known as {user.alias_name}</span> : null}
          </h1>
          <div className="text-secondary">
            {[p.job_title, summary.data?.team || p.department, p.supervisor ? `Supervisor: ${p.supervisor}` : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </section>

      <DateRangePicker value={range} presets={['this_week', 'last_week', 'this_month', 'last_month', 'all']} onChange={setRange} />

      <section className="card score-panel">
        <div className="score-panel-main">
          <span className="score-panel-label">Average quality score</span>
          <strong>{avg === null ? '—' : `${avg}%`}</strong>
          <span className="text-tertiary">
            {range.key === 'all'
              ? 'All time'
              : range.from === range.to
                ? fmtDate(range.from)
                : `${fmtDate(range.from)} – ${fmtDate(range.to)}`}
          </span>
        </div>
        <div className="score-panel-facts">
          <div>
            <strong>{audits.length}</strong>
            <span>audits</span>
          </div>
          <div>
            <strong>{audits.length ? `${Math.round((passed / audits.length) * 100)}%` : '—'}</strong>
            <span>passed</span>
          </div>
          <div>
            <strong>{audits.filter((t) => t.critical_failed).length}</strong>
            <span>critical fails</span>
          </div>
          <div>
            <strong className={negatives ? 'text-error' : undefined}>{negatives}</strong>
            <span>negative reviews</span>
          </div>
          <div>
            <strong className={reported.length - negatives ? 'text-error' : undefined}>{reported.length - negatives}</strong>
            <span>escalations</span>
          </div>
        </div>
      </section>

      {toAnswer.length || coachingToAck.length ? (
        <section className="card attention">
          <div className="card-header">
            <div>
              <h2 className="card-title">Waiting for your answer</h2>
              <p className="card-subtitle">Read each one, then acknowledge it, or dispute an evaluation you disagree with.</p>
            </div>
            <span className="badge badge-warning">{toAnswer.length + coachingToAck.length}</span>
          </div>
          <ul className="attention-list">
            {coachingToAck.map((c) => (
              <li key={c.id}>
                <span className="badge badge-purple">coaching</span>
                <span className="attention-what">
                  <strong>{c.topic || `${c.task_ids.length} linked audit(s)`}</strong>
                  <span className="text-tertiary">
                    with {c.qa_name} · {fmtDate(c.completed_at)}
                  </span>
                </span>
                <button className="btn btn-primary btn-sm" onClick={() => setOpen(c)}>
                  Read & acknowledge
                </button>
              </li>
            ))}
            {toAnswer.map((t) => (
              <li key={t.id}>
                <span className="badge badge-brand">audit</span>
                <span className="attention-what">
                  <strong>
                    {t.task_type_name} · {fmtDate(t.work_date)}
                  </strong>
                  <Labels labels={t.labels} />
                </span>
                <Score t={t} />
                <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/my-scores/${t.id}`)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">My audits</h2>
            <p className="card-subtitle">Open one to see every scorecard item and the QA notes explaining your score.</p>
          </div>
        </div>
        {audits.length === 0 && !scores.loading ? <Empty title="No audits in this period" /> : null}
        {audits.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Worked</th>
                  <th>Type</th>
                  <th>Code / tags</th>
                  <th>Score</th>
                  <th>Your answer</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {audits.map((t) => (
                  <tr key={t.id} className="is-clickable" onClick={() => navigate(`/my-scores/${t.id}`)}>
                    <td>{fmtDate(t.work_date)}</td>
                    <td>
                      {t.task_type_name} <KindBadge kind={t.kind} />
                    </td>
                    <td>
                      <Labels labels={t.labels} />
                    </td>
                    <td>
                      <Score t={t} />
                    </td>
                    <td>
                      <AckBadge status={t.ack_status} />
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
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Negatives and escalations</h2>
            <p className="card-subtitle">
              Reports about your work that were checked and found valid. For your information: they don't change your quality score.
            </p>
          </div>
        </div>
        {reported.length === 0 && !scores.loading ? <Empty title="None in this period" /> : null}
        {reported.length > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Kind</th>
                  <th>Order / call</th>
                  <th style={{ width: '32%' }}>What happened</th>
                  <th style={{ width: '28%' }}>Finding</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {reported.map((t) => (
                  <tr key={t.id} className="is-clickable" onClick={() => navigate(`/my-scores/${t.id}`)}>
                    <td>{fmtDate(t.work_date)}</td>
                    <td>
                      <span className="badge badge-error">{REPORTED_BADGE[t.kind]}</span>
                    </td>
                    <td className="mono">{t.external_id}</td>
                    <td className="dispute-text">{t.note}</td>
                    <td className="dispute-text">
                      {t.score === null ? t.finding || '—' : <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />}
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
      </section>

      {coachingList.length ? (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Coaching sessions</h2>
          </div>
          <ul className="attention-list">
            {coachingList.map((c) => (
              <li key={c.id}>
                <span className="attention-what">
                  <strong>{c.topic || `${c.task_ids.length} linked audit(s)`}</strong>
                  <span className="text-tertiary">
                    with {c.qa_name} ·{' '}
                    {c.status === 'done' ? fmtDate(c.completed_at) : c.due_date ? `due ${fmtDate(c.due_date)}` : 'scheduled'}
                  </span>
                </span>
                {c.status === 'open' ? (
                  <span className="badge badge-gray">scheduled</span>
                ) : c.logged ? (
                  <span className="badge badge-gray">{c.kind === 'refresher' ? 'refresher' : 'held'}</span>
                ) : c.ack_at ? (
                  <span className="badge badge-success">acknowledged</span>
                ) : (
                  <span className="badge badge-warning">to acknowledge</span>
                )}
                {c.status === 'done' ? (
                  <button className={`btn btn-sm ${c.ack_at || c.logged ? 'btn-ghost' : 'btn-primary'}`} onClick={() => setOpen(c)}>
                    {c.ack_at || c.logged ? 'View' : 'Read'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {open ? (
        <CoachingReadout
          coaching={open}
          onClose={() => setOpen(null)}
          onAck={(comment) =>
            api
              .ackCoaching(open.id, comment)
              .then(() => {
                push('success', 'Acknowledged')
                setOpen(null)
                void coachings.reload()
              })
              .catch((err) => push('error', errorText(err)))
          }
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

function CoachingReadout({ coaching: c, onClose, onAck }: { coaching: Coaching; onClose: () => void; onAck: (comment: string) => void }) {
  const [comment, setComment] = useState('')
  return (
    <Modal
      title={c.topic ? `Coaching: ${c.topic}` : 'Coaching'}
      subtitle={`With ${c.qa_name} · ${fmtDate(c.completed_at)}`}
      size="md"
      onClose={onClose}
      onSubmit={c.ack_at || c.logged ? undefined : () => onAck(comment)}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          {!c.ack_at && !c.logged ? (
            <button type="submit" className="btn btn-primary">
              Acknowledge
            </button>
          ) : null}
        </>
      }
    >
      <div className="field">
        <span className="field-label">What was covered</span>
        <div style={{ whiteSpace: 'pre-wrap' }}>{c.notes || '—'}</div>
      </div>
      {c.outcome ? (
        <div className="field">
          <span className="field-label">Outcome / next steps</span>
          <div>{c.outcome}</div>
        </div>
      ) : null}
      {c.task_ids.length ? (
        <div className="field">
          <span className="field-label">Audits it was about</span>
          <div>
            {c.task_ids.map((id, i) => (
              <a key={id} href={`/my-scores/${id}`} style={{ marginRight: 10 }}>
                Audit {i + 1}
              </a>
            ))}
          </div>
        </div>
      ) : null}
      {c.logged ? null : c.ack_at ? (
        <div className="inline-success" style={{ margin: 0 }}>
          Acknowledged {fmtDate(c.ack_at)}
          {c.ack_comment ? `: "${c.ack_comment}"` : ''}
        </div>
      ) : (
        <div className="field">
          <label className="field-label">Comment (optional)</label>
          <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
      )}
    </Modal>
  )
}
