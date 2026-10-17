import type {
  Answer,
  Coaching,
  Department,
  EvaluationChange,
  ImportResult,
  ChatLine,
  ImportRun,
  RosterResult,
  Reports,
  AppSettings,
  AgentInfo,
  AgentRow,
  ReportAgent,
  ScoreResult,
  TaskDetail,
  TaskRow,
  TaskType,
  UploadResult,
  User,
} from './types'

let authToken: string | null = null

export function setAuthToken(token: string | null) {
  authToken = token
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  let res: Response
  try {
    res = await fetch(`/api${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(6 * 60_000) })
  } catch {
    throw new ApiError('Cannot reach the portal server. Check your connection and try again.', 0)
  }
  const text = await res.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${res.status})`
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('qa:unauthorized'))
    throw new ApiError(msg, res.status)
  }
  return payload as T
}

/** Fetches a file the API sends (with the sign-in header) and saves it under the name the server gives. */
async function download(path: string): Promise<void> {
  const headers = new Headers()
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`)
  let res: Response
  try {
    res = await fetch(`/api${path}`, { headers })
  } catch {
    throw new ApiError('Cannot reach the portal server. Check your connection and try again.', 0)
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(payload?.error ?? `Request failed (${res.status})`, res.status)
  }
  const blob = await res.blob()
  const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') ?? '')?.[1]
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name ? decodeURIComponent(name) : 'QA report.xlsx'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: JSON.stringify(body ?? {}) })

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/login', json('POST', { email, password })),
  me: () => request<User>('/me'),
  logout: () => request('/me/logout', json('POST')),
  changePassword: (current_password: string, new_password: string) =>
    request<{ token: string }>('/me/password', json('PATCH', { current_password, new_password })),
  setOnline: (online: boolean) => request<User>('/me/availability', json('PATCH', { online })),

  departments: () => request<Department[]>('/departments'),
  createDepartment: (name: string) => request<Department>('/departments', json('POST', { name })),
  updateDepartment: (id: string, d: { name: string; hr_names: string[] }) => request(`/departments/${id}`, json('PATCH', d)),

  users: (role?: string) => request<User[]>(`/users${qs({ role })}`),
  createUser: (u: Partial<User>) => request<User>('/users', json('POST', u)),
  updateUser: (id: string, u: Partial<User>) => request<User>(`/users/${id}`, json('PATCH', u)),
  deleteUser: (id: string) => request(`/users/${id}`, { method: 'DELETE' }),
  setUserPassword: (id: string, password: string) => request(`/users/${id}/password`, json('POST', { password })),
  importRoster: (file: File, dryRun: boolean, deactivateMissing: boolean) => {
    const fd = new FormData()
    fd.set('file', file)
    fd.set('dry_run', dryRun ? '1' : '0')
    fd.set('deactivate_missing', deactivateMissing ? '1' : '0')
    return request<RosterResult>('/users/import', { method: 'POST', body: fd })
  },

  taskTypes: () => request<TaskType[]>('/task-types'),
  createTaskType: (t: { department_id?: string; code: string; name: string; source: string }) =>
    request<TaskType>('/task-types', json('POST', t)),
  updateTaskType: (id: string, patch: Partial<TaskType>) => request<TaskType>(`/task-types/${id}`, json('PATCH', patch)),
  taskTypeLabels: (id: string) => request<{ label: string; rows: number }[]>(`/task-types/${id}/labels`),

  upload: (workDate: string, file: File, dryRun: boolean, departmentId = '') => {
    const fd = new FormData()
    fd.set('work_date', workDate)
    if (departmentId) fd.set('department_id', departmentId)
    fd.set('file', file)
    fd.set('dry_run', dryRun ? '1' : '0')
    return request<UploadResult>('/imports', { method: 'POST', body: fd })
  },
  pullTickets: (date: string) => request<ImportResult>('/imports/tickets', json('POST', { date })),
  pullChats: (task_type_id: string, date: string) => request<ImportResult>('/imports/chats', json('POST', { task_type_id, date })),
  taskChat: (id: string, refresh = false) => request<ChatLine[]>(`/tasks/${id}/chat${refresh ? '?refresh=1' : ''}`),
  imports: () => request<ImportRun[]>('/imports'),

  myQueue: () => request<TaskRow[]>('/me/queue'),
  myScores: () => request<TaskRow[]>('/me/scores'),
  mySummary: () => request<{ team: string }>('/me/summary'),
  settings: () =>
    request<{ settings: AppSettings; defaults: AppSettings; updated_at: string; updated_by: string | null }>('/settings'),
  saveSettings: (s: AppSettings) => request<AppSettings>('/settings', json('PUT', s)),
  tasks: (params: Record<string, string | number | undefined>) =>
    request<{ tasks: TaskRow[]; total: number; page: number; page_size: number }>(`/tasks${qs(params)}`),
  task: (id: string) => request<TaskDetail>(`/tasks/${id}`),
  taskEDesk: (id: string, refresh = false) =>
    request<Record<string, unknown>>(`/tasks/${id}/edesk${refresh ? '?refresh=1' : ''}`),
  submit: (id: string, answers: Answer[], order_numbers: string[]) =>
    request<{ result: ScoreResult; next_task_id: string | null }>(`/tasks/${id}/submit`, json('POST', { answers, order_numbers })),
  cantAudit: (id: string, reason: string) =>
    request<{ next_task_id: string | null }>(`/tasks/${id}/cant-audit`, json('POST', { reason })),
  editEvaluation: (id: string, answers: Answer[], reason: string, order_numbers: string[]) =>
    request<{ result: ScoreResult; pending: boolean }>(`/tasks/${id}/evaluation`, json('PUT', { answers, reason, order_numbers })),
  changes: (params: Record<string, string | number | undefined>) =>
    request<{ changes: EvaluationChange[]; total: number; page_size: number }>(`/evaluation-changes${qs(params)}`),
  approveChange: (id: string, note: string) => request(`/evaluation-changes/${id}/approve`, json('POST', { note })),
  rejectChange: (id: string, note: string) => request(`/evaluation-changes/${id}/reject`, json('POST', { note })),
  taskIds: (params: Record<string, string | number | undefined>) => request<{ ids: string[] }>(`/tasks${qs({ ...params, ids: '1' })}`),
  bulkReassign: (task_ids: string[], qa_id: string | null) =>
    request<{ moved: number; skipped: number }>('/tasks/bulk-reassign', json('POST', { task_ids, qa_id })),
  reassign: (id: string, qa_id: string) => request(`/tasks/${id}/reassign`, json('POST', { qa_id })),
  cancel: (id: string, reason: string) => request(`/tasks/${id}/cancel`, json('POST', { reason })),

  reports: (params: Record<string, string | undefined>) => request<Reports>(`/reports${qs(params)}`),
  agents: (params: Record<string, string | undefined>) =>
    request<{ from: string; to: string; agents: AgentRow[] }>(`/agents${qs(params)}`),
  agent: (id: string) => request<AgentInfo>(`/agents/${id}`),
  /** Excel workbook: ids (comma-separated) or department_id, plus from/to. */
  exportAgents: (params: Record<string, string | undefined>) => download(`/agents/export${qs(params)}`),

  // QA2
  teamAgents: () => request<{ id: string; name: string; alias_name: string; department: string }[]>('/team/agents'),
  liveFields: (taskTypeId: string) =>
    request<{ fields: string[]; label: string; optional: string[] }>(`/task-types/${taskTypeId}/live-fields`),
  startLive: (task_type_id: string, employee_id: string, details: Record<string, string>) =>
    request<{ id: string; live_started_at: string }>('/live', json('POST', { task_type_id, employee_id, details })),
  setLiveDetails: (id: string, details: Record<string, string>) => request(`/tasks/${id}/live`, json('PATCH', { details })),
  focusLabels: (p: { task_type_id: string; employee_id: string; from: string; to: string }) =>
    request<{ label: string; rows: number }[]>(`/focus/labels${qs(p)}`),
  focusPlan: (p: { task_type_id: string; employee_id: string; label: string; count: number; from: string; to: string }) =>
    request<{ pulled: number; asked: number }>('/focus', json('POST', p)),
  escalate: (p: { task_type_id: string; external_id: string; employee_id: string; reason: string }) =>
    request<{ task_id: string }>('/escalations', json('POST', p)),
  acknowledge: (id: string, comment: string) => request(`/tasks/${id}/acknowledge`, json('POST', { comment })),
  dispute: (id: string, comment: string) => request(`/tasks/${id}/dispute`, json('POST', { comment })),
  uphold: (id: string, comment: string) => request(`/tasks/${id}/uphold`, json('POST', { comment })),
  forwardDispute: (id: string, note: string) => request(`/tasks/${id}/dispute/forward`, json('POST', { note })),
  myDisputes: () => request<TaskRow[]>('/me/disputes'),
  // Escalations: path is '/negatives', '/tl-escalations' or '/qa-escalations'.
  reportAgents: (path: string) => request<ReportAgent[]>(`${path}/agents`),
  report: (path: string, p: { external_id: string; employee_id: string; error: string; task_type_id?: string }) =>
    request<{ id: string; task_type: string }>(path, json('POST', p)),
  myReports: (path: string) => request<TaskRow[]>(`${path}/mine`),
  decide: (id: string, valid: boolean, note: string) => request(`/tasks/${id}/decide`, json('POST', { valid, note })),
  escalations: (params: Record<string, string | number | undefined>) =>
    request<{ tasks: TaskRow[]; total: number; page_size: number }>(`/escalations${qs(params)}`),
  coachings: (params: Record<string, string | undefined> = {}) => request<Coaching[]>(`/coachings${qs(params)}`),
  logCoaching: (p: { employee_id: string; kind: string; topic: string; task_ids: string[]; notes: string; outcome: string }) =>
    request<Coaching>('/coachings', json('POST', p)),
  createCoaching: (p: { employee_id: string; topic: string; task_ids: string[]; assigned_qa_id: string; due_date: string }) =>
    request<Coaching>('/coachings', json('POST', p)),
  completeCoaching: (id: string, notes: string, outcome: string) =>
    request(`/coachings/${id}/complete`, json('POST', { notes, outcome })),
  ackCoaching: (id: string, comment: string) => request(`/coachings/${id}/acknowledge`, json('POST', { comment })),
}

