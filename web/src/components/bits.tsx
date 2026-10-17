import type { ReactNode } from 'react'
import { ApiError } from '../api/client'
import type { AckStatus, Band, Kind, TaskState } from '../api/types'

/** Whether a task type audits an agent of this HR department (same rule as the server). */
export function auditedUnder(type: { agent_groups?: string[] } | undefined, department: string | undefined): boolean {
  const d = (department ?? '').trim().toLowerCase()
  return !type?.agent_groups?.length || !d || type.agent_groups.some((g) => g.trim().toLowerCase() === d)
}

export function errorText(err: unknown, fallback = 'Something went wrong.'): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Yesterday in the browser's clock: today's upload holds yesterday's work. */
export function yesterday(): string {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return localDate(d)
}

export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDate(d)
}

export type RangeKey = 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'last_30' | 'all' | 'custom'
export interface DateRange {
  key: RangeKey
  from: string
  to: string
}

const RANGE_LABEL: Record<RangeKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  last_30: 'Last 30 days',
  all: 'All time',
  custom: 'Custom',
}

/** A preset's dates; weeks start on Monday, like the reports. "all" is empty on both ends. */
export function rangeFor(key: RangeKey): DateRange {
  const d = (shift: (x: Date) => void) => {
    const x = new Date()
    shift(x)
    return localDate(x)
  }
  const monday = (weeks: number) => (x: Date) => x.setDate(x.getDate() - ((x.getDay() + 6) % 7) + 7 * weeks)
  switch (key) {
    case 'today':
      return { key, from: d(() => {}), to: d(() => {}) }
    case 'yesterday':
      return { key, from: daysAgo(1), to: daysAgo(1) }
    case 'this_week':
      return { key, from: d(monday(0)), to: d(() => {}) }
    case 'last_week':
      return { key, from: d(monday(-1)), to: d((x) => (monday(-1)(x), x.setDate(x.getDate() + 6))) }
    case 'this_month':
      return { key, from: d((x) => x.setDate(1)), to: d(() => {}) }
    case 'last_month':
      return { key, from: d((x) => (x.setDate(1), x.setMonth(x.getMonth() - 1))), to: d((x) => x.setDate(0)) }
    case 'last_30':
      return { key, from: daysAgo(29), to: d(() => {}) }
    default:
      return { key, from: '', to: '' }
  }
}

/** Preset buttons plus the dates they stand for; editing a date makes it a custom range. */
export function DateRangePicker({ value, presets, onChange }: { value: DateRange; presets: RangeKey[]; onChange: (r: DateRange) => void }) {
  return (
    <div className="range-picker">
      <div className="segmented">
        {presets.map((k) => (
          <button key={k} type="button" className={`segmented-btn${value.key === k ? ' is-active' : ''}`} onClick={() => onChange(rangeFor(k))}>
            {RANGE_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="range-dates">
        <input
          className="input"
          type="date"
          aria-label="From"
          value={value.from}
          max={value.to || undefined}
          onChange={(e) => onChange({ key: 'custom', from: e.target.value, to: value.to })}
        />
        <span className="text-tertiary">to</span>
        <input
          className="input"
          type="date"
          aria-label="To"
          value={value.to}
          min={value.from || undefined}
          onChange={(e) => onChange({ key: 'custom', from: value.from, to: e.target.value })}
        />
      </div>
    </div>
  )
}

export function ScoreBadge({
  score,
  result,
  passed,
  critical,
}: {
  score: number | null
  result?: Band | null
  passed?: boolean | null
  critical?: boolean
}) {
  const r: Band | null = result ?? (passed === null || passed === undefined ? null : passed ? 'pass' : 'fail')
  if (score === null && r === null) return <span className="text-tertiary">—</span>
  const tone = r === 'pass' ? 'badge-success' : r === 'borderline' ? 'badge-warning' : 'badge-error'
  const title = critical ? 'Critical metric failed' : r === 'pass' ? 'Pass' : r === 'borderline' ? 'Borderline' : 'Fail'
  return (
    <span className={`badge ${tone}`} title={title}>
      {score === null ? title : `${score}%`}
      {critical ? ' · critical' : r === 'borderline' ? ' · borderline' : ''}
    </span>
  )
}

const KIND_SHORT: Record<Kind, string> = {
  sample: 'Sample',
  live: 'Live',
  escalation: 'Escalation',
  focus: 'Focus plan',
  rotation: 'Rotation',
  negative: 'Negative',
  tl_escalation: 'TL escalation',
  qa_escalation: 'QA escalation',
}

/** Nothing for a daily sample: it is the ordinary case. */
export function KindBadge({ kind, match }: { kind: Kind; match?: string }) {
  if (kind === 'sample') return null
  const tone = kind === 'escalation' || kind === 'negative' || kind === 'tl_escalation' || kind === 'qa_escalation' ? 'badge-error' : kind === 'live' ? 'badge-brand' : 'badge-purple'
  return (
    <span className={`badge ${tone}`}>
      {KIND_SHORT[kind]}
      {kind === 'live' && match === 'flagged' ? ' · no call found' : kind === 'live' && match === 'pending' ? ' · awaiting sheet' : ''}
    </span>
  )
}

const ACK_LABEL: Record<AckStatus, [string, string]> = {
  '': ['not acknowledged', 'badge-gray'],
  acknowledged: ['acknowledged', 'badge-success'],
  disputed: ['disputed · with supervisor', 'badge-error'],
  dispute_qa: ['disputed · with QA', 'badge-error'],
  upheld: ['dispute: score kept', 'badge-gray'],
  changed: ['dispute: score changed', 'badge-brand'],
}

export function AckBadge({ status, hidden }: { status: AckStatus; hidden?: boolean }) {
  const [label, tone] = hidden && status === '' ? ['not revealed yet', 'badge-gray'] : ACK_LABEL[status]
  return <span className={`badge ${tone}`}>{label}</span>
}

const STATE_TONE: Record<TaskState, string> = {
  unsampled: 'badge-gray',
  review: 'badge-warning',
  ready: 'badge-purple',
  assigned: 'badge-brand',
  completed: 'badge-success',
  cancelled: 'badge-gray',
}

export function StateBadge({ state }: { state: TaskState }) {
  return <span className={`badge ${STATE_TONE[state]}`}>{state === 'review' ? 'to check' : state}</span>
}

/** Previous / next for a paged list; nothing when it fits on one page. */
export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / (size || 50)))
  if (pages <= 1) return null
  return (
    <div className="card-foot">
      <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span className="text-secondary">
        Page {page} of {pages}
      </span>
      <button className="btn btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  )
}

export function Labels({ labels, empty = 'no code / tag' }: { labels: string[] | null; empty?: string }) {
  if (!labels?.length) return <span className="text-tertiary">{empty}</span>
  return (
    <span className="label-chips">
      {labels.map((l) => (
        <span key={l} className="label-chip">
          {l}
        </span>
      ))}
    </span>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state-title">{title}</div>
      {children ? <div>{children}</div> : null}
    </div>
  )
}
