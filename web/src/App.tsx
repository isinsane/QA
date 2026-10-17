import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, homePathForRole, useAuth } from './auth/AuthContext'
import { LoginPage } from './auth/LoginPage'
import { AppShell } from './layout/AppShell'
import { ThemeProvider } from './theme/ThemeContext'
import { AccountPage } from './pages/AccountPage'
import { AgentPage } from './pages/AgentPage'
import { AgentsPage } from './pages/AgentsPage'
import { ApprovalsPage } from './pages/ApprovalsPage'
import { CoachingPage } from './pages/CoachingPage'
import { DashboardPage } from './pages/DashboardPage'
import { DepartmentsPage } from './pages/DepartmentsPage'
import { DisputesPage } from './pages/DisputesPage'
import { EscalationsPage, NEGATIVES, ReportedPage, TL_ESCALATIONS } from './pages/ReportedPage'
import { SettingsPage } from './pages/SettingsPage'
import { ImportsPage } from './pages/ImportsPage'
import { MyAuditsPage } from './pages/MyAuditsPage'
import { MyScoresPage } from './pages/MyScoresPage'
import { ProductivityPage } from './pages/ProductivityPage'
import { QueuePage } from './pages/QueuePage'
import { TaskPage } from './pages/TaskPage'
import { TasksPage } from './pages/TasksPage'
import { TaskTypesPage } from './pages/TaskTypesPage'
import { TeamPage } from './pages/TeamPage'

function Home() {
  const { user } = useAuth()
  return <Navigate to={user ? homePathForRole(user.role) : '/login'} replace />
}

function LoginRoute() {
  const { user } = useAuth()
  return user ? <Navigate to={homePathForRole(user.role)} replace /> : <LoginPage />
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route element={<AppShell />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/tasks/:taskId" element={<TaskPage />} />
              <Route path="/imports" element={<ImportsPage />} />
              <Route path="/task-types" element={<TaskTypesPage />} />
              <Route path="/team" element={<TeamPage />} />
              <Route path="/coaching" element={<CoachingPage />} />
              <Route path="/disputes" element={<DisputesPage />} />
              <Route path="/escalations" element={<EscalationsPage />} />
              <Route path="/approvals" element={<ApprovalsPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/qa-productivity" element={<ProductivityPage />} />
              <Route path="/agents/:agentId" element={<AgentPage />} />
              <Route path="/my-audits" element={<MyAuditsPage />} />
              <Route path="/negatives" element={<ReportedPage cfg={NEGATIVES} />} />
              <Route path="/tl-escalations" element={<ReportedPage cfg={TL_ESCALATIONS} />} />
              <Route path="/departments" element={<DepartmentsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="/queue/:taskId" element={<QueuePage />} />
              <Route path="/my-scores" element={<MyScoresPage />} />
              <Route path="/my-scores/:taskId" element={<TaskPage />} />
              <Route path="/account" element={<AccountPage />} />
            </Route>
            <Route path="*" element={<Home />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
