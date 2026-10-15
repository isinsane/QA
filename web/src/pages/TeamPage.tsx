import { useMemo, useState } from 'react'
import { FileUp, KeyRound, Pencil, UserPlus } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import type { RosterResult, Role, User } from '../api/types'
import { ROLE_LABEL, useAuth } from '../auth/AuthContext'
import { errorText } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'

const FILTERS: { key: Role | 'all'; label: string }[] = [
  { key: 'all', label: 'Everyone' },
  { key: 'supervisor', label: 'Supervisors' },
  { key: 'qa_agent', label: 'QA agents' },
  { key: 'employee', label: 'Agents' },
  { key: 'negative_agent', label: 'Negatives agents' },
  { key: 'team_leader', label: 'Team leaders' },
  { key: 'admin', label: 'Admins' },
]

type Dialog = { kind: 'edit'; user: Partial<User> } | { kind: 'password'; user: User } | { kind: 'roster' } | null

export function TeamPage() {
  const { user: me } = useAuth()
  const isAdmin = me?.role === 'admin'
  const users = useApi(() => api.users(), [])
  const depts = useApi(() => api.departments(), [])
  const { toasts, push } = useToasts()
  const [filter, setFilter] = useState<Role | 'all'>('all')
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)

  const deptName = (id: string | null) => depts.data?.find((d) => d.id === id)?.name ?? '—'
  const list = useMemo(
    () =>
      (users.data ?? []).filter(
        (u) =>
          (filter === 'all' || u.role === filter) &&
          `${u.name} ${u.alias_name} ${(u.sheet_names ?? []).join(' ')} ${u.email ?? ''} ${u.agent_code ?? ''} ${u.profile?.job_title ?? ''}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [users.data, filter, search],
  )

  async function done(text: string) {
    push('success', text)
    setDialog(null)
    await users.reload()
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-subtitle">
            Agents come from the HR sheet; upload it again whenever HR updates it. Calls match on the Vonage ID (linked by name the
            first time an agent appears), tickets on the eDesk email; the eDesk ID fills in from each ticket pull.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'roster' })}>
            <FileUp size={16} />
            Upload HR sheet
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setDialog({ kind: 'edit', user: { role: 'employee', active: true, queue_limit: 12, department_id: me?.department_id ?? null } })}
          >
            <UserPlus size={16} />
            Add person
          </button>
        </div>
      </div>

      <div className="queue-filters" style={{ marginBottom: 14 }}>
        {FILTERS.filter((f) => isAdmin || (f.key !== 'admin' && f.key !== 'supervisor')).map((f) => (
          <button key={f.key} className={`filter-chip${filter === f.key ? ' active' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
        <input
          className="input"
          style={{ maxWidth: 260, marginLeft: 'auto' }}
          placeholder="Search name, alias, email, Agent ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <section className="card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Job title</th>
                <th>Role</th>
                <th>Department</th>
                <th>Email</th>
                <th>Vonage / eDesk ID</th>
                <th title="Most audits the assignment pass gives at once. 0 = no cap.">Queue cap</th>
                <th>Can sign in</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <strong>{u.name}</strong>
                    {u.alias_name ? <div className="text-tertiary">alias {u.alias_name}</div> : null}
                    {u.sheet_names?.length ? <div className="text-tertiary">in Vonage as {u.sheet_names.join(', ')}</div> : null}
                  </td>
                  <td title={u.profile?.supervisor ? `Reports to ${u.profile.supervisor}` : undefined}>
                    {u.profile?.job_title ?? <span className="text-tertiary">—</span>}
                  </td>
                  <td>
                    <span className={`badge ${u.role === 'employee' ? 'badge-gray' : 'badge-brand'}`}>{ROLE_LABEL[u.role]}</span>
                  </td>
                  <td>{u.role === 'admin' ? 'All' : deptName(u.department_id)}</td>
                  <td>{u.email ?? <span className="text-tertiary">—</span>}</td>
                  <td className="mono">
                    {u.agent_code || u.edesk_id ? (
                      [u.agent_code, u.edesk_id].filter(Boolean).join(' / ')
                    ) : (
                      <span className="text-tertiary">—</span>
                    )}
                  </td>
                  <td>{u.role === 'qa_agent' ? u.queue_limit || 'no cap' : ''}</td>
                  <td>{u.has_password ? 'Yes' : <span className="text-tertiary">default</span>}</td>
                  <td>
                    {!u.active ? (
                      <span className="badge badge-gray">inactive</span>
                    ) : u.role === 'qa_agent' ? (
                      <span className={`badge ${u.is_available ? 'badge-success' : 'badge-gray'}`}>
                        {u.is_available ? 'online' : 'offline'}
                      </span>
                    ) : (
                      <span className="badge badge-success">active</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'edit', user: u })}>
                      <Pencil size={14} />
                      Edit
                    </button>{' '}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setDialog({ kind: 'password', user: u })}
                      disabled={!u.email}
                      title={u.email ? 'Set a temporary password' : 'Add an email first'}
                    >
                      <KeyRound size={14} />
                      Password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!users.loading && list.length === 0 ? <div className="empty-state">Nobody here yet.</div> : null}
      </section>

      {dialog?.kind === 'edit' ? (
        <UserDialog
          initial={dialog.user}
          isAdmin={isAdmin}
          depts={depts.data ?? []}
          onClose={() => setDialog(null)}
          onSaved={(text) => void done(text)}
          onError={(text) => push('error', text)}
        />
      ) : null}
      {dialog?.kind === 'password' ? (
        <PasswordDialog user={dialog.user} onClose={() => setDialog(null)} onSaved={(t) => void done(t)} onError={(t) => push('error', t)} />
      ) : null}
      {dialog?.kind === 'roster' ? (
        <RosterDialog
          isAdmin={isAdmin}
          onClose={() => setDialog(null)}
          onSaved={(t) => void done(t)}
          onError={(t) => push('error', t)}
        />
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}

interface DialogProps {
  onClose: () => void
  onSaved: (text: string) => void
  onError: (text: string) => void
}

function UserDialog({
  initial,
  isAdmin,
  depts,
  onClose,
  onSaved,
  onError,
}: DialogProps & { initial: Partial<User>; isAdmin: boolean; depts: { id: string; name: string }[] }) {
  const [u, setU] = useState<Partial<User>>(initial)
  const [busy, setBusy] = useState(false)
  const roles: Role[] = isAdmin
    ? ['employee', 'team_leader', 'qa_agent', 'negative_agent', 'supervisor', 'admin']
    : ['employee', 'team_leader', 'qa_agent', 'negative_agent']
  const set = (patch: Partial<User>) => setU((prev) => ({ ...prev, ...patch }))
  const fromHR = !!initial.hr_id

  async function save() {
    setBusy(true)
    try {
      const body: Partial<User> = {
        name: u.name,
        email: u.email ?? '',
        role: u.role,
        agent_code: u.agent_code ?? '',
        sheet_names: u.sheet_names ?? [],
        edesk_id: u.edesk_id ?? '',
        queue_limit: Number(u.queue_limit ?? 12),
        active: u.active,
        ...(isAdmin && u.department_id ? { department_id: u.department_id } : {}),
      }
      if (u.id) await api.updateUser(u.id, body)
      else await api.createUser(body)
      onSaved(u.id ? 'Saved' : 'Added')
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={u.id ? `Edit ${initial.name}` : 'Add person'}
      subtitle={fromHR ? `From the HR sheet · Employee ID ${initial.hr_id}${initial.profile?.job_title ? ` · ${initial.profile.job_title}` : ''}` : undefined}
      size="md"
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !u.name?.trim()}>
            {u.id ? 'Save changes' : 'Add'}
          </button>
        </>
      }
    >
      <div className="form-section">Who</div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">Name</label>
          <input className="input" autoFocus value={u.name ?? ''} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label">Email {u.role === 'employee' ? '(also the eDesk login for tickets)' : ''}</label>
          <input className="input" type="email" value={u.email ?? ''} onChange={(e) => set({ email: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">Role</label>
          <select className="select" value={u.role} onChange={(e) => set({ role: e.target.value as Role })}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        {isAdmin && u.role !== 'admin' ? (
          <div className="field">
            <label className="field-label">Team</label>
            <select className="select" value={u.department_id ?? ''} onChange={(e) => set({ department_id: e.target.value || null })}>
              <option value="">Pick one…</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {u.role === 'employee' ? (
        <>
          <div className="form-section">How the data finds them</div>
          <div className="form-row">
            <div className="field">
              <label className="field-label">Vonage ID (calls sheet)</label>
              <input className="input mono" value={u.agent_code ?? ''} onChange={(e) => set({ agent_code: e.target.value })} />
            </div>
            <div className="field">
              <label className="field-label">eDesk ID</label>
              <input className="input mono" value={u.edesk_id ?? ''} onChange={(e) => set({ edesk_id: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label className="field-label">Other spellings in Vonage sheets (comma-separated)</label>
            <input
              className="input"
              placeholder="e.g. Bartholomew Alnoury"
              value={(u.sheet_names ?? []).join(', ')}
              onChange={(e) => set({ sheet_names: e.target.value.split(',').map((x) => x.trimStart()) })}
            />
          </div>
        </>
      ) : null}

      {u.role === 'qa_agent' ? (
        <>
          <div className="form-section">Queue</div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label className="field-label">Most audits at once (0 = no cap)</label>
            <input className="input" type="number" min={0} value={u.queue_limit ?? 12} onChange={(e) => set({ queue_limit: Number(e.target.value) })} />
          </div>
        </>
      ) : null}

      {u.id ? (
        <label className="field-inline">
          <input type="checkbox" checked={u.active ?? true} onChange={(e) => set({ active: e.target.checked })} />
          Active (an inactive QA agent hands their open audits back to the queue; an inactive agent is no longer audited)
        </label>
      ) : null}
    </Modal>
  )
}

function PasswordDialog({ user, onClose, onSaved, onError }: DialogProps & { user: User }) {
  const [pw, setPw] = useState('')
  return (
    <Modal
      title="Set a temporary password"
      subtitle={`${user.name} picks their own at first sign-in.`}
      size="sm"
      onClose={onClose}
      onSubmit={() =>
        void api
          .setUserPassword(user.id, pw)
          .then(() => onSaved(`Temporary password set for ${user.name}.`))
          .catch((err) => onError(errorText(err)))
      }
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={pw.length < 8}>
            Set password
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">Temporary password (8+ characters)</label>
        <input className="input" autoFocus autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
    </Modal>
  )
}

function RosterDialog({ isAdmin, onClose, onSaved, onError }: DialogProps & { isAdmin: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [deactivate, setDeactivate] = useState(false)
  const [preview, setPreview] = useState<RosterResult | null>(null)
  const [busy, setBusy] = useState(false)

  async function go(dryRun: boolean, deactivateMissing = deactivate) {
    if (!file) return
    setBusy(true)
    try {
      const res = await api.importRoster(file, dryRun, deactivateMissing)
      if (dryRun) setPreview(res)
      else
        onSaved(
          `HR sheet imported: ${res.added} added, ${res.updated} updated, ${res.deactivated} deactivated${res.errors.length ? `, ${res.errors.length} rows with problems` : ''}.`,
        )
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const skipped = Object.entries(preview?.skipped ?? {}).sort((a, b) => b[1] - a[1])
  const nothing = preview && preview.added + preview.updated + preview.deactivated === 0

  return (
    <Modal
      title="Upload HR sheet"
      subtitle={`The HR workbook's Employees tab. Only people in ${isAdmin ? 'the teams set up here' : 'your team'} are brought in.`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {preview ? (
            <button className="btn btn-primary" disabled={busy || !!nothing} onClick={() => void go(false)}>
              Apply changes
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy || !file} onClick={() => void go(true)}>
              {busy ? 'Reading…' : 'Preview'}
            </button>
          )}
        </>
      }
    >
      <p className="hint-text">
        People are matched by Employee ID, then email, so uploading a newer version updates names, emails, aliases, job titles and teams
        in place.
      </p>
      <input
        type="file"
        accept=".xlsx,.csv"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null)
          setPreview(null)
        }}
      />
      <label className="field-inline">
        <input
          type="checkbox"
          checked={deactivate}
          onChange={(e) => {
            setDeactivate(e.target.checked)
            if (preview) void go(true, e.target.checked)
          }}
        />
        Deactivate agents who are no longer in the sheet
      </label>
      {preview ? (
        <>
          <div className={nothing ? 'inline-note' : 'inline-success'}>
            {nothing
              ? `Everyone is already up to date (${preview.unchanged} people).`
              : `${preview.added} to add, ${preview.updated} to update, ${preview.deactivated} to deactivate, ${preview.unchanged} unchanged.`}
          </div>
          {preview.errors.length ? (
            <div className="inline-warning">
              {preview.errors.map((e) => (
                <div key={e.row}>
                  Row {e.row}: {e.message}
                </div>
              ))}
            </div>
          ) : null}
          {preview.changes.length ? (
            <div className="table-scroll" style={{ maxHeight: 300, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
              <table className="table">
                <tbody>
                  {preview.changes.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <span className={`badge ${c.action === 'added' ? 'badge-success' : c.action === 'deactivated' ? 'badge-warning' : 'badge-brand'}`}>
                          {c.action}
                        </span>
                      </td>
                      <td>{c.name}</td>
                      <td className="text-secondary">{c.department}</td>
                      <td className="text-tertiary">{c.fields?.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {skipped.length ? (
            <p className="hint-text text-tertiary">
              Not brought in (team not audited here): {skipped.map(([d, n]) => `${d || 'no department'} ${n}`).join(' · ')}
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}
