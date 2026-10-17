import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Siren } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { useReadOnly } from '../auth/AuthContext'
import type { TaskType } from '../api/types'
import { AckBadge, auditedUnder, daysAgo, Empty, errorText, fmtDate, KindBadge, Labels, ScoreBadge, StateBadge } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'
import { KIND_LABEL } from '../scorecard'

const STATES = [
  { value: '', label: 'Sampled' },
  { value: 'ready', label: 'Waiting for QA' },
  { value: 'assigned', label: 'In a QA queue' },
  { value: 'completed', label: 'Evaluated' },
  { value: 'pass', label: 'Evaluated: pass' },
  { value: 'borderline', label: 'Evaluated: borderline' },
  { value: 'fail', label: 'Evaluated: fail' },
  { value: 'disputed', label: 'Disputed by the agent' },
  { value: 'unacknowledged', label: 'Not acknowledged yet' },
  { value: 'live_flagged', label: 'Live: no call found' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'unsampled', label: 'Not sampled' },
  { value: 'all', label: 'Everything' },
]

export function TasksPage() {
  const navigate = useNavigate()
  const [f, setF] = useState({ state: '', kind: '', task_type_id: '', qa_id: '', from: daysAgo(14), to: '', q: '', page: 1 })
  const [escalating, setEscalating] = useState(false)
  const { toasts, push } = useToasts()
  const types = useApi(() => api.taskTypes(), [])
  const tasks = useApi(() => api.tasks(f), [JSON.stringify(f)])
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, page: 1, ...patch }))
  const total = tasks.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / (tasks.data?.page_size ?? 50)))
  const qas = useApi(() => api.users('qa_agent'), [])
  const activeQAs = (qas.data ?? []).filter((q) => q.active)

  // Selection for moving work between QA agents. Only open audits can move;
  // rotation cases stay with whoever has them (it's a blind comparison).
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [moveTo, setMoveTo] = useState('')
  const [moving, setMoving] = useState(false)
  const filterKey = JSON.stringify({ ...f, page: 0 })
  useEffect(() => setPicked(new Set()), [filterKey])
  const rows = tasks.data?.tasks ?? []
  const readOnly = useReadOnly()
  const movable = (t: { state: string; kind: string }) =>
    !readOnly && (t.state === 'ready' || t.state === 'assigned') && t.kind !== 'rotation'
  const pageMovable = rows.filter(movable)
  const allOnPage = pageMovable.length > 0 && pageMovable.every((t) => picked.has(t.id))
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const togglePage = () =>
    setPicked((prev) => {
      const next = new Set(prev)
      for (const t of pageMovable) {
        if (allOnPage) next.delete(t.id)
        else next.add(t.id)
      }
      return next
    })
  async function selectAllMatching() {
    try {
      const r = await api.taskIds({ ...f, page: undefined })
      setPicked(new Set(r.ids))
    } catch (err) {
      push('error', errorText(err))
    }
  }
  async function move(qaId: string | null) {
    setMoving(true)
    try {
      const r = await api.bulkReassign([...picked], qaId)
      const who = qaId ? activeQAs.find((q) => q.id === qaId)?.name : 'the queue'
      push('success', `${r.moved} moved to ${who}${r.skipped ? `; ${r.skipped} skipped (not open, rotation, or already theirs)` : ''}`)
      setPicked(new Set())
      setMoveTo('')
      await tasks.reload()
    } catch (err) {
      push('error', errorText(err))
    } finally {
      setMoving(false)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">All tasks</h1>
          <p className="page-subtitle">
            {total} task{total === 1 ? '' : 's'} match
          </p>
        </div>
        <div className="page-actions">
          {readOnly ? null : (
            <button className="btn btn-primary" onClick={() => setEscalating(true)}>
              <Siren size={16} />
              Escalate an interaction
            </button>
          )}
        </div>
      </div>
      <div className="tasks-filter-bar" style={{ gridTemplateColumns: 'minmax(200px, 2fr) repeat(6, minmax(130px, 1fr))' }}>
        <div className="field">
          <label className="field-label">Search</label>
          <input
            className="input"
            placeholder="Interaction / ticket ID, order number or agent"
            value={f.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label">State</label>
          <select className="select" value={f.state} onChange={(e) => set({ state: e.target.value })}>
            {STATES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Kind</label>
          <select className="select" value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">All kinds</option>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Type</label>
          <select className="select" value={f.task_type_id} onChange={(e) => set({ task_type_id: e.target.value })}>
            <option value="">All types</option>
            {(types.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">QA agent</label>
          <select
            className="select"
            value={f.qa_id}
            // Looking at someone's queue means all of it, not just the last two weeks.
            onChange={(e) => set({ qa_id: e.target.value, ...(e.target.value ? { from: '' } : {}) })}
          >
            <option value="">Anyone</option>
            {activeQAs.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
                {q.is_available ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">Worked from</label>
          <input className="input" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">to</label>
          <input className="input" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
      </div>

      <section className="card">
        {tasks.error ? <div className="card-body inline-warning">{tasks.error}</div> : null}
        {total === 0 && !tasks.loading ? <Empty title="No tasks" /> : null}
        {allOnPage && picked.size < total && pageMovable.length < total ? (
          <div className="select-banner">
            {picked.size} selected.
            <button className="btn btn-ghost btn-sm" onClick={() => void selectAllMatching()}>
              Select all {total} that match
            </button>
          </div>
        ) : null}
        {total > 0 ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>
                    <input
                      type="checkbox"
                      aria-label="Select the open audits on this page"
                      checked={allOnPage}
                      disabled={pageMovable.length === 0}
                      onChange={togglePage}
                    />
                  </th>
                  <th>Worked</th>
                  <th>Type</th>
                  <th>Agent</th>
                  <th>Call / ticket</th>
                  <th>Code / tags</th>
                  <th>State</th>
                  <th>QA</th>
                  <th>Score</th>
                  <th>Agent's answer</th>
                </tr>
              </thead>
              <tbody>
                {(tasks.data?.tasks ?? []).map((t) => (
                  <tr
                    key={t.id}
                    className={`is-clickable${picked.has(t.id) ? ' is-picked' : ''}`}
                    onClick={() => navigate(`/tasks/${t.id}`)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      {movable(t) ? (
                        <input type="checkbox" aria-label="Select" checked={picked.has(t.id)} onChange={() => toggle(t.id)} />
                      ) : null}
                    </td>
                    <td>{fmtDate(t.work_date)}</td>
                    <td>
                      {t.task_type_name} <KindBadge kind={t.kind} match={t.match_status} />
                    </td>
                    <td>{t.employee_name}</td>
                    <td className="mono" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.external_id}
                    </td>
                    <td>
                      <Labels labels={t.labels} />
                    </td>
                    <td>
                      <StateBadge state={t.state} />
                    </td>
                    <td>{t.qa_name ?? <span className="text-tertiary">—</span>}</td>
                    <td>
                      <ScoreBadge score={t.score} result={t.result} critical={t.critical_failed} />
                    </td>
                    <td>
                      {t.state === 'completed' && ['sample', 'live', 'escalation'].includes(t.kind) ? (
                        <AckBadge status={t.ack_status} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {pages > 1 ? (
          <div className="card-foot" style={{ justifyContent: 'center' }}>
            <button className="btn btn-secondary btn-sm" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>
              Previous
            </button>
            <span className="text-secondary">
              Page {f.page} of {pages}
            </span>
            <button className="btn btn-secondary btn-sm" disabled={f.page >= pages} onClick={() => setF({ ...f, page: f.page + 1 })}>
              Next
            </button>
          </div>
        ) : null}
      </section>
      {picked.size ? (
        <div className="save-bar">
          <span>
            {picked.size} selected
            <button className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </span>
          <select className="select" style={{ width: 220 }} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move to">
            <option value="">Move to a QA agent…</option>
            {activeQAs.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
                {q.is_available ? '' : ' (offline)'}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={!moveTo || moving} onClick={() => void move(moveTo)}>
            Move
          </button>
          <button
            className="btn btn-secondary"
            disabled={moving}
            title="Back to the queue: shared among the QA agents who are online, up to their caps"
            onClick={() => void move(null)}
          >
            Share among online QA agents
          </button>
        </div>
      ) : null}
      {escalating ? (
        <EscalateDialog
          types={(types.data ?? []).filter((t) => t.active)}
          onClose={() => setEscalating(false)}
          onSent={(id) => {
            setEscalating(false)
            push('success', 'Sent to the quality team; it goes to the top of a QA queue.')
            navigate(`/tasks/${id}`)
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

/** A supervisor sends one interaction to the quality team. */
function EscalateDialog({
  types,
  onClose,
  onSent,
  onError,
}: {
  types: TaskType[]
  onClose: () => void
  onSent: (id: string) => void
  onError: (e: string) => void
}) {
  const agents = useApi(() => api.users('employee'), [])
  const [f, setF] = useState({ type: types[0]?.id ?? '', external: '', agent: '', reason: '' })
  const [busy, setBusy] = useState(false)
  const type = types.find((t) => t.id === f.type)
  const team = (agents.data ?? []).filter(
    (a) => a.active && (!type || a.department_id === type.department_id) && auditedUnder(type, a.profile?.department),
  )
  const idLabel = type?.source === 'tickets_api' ? 'Ticket ID' : type?.source === 'edesk_chats' ? 'Chat ID' : 'Interaction ID'
  return (
    <Modal
      title="Escalate an interaction"
      subtitle="It goes to the top of a QA agent's queue in that team, even past the queue cap, and you see the result here."
      size="md"
      onClose={onClose}
      onSubmit={() => {
        setBusy(true)
        api
          .escalate({ task_type_id: f.type, external_id: f.external, employee_id: f.agent, reason: f.reason })
          .then((r) => onSent(r.task_id))
          .catch((err) => onError(errorText(err)))
          .finally(() => setBusy(false))
      }}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !f.type || !f.external.trim() || !f.agent || !f.reason.trim()}
          >
            Send to QA
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Type</label>
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, agent: '' })}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label">{idLabel}</label>
          <input className="input mono" value={f.external} onChange={(e) => setF({ ...f, external: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label className="field-label">Agent</label>
        <select className="select" value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })}>
          <option value="">Pick the agent…</option>
          {team.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.alias_name ? ` (${a.alias_name})` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label">Why should QA look at it?</label>
        <textarea className="textarea" rows={4} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      </div>
    </Modal>
  )
}
