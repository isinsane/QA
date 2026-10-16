import type { Answer, Band, Metric, ScoreResult } from './api/types'

// Mirrors internal/scorecard for the live preview only; the server's score
// is the one that is saved.

export function maxPoints(m: Metric): number {
  if (m.type === 'dropdown') return Math.max(0, ...(m.options ?? []).map((o) => o.points))
  return m.type === 'text' ? 0 : (m.points ?? 0)
}

export function earned(m: Metric, v: string): number | null {
  switch (m.type) {
    case 'yes_no':
      return v === 'yes' ? (m.points ?? 0) : v === 'no' ? 0 : null
    case 'scale': {
      const n = Number(v)
      return v !== '' && n >= 0 && n <= (m.scale_max ?? 0) ? ((m.points ?? 0) * n) / (m.scale_max || 1) : null
    }
    case 'dropdown':
      return m.options?.find((o) => o.label === v)?.points ?? null
  }
  return null
}

export interface Thresholds {
  pass: number
  borderline: number
}

export function band(score: number | null, critical: boolean, th: Thresholds): Band {
  if (critical) return 'fail'
  if (score === null || score >= th.pass) return 'pass'
  return score >= th.borderline ? 'borderline' : 'fail'
}

/** null while a point-carrying metric is still unanswered. N/A weight moves
 * to the N/A receivers, split by their own weights; with none, N/A drops out. */
export function preview(card: Metric[], answers: Record<string, Answer>, th: Thresholds): ScoreResult | null {
  const lines: { m: Metric; e: number; p: number }[] = []
  let naWeight = 0
  let receiverWeight = 0
  let critical = false
  for (const m of card) {
    if (m.type === 'text') continue
    const v = answers[m.id]?.value ?? ''
    if (v === 'na') {
      naWeight += maxPoints(m)
      continue
    }
    const got = earned(m, v)
    if (got === null) return null
    const p = maxPoints(m)
    if (m.critical && answers[m.id]?.critical_fail && got < p) critical = true
    if (m.na_receiver) receiverWeight += p
    lines.push({ m, e: got, p })
  }
  let e = 0
  let p = 0
  for (const l of lines) {
    let le = l.e
    let lp = l.p
    if (l.m.na_receiver && naWeight > 0 && receiverWeight > 0) {
      const grown = lp + (naWeight * lp) / receiverWeight
      le = (le * grown) / lp
      lp = grown
    }
    e += le
    p += lp
  }
  const score = p > 0 ? (critical ? 0 : Math.round((e / p) * 1000) / 10) : null
  const b = band(score, critical, th)
  return { earned: e, possible: p, score, critical_failed: critical, passed: b === 'pass', band: b }
}

/** 8 hex characters. getRandomValues, not randomUUID: the portal is served over plain HTTP on the LAN, where
 * browsers leave randomUUID out (it needs HTTPS or localhost) and Add metric would crash. */
export function newMetricId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const METRIC_TYPES: { value: Metric['type']; label: string }[] = [
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'scale', label: 'Score scale' },
  { value: 'dropdown', label: 'Dropdown with points' },
  { value: 'text', label: 'Text comment' },
]

export const KIND_LABEL: Record<string, string> = {
  sample: 'Daily sample',
  live: 'Live monitoring',
  escalation: 'Supervisor escalation',
  focus: 'Focus plan',
  rotation: 'Rotation (QA over QA)',
  negative: 'Negative review',
  tl_escalation: 'Team leader escalation',
  qa_escalation: 'QA escalation',
}
