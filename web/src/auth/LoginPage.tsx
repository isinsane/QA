import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, ClipboardCheck, Eye, EyeOff, Layers, Loader2, Lock, Mail, Moon, Shuffle, Sun } from 'lucide-react'
import { BrandMark } from '../components/BrandMark'
import { useTheme } from '../theme/ThemeContext'
import { homePathForRole, useAuth } from './AuthContext'

export function LoginPage() {
  const { signIn } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      const user = await signIn(email, password)
      navigate(homePathForRole(user.role), { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <button
        type="button"
        className="btn btn-secondary btn-sm btn-icon auth-theme-toggle"
        onClick={toggleTheme}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      <div className="auth-form-side">
        <div className="auth-box">
          <div className="auth-brand">
            <span className="brand-mark">
              <BrandMark size={19} />
            </span>
            <span className="brand-text">
              <span className="brand-title">QA Portal</span>
            </span>
          </div>
          <h1 className="auth-title">Sign in</h1>
          <p className="auth-subtitle">Quality audits for calls, sales and tickets.</p>

          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            {error ? (
              <div className="auth-error" role="alert">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            ) : null}
            <div className="field">
              <label className="field-label" htmlFor="email">
                Work email
              </label>
              <div className="input-group">
                <span className="input-group-icon">
                  <Mail size={16} />
                </span>
                <input
                  id="email"
                  className="input"
                  type="email"
                  autoComplete="username"
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="password">
                Password
              </label>
              <div className="input-group">
                <span className="input-group-icon">
                  <Lock size={16} />
                </span>
                <input
                  id="password"
                  className="input"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="input-group-action"
                  onClick={() => setShow((v) => !v)}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  tabIndex={-1}
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || !email || !password}>
              {busy ? <Loader2 size={16} className="spin" /> : null}
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <p className="auth-hint">
            First time here? Sign in with your work email and the default password from your supervisor; you'll choose your own right
            after.
          </p>
        </div>
      </div>

      <aside className="auth-aside">
        <div className="aside-content">
          <h2 className="aside-title">Every agent audited, across the codes that matter.</h2>
          <p className="aside-text">
            Yesterday's calls and tickets come in each morning. A share of each agent's work is picked across
            different disposition codes and tags, and lands in the QA queue of the right department.
          </p>
        </div>
        <ul className="aside-points">
          <li className="aside-point">
            <span className="aside-point-icon">
              <Shuffle size={13} />
            </span>
            <span>Smart sampling: at least one audit per agent per day, spread across codes and tags.</span>
          </li>
          <li className="aside-point">
            <span className="aside-point-icon">
              <ClipboardCheck size={13} />
            </span>
            <span>Scorecards built by each supervisor, with notes the agent can read.</span>
          </li>
          <li className="aside-point">
            <span className="aside-point-icon">
              <Layers size={13} />
            </span>
            <span>Every edit after submission is logged.</span>
          </li>
        </ul>
      </aside>
    </div>
  )
}
