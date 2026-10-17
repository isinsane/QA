import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { useReadOnly } from '../auth/AuthContext'
import type { AgentLimits, AppSettings, Limit, TaskType } from '../api/types'
import { errorText, fmtDateTime } from '../components/bits'
import { LimitInput } from '../components/LimitInput'
import { ToastStack, useToasts } from '../components/Toasts'

const ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['Asia/Amman', 'America/New_York', 'UTC']
  }
})()

type Sampling = Pick<TaskType, 'sample_percent' | 'untagged_percent' | 'agent_limits'>

const samplingOf = (t: TaskType): Sampling => ({
  sample_percent: Number(t.sample_percent),
  untagged_percent: Number(t.untagged_percent),
  agent_limits: t.agent_limits ?? {},
})

/** One setting: what it is on the left, the control on the right (or below, when wide). */
function Row({ title, hint, wide, children }: { title: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`setting-row${wide ? ' is-wide' : ''}`}>
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {hint ? <div className="setting-hint">{hint}</div> : null}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function NumberInput({
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  value: number
  unit?: string
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
}) {
  return (
    <div className="input-unit">
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
      {unit ? <span>{unit}</span> : null}
    </div>
  )
}

/** Admin settings: what used to be fixed in code or the server's environment. */
export function SettingsPage() {
  const readOnly = useReadOnly()
  const loaded = useApi(() => api.settings(), [])
  const types = useApi(() => api.taskTypes(), [])
  const depts = useApi(() => api.departments(), [])
  // Sampling edits per task type, saved with the rest.
  const [sampling, setSampling] = useState<Record<string, Sampling>>({})
  const { toasts, push } = useToasts()
  const [s, setS] = useState<AppSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [hiddenDraft, setHiddenDraft] = useState('')
  const [ignoreDraft, setIgnoreDraft] = useState('')
  useEffect(() => {
    if (loaded.data) setS(loaded.data.settings)
  }, [loaded.data])

  const sampled = (types.data ?? []).filter((t) => t.source !== 'manual')
  const changedTypes = sampled.filter((t) => sampling[t.id] && JSON.stringify(sampling[t.id]) !== JSON.stringify(samplingOf(t)))
  if (!s || !loaded.data) return <div className="page">{loaded.error ? <div className="inline-warning">{loaded.error}</div> : null}</div>
  const defaults = loaded.data.defaults
  const settingsDirty = JSON.stringify(s) !== JSON.stringify(loaded.data.settings)
  const dirty = settingsDirty || changedTypes.length > 0
  const deptName = (id: string) => depts.data?.find((d) => d.id === id)?.name ?? ''
  const editType = (t: TaskType, patch: Partial<Sampling>) =>
    setSampling({ ...sampling, [t.id]: { ...(sampling[t.id] ?? samplingOf(t)), ...patch } })
  const setLimit = (t: TaskType, period: keyof AgentLimits, side: 'min' | 'max', l: Limit | null) => {
    const cur = sampling[t.id] ?? samplingOf(t)
    editType(t, { agent_limits: { ...cur.agent_limits, [period]: { ...cur.agent_limits[period], [side]: l } } })
  }
  const set = (patch: Partial<AppSettings>) => setS({ ...s, ...patch })
  const setType = (patch: Partial<AppSettings['new_task_type']>) => setS({ ...s, new_task_type: { ...s.new_task_type, ...patch } })
  const t = s.new_task_type
  const addHidden = () => {
    const v = hiddenDraft.trim()
    if (v) set({ live_hidden_columns: [...new Set([...s.live_hidden_columns, v])] })
    setHiddenDraft('')
  }
  const ignored = s.ignored_labels ?? []
  const addIgnored = () => {
    const v = ignoreDraft.trim()
    if (v) set({ ignored_labels: [...new Set([...ignored, v])] })
    setIgnoreDraft('')
  }

  async function save() {
    if (!s) return
    setBusy(true)
    try {
      if (settingsDirty) await api.saveSettings(s)
      for (const t of changedTypes) {
        try {
          await api.updateTaskType(t.id, sampling[t.id])
        } catch (err) {
          throw new Error(`${t.name}: ${errorText(err)}`)
        }
      }
      push('success', 'Settings saved')
      setSampling({})
      await Promise.all([loaded.reload(), types.reload()])
    } catch (err) {
      push('error', errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page settings-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">
            Applies to everyone as soon as you save.
            {loaded.data.updated_by ? ` Last changed by ${loaded.data.updated_by}, ${fmtDateTime(loaded.data.updated_at)}.` : ''}
          </p>
        </div>
        {readOnly ? null : (
          <div className="page-actions">
            <button className="btn btn-secondary" onClick={() => setS(defaults)} disabled={JSON.stringify(s) === JSON.stringify(defaults)}>
              <RotateCcw size={15} />
              Reset to defaults
            </button>
          </div>
        )}
      </div>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Clocks</h2>
          <p className="card-subtitle">Which day "yesterday" is, and the clock call times are written in.</p>
        </header>
        <Row title="Business time zone" hint={`"Yesterday" for uploads, report ranges, the ticket pull and rotation follow this clock.`}>
          <select className="select" value={s.business_timezone} onChange={(e) => set({ business_timezone: e.target.value })}>
            {ZONES.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Row>
        <Row title="Vonage clock" hint="The UTC offset Vonage sheets write start times in. Live audits are matched on it.">
          <div className="input-unit">
            <input
              className="input mono"
              placeholder="-05:00"
              value={s.call_utc_offset}
              onChange={(e) => set({ call_utc_offset: e.target.value })}
            />
            <span>UTC</span>
          </div>
        </Row>
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Live monitoring</h2>
          <p className="card-subtitle">How a live audit finds its call, and what the QA agent types in while listening.</p>
        </header>
        <Row title="Match window" hint="A live audit takes the agent's call that started this close to when the QA agent pressed Start.">
          <NumberInput value={s.live_window_seconds} unit="seconds" min={1} max={600} onChange={(v) => set({ live_window_seconds: v })} />
        </Row>
        <Row
          wide
          title="Columns not asked for"
          hint="Sheet columns Vonage fills in by itself. Every other column of the sheet is asked for when a live audit starts."
        >
          <div className="label-chips">
            {s.live_hidden_columns.length === 0 ? <span className="text-tertiary">None: every column is asked for.</span> : null}
            {s.live_hidden_columns.map((c) => (
              <button
                key={c}
                type="button"
                className="label-chip removable"
                title="Remove"
                onClick={() => set({ live_hidden_columns: s.live_hidden_columns.filter((x) => x !== c) })}
              >
                {c} ✕
              </button>
            ))}
          </div>
          <div className="builder-row">
            <input
              className="input"
              style={{ maxWidth: 280 }}
              placeholder="Column name, e.g. Handle time"
              value={hiddenDraft}
              onChange={(e) => setHiddenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addHidden()
                }
              }}
            />
            <button type="button" className="btn btn-secondary btn-sm" disabled={!hiddenDraft.trim()} onClick={addHidden}>
              Hide column
            </button>
          </div>
        </Row>
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Tickets</h2>
          <p className="card-subtitle">The daily pull from the QA API and how ticket picks are spread.</p>
        </header>
        <Row
          title="Daily pull starts at"
          hint={`Hour of the business clock (${s.business_timezone}) when yesterday's tickets are pulled. It retries until the pull succeeds.`}
        >
          <NumberInput value={s.tickets_pull_hour} unit=":00" min={0} max={23} onChange={(v) => set({ tickets_pull_hour: v })} />
        </Row>
        <Row
          title="Reply-count buckets"
          hint={`Picks are spread across tickets with ${Array.from({ length: Math.max(0, s.reply_buckets_top - 1) }, (_, i) => i + 1).join(', ')}${s.reply_buckets_top > 1 ? ' and ' : ''}${s.reply_buckets_top}+ replies.`}
        >
          <NumberInput value={s.reply_buckets_top} unit="+ replies" min={1} max={20} onChange={(v) => set({ reply_buckets_top: v })} />
        </Row>
        <Row
          title="Live chat lengths"
          hint={`Picks are spread across chats of ${[0, 1, 2].map((g) => `${g * s.chat_replies_per_group + 1}–${(g + 1) * s.chat_replies_per_group}`).join(', ')} and ${3 * s.chat_replies_per_group + 1}+ replies.`}
        >
          <NumberInput
            value={s.chat_replies_per_group}
            unit="replies a group"
            min={1}
            max={50}
            onChange={(v) => set({ chat_replies_per_group: v })}
          />
        </Row>
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Tags and codes to ignore</h2>
          <p className="card-subtitle">
            Tags and codes that say nothing about the work, like eDesk's language tags 9 and 10. They are dropped from every interaction of
            every type: they don't steer sampling, show on audits or count in reports. Each task type can ignore more of its own (Task types).
          </p>
        </header>
        <Row wide title="Ignored" hint="Saving also takes them off the work already imported. Case doesn't matter.">
          <div className="label-chips">
            {ignored.length === 0 ? <span className="text-tertiary">None: every tag and code counts.</span> : null}
            {ignored.map((c) => (
              <button
                key={c}
                type="button"
                className="label-chip removable"
                title="Stop ignoring"
                onClick={() => set({ ignored_labels: ignored.filter((x) => x !== c) })}
              >
                {c} ✕
              </button>
            ))}
          </div>
          <div className="builder-row">
            <input
              className="input"
              style={{ maxWidth: 280 }}
              placeholder="Tag or code, e.g. 9"
              value={ignoreDraft}
              onChange={(e) => setIgnoreDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addIgnored()
                }
              }}
            />
            <button type="button" className="btn btn-secondary btn-sm" disabled={!ignoreDraft.trim()} onClick={addIgnored}>
              Ignore
            </button>
          </div>
        </Row>
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Sampling by task type</h2>
          <p className="card-subtitle">
            How much of each agent's work becomes an audit, per task type (calls and sales are set apart). Leave a limit empty for none.
          </p>
        </header>
        {sampled.map((t) => {
          const v = sampling[t.id] ?? samplingOf(t)
          const word = t.source === 'tickets_api' || t.source === 'edesk_chats' ? 'tag' : 'code'
          return (
            <div className="sampling-row" key={t.id}>
              <div className="sampling-name">
                <strong>{t.name}</strong>
                <span className="text-tertiary">
                  {deptName(t.department_id)}
                  {t.active ? '' : ' · inactive'}
                </span>
              </div>
              <div className="sampling-grid">
                <label className="field">
                  <span className="field-label">With a {word}</span>
                  <NumberInput
                    value={v.sample_percent}
                    unit="% per agent"
                    min={0}
                    max={100}
                    step={0.5}
                    onChange={(x) => editType(t, { sample_percent: x })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Without a {word}</span>
                  <NumberInput
                    value={v.untagged_percent}
                    unit="% of all"
                    min={0}
                    max={100}
                    step={0.5}
                    onChange={(x) => editType(t, { untagged_percent: x })}
                  />
                </label>
                <div className="field">
                  <span className="field-label">At least, per agent per day</span>
                  <LimitInput compact value={v.agent_limits.day?.min} onChange={(l) => setLimit(t, 'day', 'min', l)} />
                </div>
                <div className="field">
                  <span className="field-label">At most, per agent per day</span>
                  <LimitInput compact value={v.agent_limits.day?.max} onChange={(l) => setLimit(t, 'day', 'max', l)} />
                </div>
                <div className="field">
                  <span className="field-label">At most, per agent per week</span>
                  <LimitInput compact value={v.agent_limits.week?.max} onChange={(l) => setLimit(t, 'week', 'max', l)} />
                </div>
              </div>
            </div>
          )
        })}
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Uploads</h2>
          <p className="card-subtitle">Checks that stop a sheet going to the wrong task type.</p>
        </header>
        <Row
          title="Refuse a sheet when this many rows are someone else's"
          hint="Share of rows that belong to agents the task type doesn't audit (a sales sheet uploaded as calls, say). Each task type sets who it audits on its Settings tab."
        >
          <NumberInput value={s.wrong_sheet_percent} unit="% of rows" min={1} max={100} onChange={(v) => set({ wrong_sheet_percent: v })} />
        </Row>
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Rotation (QA over QA)</h2>
          <p className="card-subtitle">For task types with rotation turned on: the same case scored blind by two QA agents.</p>
        </header>
        <Row
          title="Cases per QA agent per week"
          hint={
            s.rotation_cases_per_week > 0
              ? `Spread over the week from Monday${s.rotation_cases_per_week === 3 ? ' (Monday, Wednesday, Friday)' : ''}. Each is re-scored by a colleague after the task type's rotation days. 0 turns rotation off.`
              : 'Rotation is off for every team.'
          }
        >
          <NumberInput
            value={s.rotation_cases_per_week}
            unit="a week"
            min={0}
            max={50}
            onChange={(v) => set({ rotation_cases_per_week: v })}
          />
        </Row>
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Sign-in</h2>
          <p className="card-subtitle">How people who have no password yet get in.</p>
        </header>
        <Row
          title="Default password"
          hint={
            s.default_password
              ? "Anyone who hasn't chosen a password signs in with this once, then must choose their own. Changing it applies to everyone who hasn't signed in yet. Empty turns it off."
              : 'Off: an admin or supervisor sets each person a temporary password on the Team page.'
          }
        >
          <input
            className="input mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="off"
            value={s.default_password}
            onChange={(e) => set({ default_password: e.target.value })}
          />
        </Row>
        <Row
          wide
          title="HR employee IDs left out"
          hint="People removed on Team (duplicates in the HR sheet). The HR upload skips these IDs; remove one to bring that person back on the next upload."
        >
          <div className="label-chips">
            {(s.roster_ignore_ids ?? []).length === 0 ? <span className="text-tertiary">None.</span> : null}
            {(s.roster_ignore_ids ?? []).map((id) => (
              <button
                key={id}
                type="button"
                className="label-chip removable"
                title="Bring back on the next HR upload"
                onClick={() => set({ roster_ignore_ids: (s.roster_ignore_ids ?? []).filter((x) => x !== id) })}
              >
                {id} ✕
              </button>
            ))}
          </div>
        </Row>
      </section>

      <section className="card settings-card">
        <header className="settings-head">
          <h2 className="card-title">Defaults</h2>
          <p className="card-subtitle">What new QA agents and new task types start with. Existing ones keep their own values.</p>
        </header>
        <Row title="Queue cap for a new QA agent" hint="Most audits a QA agent holds at once. 0 means no cap.">
          <NumberInput value={s.default_queue_limit} unit="audits" min={0} onChange={(v) => set({ default_queue_limit: v })} />
        </Row>
        <Row title="Pass at" hint="A new task type's audits pass from this score.">
          <NumberInput value={t.pass_threshold} unit="%" min={0} max={100} onChange={(v) => setType({ pass_threshold: v })} />
        </Row>
        <Row title="Borderline from" hint="Below the pass mark but at least this is Borderline; lower is a Fail.">
          <NumberInput
            value={t.borderline_threshold}
            unit="%"
            min={0}
            max={t.pass_threshold}
            onChange={(v) => setType({ borderline_threshold: v })}
          />
        </Row>
        <Row title="Sample, with a code or tag" hint="Share of each agent's coded calls or tagged tickets that become audits.">
          <NumberInput value={t.sample_percent} unit="%" min={0} max={100} step={0.5} onChange={(v) => setType({ sample_percent: v })} />
        </Row>
        <Row title="Sample, without" hint="Share of everyone's uncoded or untagged work, pooled across the team.">
          <NumberInput
            value={t.untagged_percent}
            unit="%"
            min={0}
            max={100}
            step={0.5}
            onChange={(v) => setType({ untagged_percent: v })}
          />
        </Row>
        <Row title="At least, per agent per day" hint="Starting minimum for a new task type.">
          <NumberInput value={t.min_per_agent_per_day} unit="audits" min={0} onChange={(v) => setType({ min_per_agent_per_day: v })} />
        </Row>
        <Row title="At most, per agent per day" hint="Starting daily cap for a new task type. 0 means no cap.">
          <NumberInput value={t.max_per_agent_per_day} unit="audits" min={0} onChange={(v) => setType({ max_per_agent_per_day: v })} />
        </Row>
        <Row title="At most, per agent per week" hint="Starting weekly cap for a new task type. 0 means no cap.">
          <NumberInput value={t.max_per_agent_per_week} unit="audits" min={0} onChange={(v) => setType({ max_per_agent_per_week: v })} />
        </Row>
        <Row title="Rotation re-score after" hint="When rotation is on, a colleague re-scores the case blind after this many days.">
          <NumberInput value={t.rotation_days} unit="days" min={1} onChange={(v) => setType({ rotation_days: v })} />
        </Row>
      </section>

      <p className="hint-text settings-foot">The database, API keys and API addresses stay in the server's environment file.</p>

      {dirty && !readOnly ? (
        <div className="save-bar">
          <span>
            Unsaved settings
            {changedTypes.length ? ` (sampling for ${changedTypes.map((t) => t.name).join(', ')})` : ''}
          </span>
          <button
            className="btn btn-secondary"
            onClick={() => {
              setS(loaded.data!.settings)
              setSampling({})
            }}
          >
            Discard
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
            Save settings
          </button>
        </div>
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}
