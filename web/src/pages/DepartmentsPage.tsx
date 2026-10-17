import { useState } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { useReadOnly } from '../auth/AuthContext'
import { errorText } from '../components/bits'
import { Modal } from '../components/Modal'
import { ToastStack, useToasts } from '../components/Toasts'

export function DepartmentsPage() {
  const readOnly = useReadOnly()
  const depts = useApi(() => api.departments(), [])
  const sups = useApi(() => api.users('supervisor'), [])
  const types = useApi(() => api.taskTypes(), [])
  const { toasts, push } = useToasts()
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string; hr: string } | null>(null)
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null)

  async function run(fn: () => Promise<unknown>, done: string) {
    try {
      await fn()
      push('success', done)
      await depts.reload()
    } catch (err) {
      push('error', errorText(err))
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Departments</h1>
          <p className="page-subtitle">
            A department is a QA team: one supervisor, its QA agents and its task types. It takes in the employees of one or more HR
            departments.
          </p>
        </div>
        {readOnly ? null : (
          <form
            className="page-actions"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => api.createDepartment(name), 'Department added').then(() => setName(''))
            }}
          >
            <input className="input" placeholder="New department name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
              <Plus size={16} />
              Add
            </button>
          </form>
        )}
      </div>
      <section className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Department</th>
              <th>HR departments it takes in</th>
              <th>Supervisor</th>
              <th>Task types</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(depts.data ?? []).map((d) => (
              <tr key={d.id}>
                <td>
                  {editing?.id === d.id ? (
                    <input
                      className="input"
                      autoFocus
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  ) : (
                    <strong>{d.name}</strong>
                  )}
                </td>
                <td>
                  {editing?.id === d.id ? (
                    <input
                      className="input"
                      placeholder="Comma-separated, as written in the HR sheet"
                      value={editing.hr}
                      onChange={(e) => setEditing({ ...editing, hr: e.target.value })}
                    />
                  ) : d.hr_names?.length ? (
                    d.hr_names.join(', ')
                  ) : (
                    <span className="text-tertiary">{d.name} (same name)</span>
                  )}
                </td>
                <td>
                  {(sups.data ?? []).find((s) => s.department_id === d.id && s.active)?.name ?? (
                    <span className="text-tertiary">none yet — add one on Team</span>
                  )}
                </td>
                <td>
                  {(types.data ?? [])
                    .filter((t) => t.department_id === d.id)
                    .map((t) => t.name)
                    .join(', ') || <span className="text-tertiary">none</span>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {editing?.id === d.id ? (
                    <>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() =>
                          void run(
                            () =>
                              api.updateDepartment(d.id, {
                                name: editing.name,
                                hr_names: editing.hr
                                  .split(',')
                                  .map((x) => x.trim())
                                  .filter(Boolean),
                              }),
                            'Saved',
                          ).then(() => setEditing(null))
                        }
                      >
                        Save
                      </button>{' '}
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </>
                  ) : readOnly ? null : (
                    <>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setEditing({ id: d.id, name: d.name, hr: (d.hr_names ?? []).join(', ') })}
                      >
                        Edit
                      </button>{' '}
                      <button className="btn btn-ghost btn-sm" onClick={() => setRemoving({ id: d.id, name: d.name })}>
                        Remove
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {removing ? (
        <Modal
          title={`Remove ${removing.name}?`}
          size="sm"
          onClose={() => setRemoving(null)}
          onSubmit={() => void run(() => api.deleteDepartment(removing.id), `${removing.name} removed`).then(() => setRemoving(null))}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setRemoving(null)}>
                Keep
              </button>
              <button type="submit" className="btn btn-danger">
                Remove
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>For a department added by mistake. Only an empty one can be removed: nobody in it and no task types.</p>
        </Modal>
      ) : null}
      <ToastStack toasts={toasts} />
    </div>
  )
}
