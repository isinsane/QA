import { Link, NavLink } from 'react-router-dom'
import {
  Building2,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  MessageSquareWarning,
  ThumbsDown,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Upload,
  Users,
} from 'lucide-react'
import { api } from '../api/client'
import { useApi } from '../api/useApi'
import { initials, ROLE_LABEL, useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/BrandMark'

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/tasks', label: 'All tasks', icon: ListChecks },
  { to: '/disputes', label: 'Disputes', icon: MessageSquareWarning },
  { to: '/negatives', label: 'Negatives', icon: ThumbsDown },
  { to: '/tl-escalations', label: 'TL escalations', icon: Megaphone },
  { to: '/coaching', label: 'Coaching', icon: GraduationCap },
  { to: '/imports', label: 'Imports', icon: Upload },
  { to: '/task-types', label: 'Task types', icon: ClipboardList },
  { to: '/team', label: 'Team', icon: Users },
  { to: '/departments', label: 'Departments', icon: Building2, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings, adminOnly: true },
]

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  // Disputes waiting for the supervisor, shown on the nav item.
  const waiting = useApi(() => api.tasks({ state: 'dispute_supervisor' }), [], { pollMs: 60_000 })
  const negatives = useApi(() => api.tasks({ kind: 'negative', state: 'review' }), [], { pollMs: 60_000 })
  const tl = useApi(() => api.tasks({ kind: 'tl_escalation', state: 'review' }), [], { pollMs: 60_000 })
  const badge: Record<string, number | undefined> = {
    '/disputes': waiting.data?.total,
    '/negatives': negatives.data?.total,
    '/tl-escalations': tl.data?.total,
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
        {NAV.filter((n) => !n.adminOnly || isAdmin).map(({ to, label, icon: Icon }) => (
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
