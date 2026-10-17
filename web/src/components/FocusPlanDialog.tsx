import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { FocusPlan } from '../api/types'
import { AgentSearch } from './AgentSearch'
import { daysAgo, errorText, localDate } from './bits'
import { Modal } from './Modal'

/**
 * A new focus plan: one agent's work, some codes or any code at random, in a
 * date range, and why. A QA agent plans for themselves; a supervisor picks
 * the QA agent (the team's one with the lightest queue first).
 */
export function FocusPlanDialog({
  forQA,
  onClose,
  onCreated,
  onError,
}: {
  /** True when a QA agent plans for themselves. */
  forQA: boolean
  onClose: () => void
  onCreated: (plan: FocusPlan) => void
  onError: (e: string) => void
}) {
  const options = useApi(() => api.focusOptions(), [])
  const [f, setF] = useState({ agent: '', type: '', qa: '', from: daysAgo(7), to: localDate(new Date()), count: 5, reason: '' })
  const [random, setRandom] = useState(true)
  const [codes, setCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }))
  const agent = (options.data?.agents ?? []).find((a) => a.id === f.agent)
  const type = f.type || agent?.types[0]?.id || ''
  const qas = (options.data?.qas ?? []).filter((q) => q.department_id === agent?.team_id).sort((a, b) => a.open - b.open)
  const qa = f.qa || qas[0]?.id || ''
  const labels = useApi(
    () => (type && f.agent ? api.focusLabels({ task_type_id: type, employee_id: f.agent, from: f.from, to: f.to }) : Promise.resolve([])),
    [type, f.agent, f.from, f.to],
  )
  // Codes picked for another agent or range may not exist here.
  useEffect(() => setCodes((c) => c.filter((x) => (labels.data ?? []).some((l) => l.label === x))), [labels.data])
  const ready = agent && type && (forQA || qa) && f.count >= 1 && f.count <= 50 && f.reason.trim() && (random || codes.length > 0)

  return (
    <Modal
      title="New focus plan"
      subtitle="Focus audits never count in the agent's scores, and the agent never sees them. The QA agent does them before their normal queue."
      size="lg"
      onClose={onClose}
      onSubmit={() => {
        if (!ready) return
        setBusy(true)
        api
          .createFocusPlan({
            task_type_id: type,
            employee_id: f.agent,
            assigned_qa_id: forQA ? undefined : qa,
            labels: random ? [] : codes,
            count: f.count,
            from: f.from,
            to: f.to,
            reason: f.reason.trim(),
          })
          .then(onCreated)
          .catch((err) => onError(errorText(err)))
          .finally(() => setBusy(false))
      }}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ready}>
            Create plan
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Agent</label>
          <AgentSearch
            agents={options.data?.agents ?? []}
            value={f.agent}
            label="Agent"
            onChange={(id) => set({ agent: id, type: '', qa: '' })}
          />
        </div>
        {agent && agent.types.length > 1 ? (
          <div className="field">
            <label className="field-label">Work</label>
            <select className="select" value={type} onChange={(e) => set({ type: e.target.value })}>
              {agent.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">Work done from</label>
          <input className="input" type="date" value={f.from} max={f.to} onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">to</label>
          <input className="input" type="date" value={f.to} min={f.from} onChange={(e) => set({ to: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">How many</label>
          <input
            className="input"
            type="number"
            min={1}
            max={50}
            value={f.count}
            onChange={(e) => set({ count: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })}
          />
        </div>
      </div>
      <div className="field">
        <label className="field-label">Which interactions</label>
        <div className="segmented" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={random}
            className={`segmented-btn${random ? ' is-active' : ''}`}
            onClick={() => setRandom(true)}
          >
            Any code, at random
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!random}
            className={`segmented-btn${!random ? ' is-active' : ''}`}
            onClick={() => setRandom(false)}
          >
            Specific codes
          </button>
        </div>
        {!random ? (
          agent ? (
            (labels.data ?? []).length ? (
              <div className="code-picks">
                {(labels.data ?? []).map((l) => {
                  const on = codes.includes(l.label)
                  return (
                    <button
                      key={l.label}
                      type="button"
                      className={`code-pick${on ? ' is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => setCodes(on ? codes.filter((c) => c !== l.label) : [...codes, l.label])}
                    >
                      {l.label} <span>{l.rows}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="hint-text">No codes on this agent's not-audited work in those dates.</p>
            )
          ) : (
            <p className="hint-text">Pick the agent first.</p>
          )
        ) : null}
      </div>
      {forQA ? null : (
        <div className="field">
          <label className="field-label">QA agent who does it</label>
          <select className="select" value={qa} onChange={(e) => set({ qa: e.target.value })} disabled={!agent}>
            {!agent ? <option value="">Pick the agent first</option> : null}
            {qas.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name} ({q.open} in queue)
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label className="field-label">Why</label>
        <textarea
          className="textarea"
          rows={2}
          maxLength={500}
          placeholder="What this plan is to check, e.g. three fails on verification this week"
          value={f.reason}
          onChange={(e) => set({ reason: e.target.value })}
        />
      </div>
    </Modal>
  )
}
