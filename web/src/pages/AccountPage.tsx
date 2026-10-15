import { useState } from 'react'
import { api } from '../api/client'
import { ROLE_LABEL, useAuth } from '../auth/AuthContext'
import { errorText } from '../components/bits'

/** forced: shown in place of every page until a temporary password is changed. */
export function AccountPage({ forced = false }: { forced?: boolean }) {
  const { user, setToken, setUser } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    if (next !== confirm) {
      setMsg({ ok: false, text: 'The two new passwords do not match.' })
      return
    }
    setBusy(true)
    try {
      const res = await api.changePassword(current, next)
      setToken(res.token)
      setUser(await api.me())
      setCurrent('')
      setNext('')
      setConfirm('')
      setMsg({ ok: true, text: 'Password changed.' })
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">{forced ? 'Choose your password' : 'My account'}</h1>
          <p className="page-subtitle">
            {user?.name} · {user?.email} · {user ? ROLE_LABEL[user.role] : ''}
          </p>
        </div>
      </div>
      {forced ? (
        <div className="inline-note">You signed in with a temporary password. Pick your own to continue.</div>
      ) : null}
      <section className="card">
        <div className="card-header">
          <h2 className="card-title">Change password</h2>
        </div>
        <form
          className="card-body form-grid"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {msg ? <div className={msg.ok ? 'inline-success' : 'inline-warning'}>{msg.text}</div> : null}
          <div className="field">
            <label className="field-label">Current password</label>
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">New password (8+ characters)</label>
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">Repeat new password</label>
            <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          <div>
            <button className="btn btn-primary" type="submit" disabled={busy || !current || next.length < 8}>
              Save password
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
