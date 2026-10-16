import { useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { canAccessPath, homePathForRole, useAuth } from '../auth/AuthContext'
import { AccountPage } from '../pages/AccountPage'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'

const TITLES: [string, string][] = [
  ['/dashboard', 'Dashboard'],
  ['/tasks/', 'Details'],
  ['/tasks', 'All tasks'],
  ['/imports', 'Imports'],
  ['/task-types', 'Task types'],
  ['/team', 'Team'],
  ['/coaching', 'Coaching'],
  ['/disputes', 'Disputes'],
  ['/escalations', 'Escalations'],
  ['/approvals', 'Approvals'],
  ['/my-audits', 'My audits'],
  ['/agents/', 'Agent'],
  ['/agents', 'Agents'],
  ['/negatives', 'Negatives'],
  ['/tl-escalations', 'Team leader escalations'],
  ['/departments', 'Departments'],
  ['/settings', 'Settings'],
  ['/queue', 'Workspace'],
  ['/my-scores', 'My profile'],
  ['/account', 'My account'],
]

const COLLAPSED_KEY = 'qa.sidebar.collapsed'

export function AppShell() {
  const { user } = useAuth()
  const location = useLocation()
  // QA agents start collapsed: the workspace needs the width for the scorecard.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = window.localStorage.getItem(COLLAPSED_KEY)
      return saved === null ? user?.role === 'qa_agent' : saved === '1'
    } catch {
      return user?.role === 'qa_agent'
    }
  })

  if (!user) return <Navigate to="/login" replace />
  if (!canAccessPath(user.role, location.pathname)) return <Navigate to={homePathForRole(user.role)} replace />

  const noSidebar = user.role === 'employee' || user.role === 'negative_agent' || user.role === 'team_leader'
  const title = TITLES.find(([p]) => location.pathname.startsWith(p))?.[1] ?? 'QA Portal'

  function toggle() {
    setCollapsed((prev) => {
      try {
        window.localStorage.setItem(COLLAPSED_KEY, prev ? '0' : '1')
      } catch {
        /* preference just does not persist */
      }
      return !prev
    })
  }

  return (
    <div className={`shell${noSidebar ? ' shell-nosidebar' : ''}${!noSidebar && collapsed ? ' shell-collapsed' : ''}`}>
      {noSidebar ? null : <Sidebar collapsed={collapsed} onToggle={toggle} />}
      <div className="shell-main">
        <Topbar title={title} showBrand={noSidebar} />
        <div className="shell-content">
          {/* A password an admin set is temporary: nothing else until it is changed. */}
          {user.must_change_password ? <AccountPage forced /> : <Outlet />}
        </div>
      </div>
    </div>
  )
}
