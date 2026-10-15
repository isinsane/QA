import { useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, Moon, Sun, User } from 'lucide-react'
import { api, ApiError } from '../api/client'
import { homePathForRole, useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/BrandMark'
import { useTheme } from '../theme/ThemeContext'

export function Topbar({ title, showBrand }: { title: string; showBrand: boolean }) {
  const { user, signOut, setUser } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const [busy, setBusy] = useState(false)

  async function toggleOnline() {
    if (!user) return
    setBusy(true)
    try {
      setUser(await api.setOnline(!user.is_available))
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : 'Could not update online status.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="topbar">
      {showBrand ? (
        <Link to={user ? homePathForRole(user.role) : '/'} className="topbar-brand">
          <span className="brand-mark brand-mark-sm" aria-hidden>
            <BrandMark size={15} />
          </span>
          <span className="topbar-title">{title}</span>
        </Link>
      ) : (
        <span className="topbar-title">{title}</span>
      )}

      <div className="topbar-actions" style={{ marginLeft: 'auto' }}>
        <button
          type="button"
          className="btn btn-secondary btn-sm btn-icon"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        {user?.role === 'qa_agent' ? (
          <button
            type="button"
            className={`online-toggle${user.is_available ? ' online' : ''}`}
            onClick={() => void toggleOnline()}
            disabled={busy}
            title={user.is_available ? 'Online: new audits come to your queue' : 'Offline: no new audits are assigned to you'}
          >
            <span className="online-dot" />
            {user.is_available ? 'Online' : 'Offline'}
          </button>
        ) : null}
        <Link to="/account" className="btn btn-secondary btn-sm">
          <User size={15} />
          Account
        </Link>
        <span className="topbar-user">{user?.name}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={signOut}>
          <LogOut size={15} />
          Sign out
        </button>
      </div>
    </header>
  )
}
