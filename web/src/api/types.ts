export type Role = 'admin' | 'supervisor' | 'qa_agent' | 'employee' | 'negative_agent' | 'team_leader' | 'viewer'

export interface User {
  id: string
  name: string
  email: string | null
  role: Role
  department_id: string | null
  agent_code: string | null
  edesk_id: string | null
  active: boolean
  is_available: boolean
  queue_limit: number
  must_change_password: boolean
  has_password: boolean
  hr_id: string | null
  alias_name: string
  sheet_names: string[]
  profile: { department?: string; organization?: string; job_title?: string; supervisor?: string }
}

export interface RosterResult {
  /** Rows of people removed on Team, left out. */
  ignored: number
  added: number
  updated: number
  unchanged: number
  deactivated: number
  skipped: Record<string, number>
  changes: { name: string; action: 'added' | 'updated' | 'deactivated'; department: string; fields?: string[] }[]
  errors: { row: number; message: string }[]
  dry_run: boolean
}

export interface Department {
  id: string
  name: string
  hr_names: string[]
}

export type MetricType = 'yes_no' | 'scale' | 'dropdown' | 'text'

export interface Option {
  label: string
  points: number
}

export interface Metric {
  id: string
  label: string
  type: MetricType
  points?: number
  scale_max?: number
  options?: Option[]
  critical: boolean
  allow_na: boolean
  /** Takes a share of an N/A metric's weight. */
  na_receiver?: boolean
}

export interface Answer {
  metric_id: string
  value: string
  notes?: string
  /** The QA agent failed the whole audit on this critical metric (only counts when it lost points). */
  critical_fail?: boolean
}

export interface Columns {
  external_id: string
  agent_code: string
  agent_name: string
  label: string
  start_time: string
  /** A sheet shared by task types: this one takes only rows whose row_column is one of row_values. */
  row_column?: string
  row_values?: string[]
}

/** QA productivity: per QA agent, what they did in a period, and audits per hour / day / week / month. */
export interface QAProductivity {
  from: string
  to: string
  by: 'hour' | 'day' | 'week' | 'month'
  agents: {
    qa_id: string
    name: string
    team: string
    active: boolean
    online: boolean
    in_queue: number
    audits: number
    sample: number
    live: number
    escalation: number
    focus: number
    rotation: number
    avg_score: number | null
    pass: number
    borderline: number
    fail: number
    critical: number
    cant_audit: number
    checked: number
    coaching: number
    disputed: number
    score_changed: number
    active_hours: number
    /** Local wall-clock times. */
    first: string | null
    last: string | null
  }[]
  /** One QA agent's work in one bucket (local "YYYY-MM-DDTHH:MI"), by kind. */
  series: {
    qa_id: string
    bucket: string
    sample: number
    live: number
    escalation: number
    focus: number
    rotation: number
    coaching: number
    checked: number
    cant: number
  }[]
}

/** One piece of a QA agent's work, for a heat map cell. */
export interface QAWorkItem {
  at: string
  type: string
  task_id: string | null
  coaching_id: string | null
  agent: string
  type_name: string
  score: number | null
  result: Band | null
  critical_failed: boolean
  note: string
}

/** A team's finished audits its agents don't see yet. */
export interface HiddenScores {
  department_id: string
  team: string
  hidden: number
  last_revealed: string | null
}

/** An agent's disputes on audits of a period. */
export interface DisputeAgent {
  employee_id: string
  name: string
  team: string
  audits: number
  raised: number
  accepted: number
  rejected: number
  waiting: number
}

/** One message of a live chat. */
export interface ChatLine {
  at: number
  who: 'agent' | 'customer' | 'bot'
  name: string
  kind: string
  text: string
}

export interface ReportAgent {
  id: string
  name: string
  alias_name: string
  team: string
  department: string
  types: { id: string; name: string }[]
}

export interface AppSettings {
  business_timezone: string
  call_utc_offset: string
  live_window_seconds: number
  live_hidden_columns: string[]
  /** HR employee IDs the HR upload leaves out (people removed on Team). */
  roster_ignore_ids: string[]
  tickets_pull_hour: number
  reply_buckets_top: number
  chat_replies_per_group: number
  default_queue_limit: number
  default_password: string
  rotation_cases_per_week: number
  wrong_sheet_percent: number
  new_task_type: {
    pass_threshold: number
    borderline_threshold: number
    sample_percent: number
    untagged_percent: number
    rotation_days: number
    min_per_agent_per_day: number
    max_per_agent_per_day: number
    max_per_agent_per_week: number
  }
}

export type Source = 'sheet' | 'tickets_api' | 'manual' | 'edesk_chats'

/** A number of audits, or a percent of the agent's work in the period. */
export interface Limit {
  value: number
  unit: 'count' | 'percent'
}
export interface Bounds {
  min?: Limit | null
  max?: Limit | null
}
export interface AgentLimits {
  day?: Bounds
  week?: Bounds
  month?: Bounds
}

export interface TaskType {
  id: string
  department_id: string
  code: string
  name: string
  source: Source
  active: boolean
  scorecard: Metric[]
  pass_threshold: number
  borderline_threshold: number
  sample_percent: number
  untagged_percent: number
  skip_labels: string[]
  ignore_labels: string[]
  rotation_enabled: boolean
  rotation_days: number
  agent_limits: AgentLimits
  /** HR departments whose agents this type audits; empty = the whole team. */
  agent_groups: string[]
  columns: Columns
  updated_at?: string
}

export type TaskState = 'unsampled' | 'review' | 'ready' | 'assigned' | 'completed' | 'cancelled'
export type Kind = 'sample' | 'live' | 'escalation' | 'focus' | 'rotation' | 'negative' | 'tl_escalation' | 'qa_escalation'
export type Band = 'pass' | 'borderline' | 'fail'
export type AckStatus = '' | 'acknowledged' | 'disputed' | 'dispute_qa' | 'upheld' | 'changed'

export interface TaskRow {
  id: string
  external_id: string
  work_date: string
  state: TaskState
  labels: string[]
  score: number | null
  passed: boolean | null
  result: Band | null
  critical_failed: boolean
  completed_at: string | null
  task_type_id: string
  task_type_name: string
  employee_id: string
  employee_name: string
  assigned_qa_id: string | null
  qa_name?: string | null
  kind: Kind
  ack_status: AckStatus
  ack_comment: string
  ack_at: string | null
  dispute_resolution: string
  match_status: '' | 'pending' | 'matched' | 'flagged'
  priority: number
  note: string
  reported_by: string
  /** An escalation's decision note. */
  finding: string
  order_numbers: string[]
  /** When the agent got to see it; null = finished but not revealed yet. */
  revealed_at: string | null
  /** A QA agent's score change waits for a supervisor. */
  change_pending: boolean
  created_at: string
}

/** A QA agent's change to the score of an audit they submitted. */
export interface EvaluationChange {
  id: string
  task_id: string
  answers?: Answer[]
  reason: string
  score_before: number | null
  score: number | null
  status: 'pending' | 'approved' | 'rejected'
  decision_note: string
  created_at: string
  decided_at: string | null
  requested_by_name: string
  decided_by_name: string
  external_id?: string
  work_date?: string
  employee_name?: string
  task_type_name?: string
  ack_status?: AckStatus
}

export interface Task {
  id: string
  task_type_id: string
  employee_id: string
  external_id: string
  work_date: string
  labels: string[]
  data: Record<string, unknown>
  state: TaskState
  assigned_qa_id: string | null
  cancel_reason: string
  scorecard: Metric[] | null
  answers: Answer[] | null
  score: number | null
  critical_failed: boolean
  passed: boolean | null
  result: Band | null
  submitted_at: string | null
  completed_at: string | null
  kind: Kind
  note: string
  live_started_at: string | null
  match_status: '' | 'pending' | 'matched' | 'flagged'
  ack_status: AckStatus
  ack_comment: string
  ack_at: string | null
  dispute_resolution: string
  dispute_resolved_at: string | null
  finding: string
  /** The orders the work was about, as the QA agent entered them. */
  order_numbers: string[]
  /** When the agent got to see it; null = finished but not revealed yet. */
  revealed_at: string | null
}

export interface AuditEntry {
  id: number
  action: string
  detail: Record<string, unknown>
  created_at: string
  actor_name: string | null
}

export interface TaskDetail {
  task: Task
  task_type: Pick<TaskType, 'id' | 'name' | 'source' | 'pass_threshold' | 'scorecard' | 'columns' | 'department_id'> & {
    borderline_threshold?: number
  }
  employee: { id: string; name: string; agent_code: string | null; email: string | null }
  columns?: string[]
  qa_name?: string
  audit?: AuditEntry[]
  can_evaluate: boolean
  can_edit: boolean
  can_manage: boolean
  can_ack: boolean
  can_uphold: boolean
  can_forward: boolean
  can_decide: boolean
  can_approve: boolean
  changes?: EvaluationChange[]
  reported_by?: string
}

export interface ScoreResult {
  earned: number
  possible: number
  score: number | null
  critical_failed: boolean
  passed: boolean
  band: Band
}

export interface ImportRun {
  id: string
  task_type_id: string
  source: 'upload' | 'api'
  work_date: string
  filename: string
  rows_read: number
  created: number
  duplicates: number
  rejected: number
  skipped: number
  sampled: number
  status: string
  error: string
  started_at: string
  task_type_name?: string
  user_name?: string | null
}

export interface ImportResult {
  run: ImportRun
  rejected: { key: string; name: string; rows: number; reason?: string }[]
  linked: { key: string; name: string; user_name: string; how: 'name' | 'email' | 'similar name' }[] | null
  no_agent: number
  live_matched: number
  live_flagged: number
  employees: {
    employee_id: string
    name: string
    rows: number
    skipped: number
    sampled: number
    untagged: number
    labels: string[]
  }[]
  dry_run: boolean
}

/** One Vonage upload: what it did for each task type that takes rows from it. */
export interface UploadResult {
  parts: { task_type: string; result?: ImportResult; problem?: string }[]
  /** Rows no task type takes, by their value in the shared column. */
  unclaimed: Record<string, number>
  dry_run: boolean
}

export interface Coaching {
  id: string
  department_id: string
  employee_id: string
  employee_name: string
  topic: string
  kind: 'coaching' | 'refresher'
  /** Logged by a QA agent after the session; the agent doesn't acknowledge it. */
  logged: boolean
  task_ids: string[]
  assigned_qa_id: string
  qa_name: string
  created_by_name: string | null
  due_date: string | null
  status: 'open' | 'done'
  notes: string
  outcome: string
  completed_at: string | null
  ack_at: string | null
  ack_comment: string
  created_at: string
}

/** An agent in the directory, with their numbers for the period. */
export interface AgentRow {
  id: string
  name: string
  alias_name: string
  team: string
  department_id: string | null
  hr_department: string
  job_title: string
  evaluations: number
  avg_score: number | null
  pass_rate: number | null
  escalations: number
  last_audit: string | null
}

export interface AgentInfo {
  id: string
  name: string
  alias_name: string
  email: string | null
  agent_code: string | null
  active: boolean
  team: string
  profile: Record<string, string> | null
}

export interface Reports {
  from: string
  to: string
  totals: {
    evaluations: number
    avg_score: number | null
    pass_rate: number | null
    borderline_rate: number | null
    fail_rate: number | null
    critical_fails: number
    unacknowledged: number
    disputed: number
  }
  kinds: { kind: Kind; evaluations: number; open: number; flagged: number }[]
  queue: {
    task_type_id: string
    task_type_name: string
    imported: number
    unsampled: number
    ready: number
    assigned: number
    completed: number
    cancelled: number
  }[]
  employees: {
    employee_id: string
    name: string
    evaluations: number
    avg_score: number | null
    pass_rate: number | null
    borderline_rate: number | null
    critical_fails: number
  }[]
  trend: { week: string; evaluations: number; avg_score: number | null }[]
  by_label: { label: string; evaluations: number; avg_score: number | null }[]
  qa_activity: { qa_name: string; day: string; evaluations: number }[]
  failed: TaskRow[]
  metrics: { id: string; label: string; type: string; answered: number; na: number; zero: number; avg_pct: number | null }[]
  calibration: {
    pairs:
      | {
          case_id: string
          external_id: string
          task_type_name: string
          employee_name: string
          work_date: string
          first_qa: string
          first_score: number | null
          second_qa: string
          second_score: number | null
          gap: number | null
        }[]
      | null
    qa: { qa_name: string; reviews: number; avg_gap: number; avg_lean: number }[]
  }
}
