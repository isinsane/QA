import { useState } from 'react'
import type { ReactNode } from 'react'
import type { Answer, Metric } from '../api/types'
import { earned, maxPoints, preview, type Thresholds } from '../scorecard'
import { ScoreBadge } from './bits'

interface Props {
  card: Metric[]
  answers: Record<string, Answer>
  thresholds: Thresholds
  readOnly?: boolean
  onChange?: (answers: Record<string, Answer>) => void
  /** Buttons for the sticky score bar (submit, save). */
  footer?: ReactNode
}

/** The scorecard as a form (QA agent, supervisor edit) or a read-out (everyone else). */
export function ScorecardForm({ card, answers, thresholds, readOnly, onChange, footer }: Props) {
  const [noting, setNoting] = useState<Record<string, boolean>>({})
  const set = (id: string, patch: Partial<Answer>) =>
    onChange?.({ ...answers, [id]: { metric_id: id, value: answers[id]?.value ?? '', notes: answers[id]?.notes, ...patch } })
  const result = preview(card, answers, thresholds)
  const total = card.reduce((sum, m) => sum + maxPoints(m), 0)
  const scored = card.filter((m) => m.type !== 'text')
  const answered = scored.filter((m) => answers[m.id]?.value).length
  const firstOpen = scored.find((m) => !answers[m.id]?.value)
  // Long scorecards: jump to the first item still waiting for an answer.
  const jump = () => document.getElementById(`metric-${firstOpen?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })

  return (
    <>
      {card.map((m, i) => {
        const a = answers[m.id]
        // A critical metric that scored 0 (a No, not partial credit) can fail the whole audit, when the QA agent says so.
        const loses = (v: string | undefined) => m.critical && v !== undefined && v !== 'na' && earned(m, v) === 0
        const showNotes = !readOnly && m.type !== 'text' && (noting[m.id] || !!a?.notes)
        return (
          <div className={`metric${!readOnly && m.type !== 'text' && !a?.value ? ' is-open' : ''}`} key={m.id} id={`metric-${m.id}`}>
            <div className="metric-row">
              <div className="metric-info">
                <span className="metric-label">
                  <span className="metric-num">{i + 1}</span>
                  {m.label}
                  {m.critical ? <span className="badge badge-error">critical</span> : null}
                </span>
                <span className="metric-meta">
                  {m.type === 'text'
                    ? 'comment'
                    : `${maxPoints(m)} pts · ${total ? Math.round((maxPoints(m) / total) * 100) : 0}%${m.na_receiver ? ' · takes N/A weight' : ''}`}
                  {!readOnly && m.type !== 'text' && !showNotes ? (
                    <button type="button" className="metric-note-btn" onClick={() => setNoting({ ...noting, [m.id]: true })}>
                      + note
                    </button>
                  ) : null}
                </span>
              </div>
              {m.type !== 'text' ? (
                <Choices
                  metric={m}
                  value={a?.value ?? ''}
                  readOnly={readOnly}
                  onPick={(value) => set(m.id, { value, critical_fail: loses(value) ? a?.critical_fail : false })}
                />
              ) : null}
            </div>
            {loses(a?.value) && !readOnly ? (
              <label className="field-inline metric-critical">
                <input type="checkbox" checked={!!a?.critical_fail} onChange={(e) => set(m.id, { critical_fail: e.target.checked })} />
                Fail the whole audit (critical)
              </label>
            ) : null}
            {loses(a?.value) && readOnly && a?.critical_fail ? (
              <div className="metric-readonly-notes text-error">Failed the whole audit</div>
            ) : null}
            {m.type === 'text' ? (
              readOnly ? (
                <div className="metric-readonly-notes">{a?.value || <span className="text-tertiary">—</span>}</div>
              ) : (
                <textarea
                  className="textarea metric-notes"
                  rows={2}
                  value={a?.value ?? ''}
                  onChange={(e) => set(m.id, { value: e.target.value })}
                />
              )
            ) : null}
            {m.type !== 'text' && readOnly && a?.notes ? <div className="metric-readonly-notes">Note: {a.notes}</div> : null}
            {showNotes ? (
              <textarea
                className="textarea metric-notes"
                rows={2}
                autoFocus={!a?.notes}
                placeholder="Notes for the agent: why this score?"
                value={a?.notes ?? ''}
                onChange={(e) => set(m.id, { notes: e.target.value })}
              />
            ) : null}
          </div>
        )
      })}
      <div className="score-bar">
        <span className="score-bar-points">
          {result ? (
            <>
              <ScoreBadge score={result.score} result={result.band} critical={result.critical_failed} />
              <span className="text-secondary">
                {round(result.earned)} / {round(result.possible)} points
              </span>
            </>
          ) : (
            <>
              <span className="score-progress" aria-hidden>
                <span style={{ width: `${scored.length ? (answered / scored.length) * 100 : 0}%` }} />
              </span>
              <span className="text-secondary">
                {answered} of {scored.length} answered
              </span>
              {!readOnly && firstOpen ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={jump}>
                  Next unanswered
                </button>
              ) : null}
            </>
          )}
        </span>
        {footer ? <span className="score-bar-actions">{footer}</span> : null}
      </div>
    </>
  )
}

const round = (n: number) => Math.round(n * 10) / 10

function Choices({
  metric: m,
  value,
  readOnly,
  onPick,
}: {
  metric: Metric
  value: string
  readOnly?: boolean
  onPick: (v: string) => void
}) {
  let choices: { value: string; label: string }[] = []
  if (m.type === 'yes_no')
    choices = [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ]
  if (m.type === 'scale') choices = Array.from({ length: (m.scale_max ?? 0) + 1 }, (_, i) => ({ value: String(i), label: String(i) }))
  if (m.type === 'dropdown') choices = (m.options ?? []).map((o) => ({ value: o.label, label: `${o.label} (${o.points})` }))
  if (m.allow_na) choices.push({ value: 'na', label: 'N/A' })

  return (
    <div className="segmented" role="radiogroup" aria-label={m.label}>
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={value === c.value}
          className={`segmented-btn${value === c.value ? ' is-active' : ''}`}
          disabled={readOnly && value !== c.value}
          onClick={() => !readOnly && onPick(c.value)}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}
