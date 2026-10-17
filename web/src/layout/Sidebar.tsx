import { Link, NavLink } from 'react-router-dom'
import {
  Building2,
  CheckCheck,
  ClipboardCheck,
  ClipboardList,
  GraduationCap,
  Headphones,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  MessageSquareWarning,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Siren,
  Timer,
  Upload,
  UserSearch,
  Users,
} from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { initials, ROLE_LABEL, useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/BrandMark'

// View-only accounts see what admins see (every team); team leaders what a supervisor sees (their team).
const MANAGER = ['admin', 'supervisor', 'viewer', 'team_leader']
const ADMIN = ['admin', 'viewer']
const QA = ['qa_agent']

const NAV = [
  { to: '/tl-escalations', label: 'TL escalations', icon: Siren, roles: ['team_leader'] },
  { to: '/queue', label: 'Workspace', icon: Headphones, roles: QA },
  { to: '/my-audits', label: 'My audits', icon: ClipboardCheck, roles: QA },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: [...MANAGER, ...QA] },
  { to: '/agents', label: 'Agents', icon: UserSearch, roles: [...MANAGER, ...QA] },
  { to: '/tasks', label: 'All tasks', icon: ListChecks, roles: MANAGER },
  { to: '/qa-productivity', label: 'QA productivity', icon: Timer, roles: [...MANAGER, ...QA] },
  { to: '/disputes', label: 'Disputes', icon: MessageSquareWarning, roles: MANAGER },
  { to: '/approvals', label: 'Approvals', icon: CheckCheck, roles: MANAGER },
  { to: '/escalations', label: 'Escalations', icon: Megaphone, roles: [...MANAGER, ...QA] },
  { to: '/coaching', label: 'Coaching', icon: GraduationCap, roles: [...MANAGER, ...QA] },
  { to: '/imports', label: 'Imports', icon: Upload, roles: MANAGER },
  { to: '/task-types', label: 'Task types', icon: ClipboardList, roles: MANAGER },
  { to: '/team', label: 'Team', icon: Users, roles: MANAGER },
  { to: '/departments', label: 'Departments', icon: Building2, roles: ADMIN },
  { to: '/settings', label: 'Settings', icon: Settings, roles: ADMIN },
]

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { user } = useAuth()
  const role = user?.role ?? 'employee'
  const qa = role === 'qa_agent'
  // Disputes waiting for the supervisor, and escalations to check (a QA agent's own), shown on the nav items.
  const waiting = useApi(() => (qa ? Promise.resolve(null) : api.tasks({ state: 'dispute_supervisor' })), [qa], { pollMs: 60_000 })
  const approvals = useApi(() => (qa ? Promise.resolve(null) : api.changes({ status: 'pending' })), [qa], { pollMs: 60_000 })
  const toCheck = useApi(() => api.escalations({ state: 'review', mine: qa ? 1 : undefined }), [qa], { pollMs: 60_000 })
  const badge: Record<string, number | undefined> = {
    '/disputes': waiting.data?.total,
    '/escalations': toCheck.data?.total,
    '/approvals': approvals.data?.total,
  }

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-mark">
          <BrandMark size={19} />
        </span>
        <span className="brand-text">
          <span className="brand-title">QA Portal</span>
        </span>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <nav className="sidebar-nav">
        {NAV.filter((n) => n.roles.includes(role)).map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            title={collapsed ? label : undefined}
          >
            <span className="nav-icon">
              <Icon size={18} strokeWidth={2} />
            </span>
            <span className="nav-label">{label}</span>
            {badge[to] ? <span className="nav-count">{badge[to]}</span> : null}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        <Link to="/account" className="user-card" title="My account">
          <span className="avatar">{initials(user?.name ?? '')}</span>
          <span className="user-meta">
            <span className="user-name">{user?.name}</span>
            <span className="user-role">{user?.email}</span>
          </span>
          <span className="badge badge-brand">{user ? ROLE_LABEL[user.role] : ''}</span>
        </Link>
      </div>
    </aside>
  )
}
