import type { Limit } from '../api/types'

/** A per-agent audit limit: empty for none, else a number of audits or a percent of the agent's work. */
export function LimitInput({ value, onChange, compact }: { value: Limit | null | undefined; onChange: (l: Limit | null) => void; compact?: boolean }) {
  const l = value ?? null
  return (
    <div className="limit-input">
      <input
        className="input"
        type="number"
        min={0}
        max={l?.unit === 'percent' ? 100 : undefined}
        placeholder="no limit"
        value={l ? l.value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : { value: Number(e.target.value), unit: l?.unit ?? 'count' })}
      />
      <select
        className="select"
        value={l?.unit ?? 'count'}
        disabled={!l}
        onChange={(e) => l && onChange({ ...l, unit: e.target.value as Limit['unit'] })}
      >
        <option value="count">audits</option>
        <option value="percent">{compact ? '% of work' : '% of their work'}</option>
      </select>
    </div>
  )
}
