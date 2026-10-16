import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, setAuthToken } from '../api/client'
import type { Role, User } from '../api/types'

interface AuthValue {
  user: User | null
  signIn: (email: string, password: string) => Promise<User>
  signOut: () => void
  setUser: (u: User) => void
  setToken: (token: string) => void
}

const AuthContext = createContext<AuthValue | null>(null)
const USER_KEY = 'qa.user'
const TOKEN_KEY = 'qa.token'

export function homePathForRole(role: Role): string {
  switch (role) {
    case 'qa_agent':
      return '/queue'
    case 'employee':
      return '/my-scores'
    case 'negative_agent':
      return '/negatives'
    case 'team_leader':
      return '/tl-escalations'
    default:
      return '/dashboard'
  }
}

/** Managers see everything in the sidebar; QA agents and employees only
 * their own pages (plus a task they were sent to). */
export function canAccessPath(role: Role, path: string): boolean {
  if (path === '/account') return true
  if (role === 'admin' || role === 'supervisor') {
    return !path.startsWith('/queue') && !path.startsWith('/my-scores') && !path.startsWith('/my-audits') && ((path !== '/departments' && path !== '/settings') || role === 'admin')
  }
  if (role === 'qa_agent') return path.startsWith('/queue') || path.startsWith('/tasks/') || path.startsWith('/escalations') || path.startsWith('/my-audits') || path.startsWith('/coaching') || path.startsWith('/agents')
  if (role === 'negative_agent') return path.startsWith('/negatives')
  if (role === 'team_leader') return path.startsWith('/tl-escalations')
  return path.startsWith('/my-scores')
}

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage disabled: the session just does not survive a reload */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => {
    const token = read<string>(TOKEN_KEY)
    if (token) setAuthToken(token)
    return token ? read<User>(USER_KEY) : null
  })

  const setUser = useCallback((u: User) => {
    write(USER_KEY, u)
    setUserState(u)
  }, [])

  const setToken = useCallback((token: string) => {
    write(TOKEN_KEY, token)
    setAuthToken(token)
  }, [])

  const clear = useCallback(() => {
    write(USER_KEY, null)
    write(TOKEN_KEY, null)
    setAuthToken(null)
    setUserState(null)
  }, [])

  // Re-read the signed-in user on load so role or department changes apply;
  // a dead token falls back to the login page.
  useEffect(() => {
    if (!user) return
    api.me().then(setUser).catch(clear)
    const onUnauthorized = () => clear()
    window.addEventListener('qa:unauthorized', onUnauthorized)
    return () => window.removeEventListener('qa:unauthorized', onUnauthorized)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await api.login(email.trim(), password)
      setToken(res.token)
      setUser(res.user)
      return res.user
    },
    [setToken, setUser],
  )

  const signOut = useCallback(() => {
    void api.logout().catch(() => undefined)
    clear()
  }, [clear])

  const value = useMemo(() => ({ user, signIn, signOut, setUser, setToken }), [user, signIn, signOut, setUser, setToken])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  supervisor: 'Supervisor',
  qa_agent: 'QA agent',
  employee: 'Agent',
  negative_agent: 'Negatives agent',
  team_leader: 'Team leader',
}
