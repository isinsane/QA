import type { ReactNode } from 'react'

export function StatCard({
  label,
  value,
  icon,
  tone,
  hint,
}: {
  label: string
  value: ReactNode
  icon: ReactNode
  tone: 'brand' | 'warning' | 'success' | 'error'
  hint?: ReactNode
}) {
  return (
    <div className="card stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        <span className={`stat-icon ${tone}`}>{icon}</span>
      </div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-footer">{hint}</div> : null}
    </div>
  )
}
