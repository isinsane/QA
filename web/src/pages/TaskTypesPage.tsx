import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { AgentLimits, Bounds, Limit, Metric, Source, TaskType } from '../api/types'
import { useAuth, useReadOnly } from '../auth/AuthContext'
import { Empty, errorText } from '../components/bits'
import { LimitInput } from '../components/LimitInput'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'
import { maxPoints, METRIC_TYPES, newMetricId } from '../scorecard'

const SOURCE_LABEL: Record<Source, string> = {
  sheet: 'Vonage sheet',
  tickets_api: 'Tickets API',
  edesk_chats: 'eDesk live chats',
  manual: 'Escalations only',
}

type Tab = 'scorecard' | 'scoring' | 'sampling' | 'settings'

export function TaskTypesPage() {
  const { user } = useAuth()
  const readOnly = useReadOnly()
  const isAdmin = user?.role === 'admin'
  const types = useApi(() => api.taskTypes(), [])
  const depts = useApi(() => api.departments(), [])
  const { toasts, push } = useToasts()
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const list = types.data ?? []
  const current = list.find((t) => t.id === selected) ?? list[0] ?? null
  const deptName = (id: string) => depts.data?.find((d) => d.id === id)?.name ?? ''

  // The list, grouped by team.
  const byTeam = new Map<string, TaskType[]>()
  for (const t of list) byTeam.set(t.department_id, [...(byTeam.get(t.department_id) ?? []), t])
  const groups = [...byTeam.entries()].sort((a, b) => deptName(a[0]).localeCompare(deptName(b[0])))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Task types</h1>
          <p className="page-subtitle">What QA agents score, how it is scored, and how much of each agent's work is sampled.</p>
        </div>
        <div className="page-actions">
          {readOnly ? null : (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={16} />
              New task type
            </button>
          )}
        </div>
      </div>

      {types.data && list.length === 0 ? (
        <section className="card">
          <Empty title="No task types yet">Create the first one with New task type.</Empty>
        </section>
      ) : null}

      {list.length ? (
        <div className="tt-layout">
          <nav className="card tt-list" aria-label="Task types">
            {groups.map(([dept, ts]) => (
              <div key={dept}>
                <div className="tt-group">{deptName(dept)}</div>
                {ts.map((t) => (
                  <button key={t.id} className={`tt-item${current?.id === t.id ? ' active' : ''}`} onClick={() => setSelected(t.id)}>
                    <span className="tt-item-name">
                      <span className={`status-dot${t.active ? ' on' : ''}`} />
                      {t.name}
                    </span>
                    <span className="tt-item-meta">
                      {SOURCE_LABEL[t.source]} · {t.scorecard.length} metric{t.scorecard.length === 1 ? '' : 's'}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          {current ? (
            <TypeEditor
              key={current.id + current.updated_at}
              type={current}
              deptName={deptName(current.department_id)}
              onSaved={() => {
                push('success', 'Saved')
                void types.reload()
              }}
              onError={(e) => push('error', e)}
            />
          ) : null}
        </div>
      ) : null}

      {creating ? (
        <CreateType
          isAdmin={isAdmin}
          depts={depts.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false)
            push('success', `${t.name} created`)
            setSelected(t.id)
            void types.reload()
          }}
          onError={(e) => push('error', e)}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

/** "Calls audit" → "calls_audit", so nobody has to invent a code. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

function CreateType({
  isAdmin,
  depts,
  onClose,
  onCreated,
  onError,
}: {
  isAdmin: boolean
  depts: { id: string; name: string }[]
  onClose: () => void
  onCreated: (t: TaskType) => void
  onError: (e: string) => void
}) {
  const [f, setF] = useState({ department_id: '', code: '', name: '', source: 'sheet' })
  return (
    <Modal
      title="New task type"
      subtitle="Add its metrics and sampling right after."
      size="md"
      onClose={onClose}
      onSubmit={() =>
        void api
          // A supervisor has no team picker: their own team is used.
          .createTaskType({ ...f, department_id: f.department_id || undefined, code: f.code || slug(f.name) })
          .then(onCreated)
          .catch((err) => onError(errorText(err)))
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={!f.name.trim() || (isAdmin && !f.department_id)}>
            Create
          </button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label className="field-label">Name</label>
          <input className="input" autoFocus placeholder="Calls audit" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">Code</label>
          <input className="input mono" placeholder={slug(f.name) || 'calls_audit'} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        {isAdmin ? (
          <div className="field">
            <label className="field-label">Team</label>
            <select className="select" value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}>
              <option value="">Pick one…</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label className="field-label">Where its work comes from</label>
          <select className="select" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
            <option value="sheet">Vonage sheet, uploaded daily</option>
            <option value="tickets_api">Tickets API, pulled daily</option>
            <option value="edesk_chats">eDesk live chats, pulled daily</option>
            <option value="manual">No feed yet (escalations only)</option>
          </select>
        </div>
      </div>
    </Modal>
  )
}

function TypeEditor({
  type,
  deptName,
  onSaved,
  onError,
}: {
  type: TaskType
  deptName: string
  onSaved: () => void
  onError: (e: string) => void
}) {
  const readOnly = useReadOnly()
  const [t, setT] = useState(type)
  const [tab, setTab] = useState<Tab>('scorecard')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Metric | 'new' | null>(null)
  const [removing, setRemoving] = useState<Metric | null>(null)
  const [confirmSave, setConfirmSave] = useState(false)
  // Metrics the saved scorecard has and this draft dropped.
  const dropped = type.scorecard.filter((m) => !t.scorecard.some((x) => x.id === m.id))
  const cardIssues = cardProblems(t.scorecard)
  const labels = useApi(() => api.taskTypeLabels(type.id), [type.id])
  const people = useApi(() => api.users('employee'), [])
  // The team's HR departments, with how many agents each, for the "who it audits" picker.
  const hrDepts = Object.entries(
    (people.data ?? [])
      .filter((u) => u.active && u.department_id === type.department_id)
      .flatMap((u) => [u.profile?.department, u.profile?.job_title].filter((x): x is string => !!x))
      .reduce<Record<string, number>>((acc, g) => ({ ...acc, [g]: (acc[g] ?? 0) + 1 }), {}),
  ).map(([label, rows]) => ({ label, rows }))
  const set = (patch: Partial<TaskType>) => setT((prev) => ({ ...prev, ...patch }))
  const dirty = JSON.stringify(t) !== JSON.stringify(type)

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  async function save() {
    if (dropped.length && !confirmSave) {
      setConfirmSave(true)
      return
    }
    setConfirmSave(false)
    setBusy(true)
    try {
      await api.updateTaskType(t.id, {
        name: t.name,
        active: t.active,
        scorecard: t.scorecard,
        pass_threshold: Number(t.pass_threshold),
        borderline_threshold: Number(t.borderline_threshold),
        sample_percent: Number(t.sample_percent),
        untagged_percent: Number(t.untagged_percent),
        skip_labels: t.skip_labels,
        ignore_labels: t.ignore_labels,
        rotation_enabled: t.rotation_enabled,
        rotation_days: Number(t.rotation_days),
        agent_limits: t.agent_limits,
        agent_groups: t.agent_groups ?? [],
        columns: t.columns,
      })
      onSaved()
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const possible = t.scorecard.reduce((sum, m) => sum + maxPoints(m), 0)
  const word = t.source === 'tickets_api' || t.source === 'edesk_chats' ? 'tag' : 'code'
  const tabs: [Tab, string][] = [
    ['scorecard', `Scorecard (${t.scorecard.length})`],
    ['scoring', 'Pass & borderline'],
    ...(t.source !== 'manual' ? ([['sampling', 'Sampling']] as [Tab, string][]) : []),
    ['settings', 'Settings'],
  ]

  return (
    <div className="tt-editor">
      <section className="card tt-head">
        <div>
          <div className="tt-title">
            {t.name}
            <span className={`badge ${t.active ? 'badge-success' : 'badge-gray'}`}>{t.active ? 'active' : 'inactive'}</span>
          </div>
          <div className="text-secondary">
            {deptName} · {SOURCE_LABEL[t.source]} · <span className="mono">{t.code}</span>
          </div>
        </div>
        <div className="tt-head-stats">
          <div>
            <strong>{possible}</strong>
            <span>points</span>
          </div>
          <div>
            <strong>{t.pass_threshold}%</strong>
            <span>to pass</span>
          </div>
          {t.source !== 'manual' ? (
            <div>
              <strong>{t.sample_percent}%</strong>
              <span>sampled</span>
            </div>
          ) : null}
        </div>
      </section>

      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'scorecard' ? (
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Scorecard</h2>
              <p className="card-subtitle">
                Critical metrics fail the whole audit when they earn 0. When a metric is answered N/A, its weight moves to the metrics that
                take N/A weight.
              </p>
            </div>
            {readOnly ? null : (
              <button className="btn btn-primary" onClick={() => setEditing('new')}>
                <Plus size={16} />
                Add metric
              </button>
            )}
          </div>
          {cardIssues.length ? (
            <div className="inline-warning" style={{ margin: '0 24px 16px', display: 'grid', gap: 2 }}>
              {cardIssues.map((p) => (
                <span key={p}>{p}</span>
              ))}
            </div>
          ) : null}
          {t.scorecard.length === 0 ? (
            <Empty title="No metrics yet">QA agents can submit once the scorecard has at least one metric.</Empty>
          ) : (
            <div className="table-scroll">
              <table className="table metric-table">
                <thead>
                  <tr>
                    <th style={{ width: 76 }} />
                    <th>Metric</th>
                    <th>Type</th>
                    <th style={{ width: 210 }}>Weight</th>
                    <th>Rules</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {t.scorecard.map((m, i) => {
                    const share = possible ? Math.round((maxPoints(m) / possible) * 100) : 0
                    const move = (dir: -1 | 1) => {
                      const next = [...t.scorecard]
                      ;[next[i], next[i + dir]] = [next[i + dir], next[i]]
                      set({ scorecard: next })
                    }
                    return (
                      <tr key={m.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm btn-icon" disabled={i === 0} onClick={() => move(-1)} aria-label="Move up">
                            <ArrowUp size={14} />
                          </button>
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            disabled={i === t.scorecard.length - 1}
                            onClick={() => move(1)}
                            aria-label="Move down"
                          >
                            <ArrowDown size={14} />
                          </button>
                        </td>
                        <td>
                          <strong>{m.label || <span className="text-tertiary">Untitled</span>}</strong>
                          {m.type === 'dropdown' ? (
                            <div className="text-tertiary" style={{ fontSize: 12 }}>
                              {(m.options ?? []).map((o) => `${o.label} ${o.points}`).join(' · ')}
                            </div>
                          ) : null}
                        </td>
                        <td className="text-secondary" style={{ whiteSpace: 'nowrap' }}>
                          {METRIC_TYPES.find((x) => x.value === m.type)?.label}
                          {m.type === 'scale' ? ` 0–${m.scale_max}` : ''}
                        </td>
                        <td>
                          {m.type === 'text' ? (
                            <span className="text-tertiary">no points</span>
                          ) : (
                            <div className="weight">
                              <span className="weight-bar">
                                <span style={{ width: `${share}%` }} />
                              </span>
                              <span className="weight-value">
                                {maxPoints(m)} pts · {share}%
                              </span>
                            </div>
                          )}
                        </td>
                        <td>
                          <span className="label-chips">
                            {m.critical ? <span className="badge badge-error">critical</span> : null}
                            {m.allow_na ? <span className="badge badge-gray">N/A allowed</span> : null}
                            {m.na_receiver ? <span className="badge badge-purple">takes N/A weight</span> : null}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(m)} aria-label="Edit metric">
                            <Pencil size={14} />
                          </button>
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            onClick={() => setRemoving(m)}
                            aria-label="Delete metric"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {tab === 'scoring' ? (
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Pass and borderline</h2>
              <p className="card-subtitle">Every audit comes out Pass, Borderline or Fail. A critical metric the QA agent fails the audit on is always a Fail.</p>
            </div>
          </div>
          <div className="card-body form-grid" style={{ gap: 18 }}>
            <div className="form-row">
              <div className="field">
                <label className="field-label">Pass at (%)</label>
                <input className="input" type="number" min={0} max={100} value={t.pass_threshold} onChange={(e) => set({ pass_threshold: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label className="field-label">Borderline from (%)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={t.pass_threshold}
                  value={t.borderline_threshold}
                  onChange={(e) => set({ borderline_threshold: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="band-bar" aria-hidden>
              <span className="band-fail" style={{ width: `${t.borderline_threshold}%` }}>
                Fail
              </span>
              <span className="band-borderline" style={{ width: `${Math.max(0, t.pass_threshold - t.borderline_threshold)}%` }}>
                Borderline
              </span>
              <span className="band-pass" style={{ width: `${100 - t.pass_threshold}%` }}>
                Pass
              </span>
            </div>
            <p className="hint-text">
              Below {t.borderline_threshold}% is a Fail, {t.borderline_threshold}–{t.pass_threshold}% is Borderline, {t.pass_threshold}% and
              above is a Pass.
            </p>
          </div>
        </section>
      ) : null}

      {tab === 'sampling' ? (
        <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">Sampling</h2>
              <p className="card-subtitle">How much of each day's work becomes an audit.</p>
            </div>
          </div>
          <div className="card-body form-grid" style={{ gap: 22 }}>
            <div className="form-row">
              <div className="field">
                <label className="field-label">With a {word}: % of each agent's rows</label>
                <input className="input" type="number" min={0} max={100} step={0.5} value={t.sample_percent} onChange={(e) => set({ sample_percent: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label className="field-label">Without a {word}: % of everyone's rows</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={t.untagged_percent}
                  onChange={(e) => set({ untagged_percent: Number(e.target.value) })}
                />
              </div>
            </div>
            <p className="hint-text">
              Each agent gets {t.sample_percent}% of their {word === 'tag' ? 'tagged tickets' : 'coded calls'} (rounded up, at least one), spread
              across different {word}s{t.source === 'tickets_api' ? ' and reply counts (1 / 2 / 3+)' : t.source === 'edesk_chats' ? ' and chat lengths' : ''}. On top, {t.untagged_percent}% of
              everyone's {word === 'tag' ? 'untagged tickets' : 'calls without a code'} goes to the agents with the fewest picks.
            </p>
            <div className="field">
              <label className="field-label">Audits per agent</label>
              <p className="hint-text">
                On top of the percentages: leave a box empty for no limit. A weekly or monthly minimum is spread over the days left in it.
              </p>
              <LimitsTable value={t.agent_limits ?? {}} onChange={(agent_limits) => set({ agent_limits })} />
            </div>
            <div className="field">
              <label className="field-label">Never sample these {word}s</label>
              <ChipList listId="seen-skip" value={t.skip_labels} seen={labels.data ?? []} onChange={(skip_labels) => set({ skip_labels })} action="Skip" />
            </div>
            <div className="field">
              <label className="field-label">Ignore these {word}s</label>
              <p className="hint-text">
                They stay visible on the audit but don't count for sampling or reports (e.g. "Read", channel tags), so a{' '}
                {word === 'tag' ? 'ticket' : 'call'} with only these counts as without a {word}.
              </p>
              <ChipList
                listId="seen-ignore"
                value={t.ignore_labels ?? []}
                seen={labels.data ?? []}
                onChange={(ignore_labels) => set({ ignore_labels })}
                action="Ignore"
              />
            </div>
          </div>
        </section>
      ) : null}

      {tab === 'settings' ? (
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">Settings</h2>
          </div>
          <div className="card-body form-grid" style={{ gap: 22 }}>
            <div className="field">
              <label className="field-label">Agents audited here (HR department or job title)</label>
              <p className="hint-text">
                Only agents of these HR departments or job titles get audits of this type, so calls agents aren't sampled from a sales sheet
                or the other way round. Where a team has several types, an agent's work is the type that names them (a Live Chat Associate's:
                live chats), never asked. An upload where most rows belong to other agents is refused. Empty: every agent of the team.
              </p>
              <ChipList
                listId={`hr-${t.id}`}
                value={t.agent_groups ?? []}
                seen={hrDepts}
                onChange={(agent_groups) => set({ agent_groups })}
                action="Add"
                hint="agents"
              />
            </div>
            <div className="form-row">
              <div className="field">
                <label className="field-label">Name</label>
                <input className="input" value={t.name} onChange={(e) => set({ name: e.target.value })} />
              </div>
              <label className="field-inline" style={{ alignSelf: 'end', paddingBottom: 10 }}>
                <input type="checkbox" checked={t.active} onChange={(e) => set({ active: e.target.checked })} />
                Active (inactive types are not imported or assigned)
              </label>
            </div>
            <div>
              <div className="form-section">Rotation (QA over QA)</div>
              <div className="form-row" style={{ alignItems: 'end' }}>
                <label className="field-inline" style={{ paddingBottom: 10 }}>
                  <input type="checkbox" checked={t.rotation_enabled} onChange={(e) => set({ rotation_enabled: e.target.checked })} />
                  QA agents get rotation cases each week (how many is set in Settings), re-scored blind by a colleague after
                </label>
                <div className="field" style={{ maxWidth: 120 }}>
                  <label className="field-label">days</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={t.rotation_days}
                    disabled={!t.rotation_enabled}
                    onChange={(e) => set({ rotation_days: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>
            {t.source === 'sheet' ? (
              <div>
                <div className="form-section">Sheet columns</div>
                <div className="form-row">
                  {(
                    [
                      ['external_id', 'Call ID column'],
                      ['agent_code', 'Agent ID column (empty = match by name)'],
                      ['agent_name', 'Agent name column'],
                      ['label', 'Code column'],
                      ['start_time', 'Start time column'],
                    ] as const
                  ).map(([k, label]) => (
                    <div className="field" key={k}>
                      <label className="field-label">{label}</label>
                      <input className="input" value={t.columns[k] ?? ''} onChange={(e) => set({ columns: { ...t.columns, [k]: e.target.value } })} />
                    </div>
                  ))}
                </div>
                <div className="form-section">Shared sheet</div>
                <p className="hint-text">
                  When calls and sales come in one Vonage sheet: give each task type the column that tells them apart and the values it
                  takes (e.g. Service name: New Sales for sales, Other Sales for calls). One upload then fills both. Empty: every row.
                </p>
                <div className="form-row">
                  <div className="field">
                    <label className="field-label">Only rows where column</label>
                    <input
                      className="input"
                      placeholder="Service name"
                      value={t.columns.row_column ?? ''}
                      onChange={(e) => set({ columns: { ...t.columns, row_column: e.target.value } })}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">is one of</label>
                    <ChipList
                      listId={`rows-${t.id}`}
                      value={t.columns.row_values ?? []}
                      seen={[]}
                      onChange={(row_values) => set({ columns: { ...t.columns, row_values } })}
                      action="Add"
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {dirty && !readOnly ? (
        <div className="save-bar">
          <span>Unsaved changes to {type.name}</span>
          <button className="btn btn-secondary" onClick={() => setT(type)}>
            Discard
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            Save changes
          </button>
        </div>
      ) : null}

      {removing ? (
        <Modal
          title={`Delete "${removing.label}"?`}
          size="sm"
          onClose={() => setRemoving(null)}
          onSubmit={() => {
            set({ scorecard: t.scorecard.filter((x) => x.id !== removing.id) })
            setRemoving(null)
          }}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setRemoving(null)}>
                Keep it
              </button>
              <button type="submit" className="btn btn-danger">
                Delete metric
              </button>
            </>
          }
        >
          <p className="text-secondary">
            New audits won't have it once you save. Audits already scored keep it, and reports keep its history.
          </p>
        </Modal>
      ) : null}
      {confirmSave ? (
        <Modal
          title={`Save without ${dropped.length} metric${dropped.length === 1 ? '' : 's'}?`}
          size="sm"
          onClose={() => setConfirmSave(false)}
          onSubmit={() => void save()}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmSave(false)}>
                Back
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Save anyway
              </button>
            </>
          }
        >
          <p className="text-secondary">These come off the scorecard for every new audit:</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {dropped.map((m) => (
              <li key={m.id}>{m.label}</li>
            ))}
          </ul>
          <p className="hint-text">Audits already scored keep their copy. Use Discard to undo.</p>
        </Modal>
      ) : null}
      {editing ? (
        <MetricModal
          metric={editing === 'new' ? null : editing}
          others={t.scorecard.filter((x) => editing === 'new' || x.id !== editing.id)}
          onClose={() => setEditing(null)}
          onDone={(m) => {
            set({ scorecard: editing === 'new' ? [...t.scorecard, m] : t.scorecard.map((x) => (x.id === m.id ? m : x)) })
            setEditing(null)
          }}
        />
      ) : null}
    </div>
  )
}

const PERIODS = [
  ['day', 'Per day'],
  ['week', 'Per week'],
  ['month', 'Per month'],
] as const

/** At least / at most, per day, week and month, each a number of audits or a percent of the agent's work. */
function LimitsTable({ value, onChange }: { value: AgentLimits; onChange: (v: AgentLimits) => void }) {
  const setLimit = (period: keyof AgentLimits, side: keyof Bounds, l: Limit | null) =>
    onChange({ ...value, [period]: { ...value[period], [side]: l } })
  return (
    <table className="table limits-table">
      <thead>
        <tr>
          <th />
          <th>At least</th>
          <th>At most</th>
        </tr>
      </thead>
      <tbody>
        {PERIODS.map(([period, label]) => (
          <tr key={period}>
            <td>
              <strong>{label}</strong>
            </td>
            {(['min', 'max'] as const).map((side) => {
              return (
                <td key={side}>
                  <LimitInput value={value[period]?.[side]} onChange={(l) => setLimit(period, side, l)} />
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ChipList({
  listId,
  value,
  seen,
  onChange,
  action,
  hint,
}: {
  listId: string
  value: string[]
  seen: { label: string; rows: number }[]
  onChange: (v: string[]) => void
  action: string
  hint?: string
}) {
  const [draft, setDraft] = useState('')
  const add = (l: string) => {
    const v = l.trim()
    if (v && !value.includes(v)) onChange([...value, v])
    setDraft('')
  }
  return (
    <div className="form-grid" style={{ gap: 8 }}>
      <div className="label-chips">
        {value.length === 0 ? <span className="text-tertiary">None.</span> : null}
        {value.map((l) => (
          <button key={l} type="button" className="label-chip removable" onClick={() => onChange(value.filter((x) => x !== l))} title="Remove">
            {l} ✕
          </button>
        ))}
      </div>
      <div className="builder-row">
        <input
          className="input"
          style={{ maxWidth: 320 }}
          list={listId}
          placeholder="Type or pick one"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(draft)
            }
          }}
        />
        <datalist id={listId}>
          {seen.map((s) => (
            <option key={s.label} value={s.label}>
              {s.rows} {hint ?? 'rows in the last 60 days'}
            </option>
          ))}
        </datalist>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => add(draft)} disabled={!draft.trim()}>
          {action}
        </button>
      </div>
    </div>
  )
}

/** Add or edit one metric. */
// Same limits as the server (internal/scorecard).
const MAX_POINTS = 100
const MAX_SCALE = 10
const MAX_OPTIONS = 10

/** What's wrong with the scorecard as a whole; the server refuses to save these. */
function cardProblems(card: Metric[]): string[] {
  const scored = card.filter((m) => m.type !== 'text')
  const out: string[] = []
  if (card.length > 60) out.push('A scorecard can have at most 60 metrics.')
  if (card.length && !scored.length) out.push('Add at least one metric worth points; comments alone give no score.')
  if (scored.length && scored.every((m) => m.allow_na)) out.push('Every metric allows N/A, so an audit could end with no score. Make at least one always answered.')
  return out
}

/** What's wrong with one metric, in words; empty when it can be saved. */
function metricProblems(m: Metric, others: Metric[]): string[] {
  const out: string[] = []
  const label = m.label.trim().toLowerCase()
  if (m.label.length > 200) out.push('The label is longer than 200 characters.')
  if (label && others.some((o) => o.label.trim().toLowerCase() === label)) out.push('Another metric already has this label.')
  if (m.type === 'yes_no' || m.type === 'scale') {
    const pts = m.points ?? 0
    if (!(pts > 0 && pts <= MAX_POINTS)) out.push(`Points must be between 1 and ${MAX_POINTS}.`)
  }
  if (m.type === 'scale' && !((m.scale_max ?? 0) >= 1 && (m.scale_max ?? 0) <= MAX_SCALE)) out.push(`The scale must go up to between 1 and ${MAX_SCALE}.`)
  if (m.type === 'dropdown') {
    const opts = m.options ?? []
    const names = opts.map((o) => o.label.trim().toLowerCase())
    if (opts.length < 2 || opts.length > MAX_OPTIONS) out.push(`A dropdown needs 2 to ${MAX_OPTIONS} options.`)
    if (names.some((n) => !n)) out.push('Every option needs a name.')
    if (new Set(names).size !== names.length) out.push('Two options have the same name.')
    if (names.includes('na')) out.push('"NA" is reserved; use the Allow N/A box instead.')
    if (opts.some((o) => o.points < 0 || o.points > MAX_POINTS)) out.push(`Option points must be between 0 and ${MAX_POINTS}.`)
    if (!opts.some((o) => o.points > 0)) out.push('At least one option must be worth points.')
  }
  return out
}

function MetricModal({
  metric,
  others,
  onClose,
  onDone,
}: {
  metric: Metric | null
  others: Metric[]
  onClose: () => void
  onDone: (m: Metric) => void
}) {
  const [m, setM] = useState<Metric>(
    metric ?? { id: newMetricId(), label: '', type: 'yes_no', points: 10, critical: false, allow_na: false, na_receiver: false },
  )
  const set = (patch: Partial<Metric>) => setM((prev) => ({ ...prev, ...patch }))
  const options = m.options ?? []
  const problems = metricProblems(m, others)
  const valid = m.label.trim() !== '' && problems.length === 0

  function setType(type: Metric['type']) {
    set({
      type,
      points: type === 'text' || type === 'dropdown' ? undefined : (m.points ?? 10),
      scale_max: type === 'scale' ? (m.scale_max ?? 5) : undefined,
      options:
        type === 'dropdown'
          ? (m.options ?? [
              { label: 'Met', points: 10 },
              { label: 'Partially met', points: 5 },
              { label: 'Not met', points: 0 },
            ])
          : undefined,
      critical: type === 'text' ? false : m.critical,
      allow_na: type === 'text' ? false : m.allow_na,
      na_receiver: type === 'text' ? false : m.na_receiver,
    })
  }

  return (
    <Modal
      title={metric ? 'Edit metric' : 'Add metric'}
      subtitle="Applies to audits submitted after you save the task type."
      size="md"
      onClose={onClose}
      onSubmit={() => valid && onDone({ ...m, label: m.label.trim() })}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            {metric ? 'Update metric' : 'Add metric'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">What the QA agent checks</label>
        <input className="input" autoFocus placeholder="e.g. Verified the customer's order" value={m.label} onChange={(e) => set({ label: e.target.value })} />
      </div>
      <div className="field">
        <label className="field-label">Answer type</label>
        <div className="segmented">
          {METRIC_TYPES.map((x) => (
            <button key={x.value} type="button" className={`segmented-btn${m.type === x.value ? ' is-active' : ''}`} onClick={() => setType(x.value)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>

      {m.type === 'yes_no' || m.type === 'scale' ? (
        <div className="form-row">
          <div className="field">
            <label className="field-label">Points when fully met</label>
            <input className="input" type="number" min={1} max={MAX_POINTS} value={m.points ?? 0} onChange={(e) => set({ points: Number(e.target.value) })} />
          </div>
          {m.type === 'scale' ? (
            <div className="field">
              <label className="field-label">Scale from 0 to</label>
              <input className="input" type="number" min={1} max={MAX_SCALE} value={m.scale_max ?? 5} onChange={(e) => set({ scale_max: Number(e.target.value) })} />
            </div>
          ) : null}
        </div>
      ) : null}

      {m.type === 'dropdown' ? (
        <div className="field">
          <label className="field-label">Options and their points</label>
          <div className="form-grid" style={{ gap: 6 }}>
            {options.map((o, i) => (
              <div className="builder-option" key={i}>
                <input
                  className="input"
                  placeholder="Option"
                  value={o.label}
                  onChange={(e) => set({ options: options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                />
                <input
                  className="input"
                  style={{ width: 100 }}
                  type="number"
                  min={0}
                  max={MAX_POINTS}
                  value={o.points}
                  onChange={(e) => set({ options: options.map((x, j) => (j === i ? { ...x, points: Number(e.target.value) } : x)) })}
                />
                <span className="text-tertiary">pts</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  disabled={options.length <= 2}
                  onClick={() => set({ options: options.filter((_, j) => j !== i) })}
                  aria-label="Remove option"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={options.length >= MAX_OPTIONS}
                onClick={() => set({ options: [...options, { label: '', points: 0 }] })}
              >
                <Plus size={14} />
                Option
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {m.type !== 'text' ? (
        <div className="form-grid" style={{ gap: 10 }}>
          <label className="field-inline">
            <input type="checkbox" checked={m.critical} onChange={(e) => set({ critical: e.target.checked })} />
            <span>
              <strong>Critical</strong>: when it scores 0 (a No), the QA agent can tick "Fail the whole audit" on it
            </span>
          </label>
          <label className="field-inline">
            <input type="checkbox" checked={m.allow_na} onChange={(e) => set({ allow_na: e.target.checked })} />
            <span>
              <strong>Allow N/A</strong>: the QA agent can mark it not applicable
            </span>
          </label>
          <label className="field-inline">
            <input type="checkbox" checked={!!m.na_receiver} onChange={(e) => set({ na_receiver: e.target.checked })} />
            <span>
              <strong>Takes N/A weight</strong>: when another metric is N/A, this one carries a share of its weight, in proportion to its own points (none while it is N/A itself)
            </span>
          </label>
        </div>
      ) : (
        <p className="hint-text">A comment box: no points, just written feedback for the agent.</p>
      )}
      {problems.length ? (
        <div className="inline-warning" style={{ margin: 0, display: 'grid', gap: 2 }}>
          {problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      ) : null}
    </Modal>
  )
}
