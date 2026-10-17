# QA Portal: Build Plan

Quality-audit system for the support departments. Each day's work comes in from sheets and
an API. A share of each employee's work is sampled into a department queue, picked to cover
as many different disposition codes or tags as possible. QA agents score it against a
scorecard the supervisor defines, and supervisors and employees see the results.

```
calls sheet (Vonage) ─┐
sales sheet (Vonage) ─┼─► importer.Ingest ─► rows (tasks: unsampled) ─► smart sample ─► ready
tickets (QA API)     ─┘   (employee match,                                              │
                           dedupe)                         dept-scoped auto-assign ◄────┘
                                                                     │
                                          QA agent's queue ─► scorecard ─► completed ─► reports
```

The system design and UI/UX come from `C:\Users\OAldesi\Desktop\followup-portal`.
This repo is built fresh, and reusable pieces are copied in, not imported.

---

## 1. Locked decisions

| Topic | Decision |
|---|---|
| Repo | New repo in `Desktop\QA`, same stack as followup-portal |
| Stack | Go + chi + GORM + Postgres, goose SQL migrations, React/Vite/TS SPA, same CSS theme |
| Roles | `admin`, `supervisor`, `qa_agent`, `employee` |
| Departments | A portal department is a **QA team**: exactly one supervisor, its QA agents and its task types. It takes in employees from one or more HR departments. Today there are two: **Calls & Sales** (HR Calls support + New Sales; one supervisor, shared QA agents, separate Calls and Sales calls task types with their own scorecards) and **Ticket support** |
| Task type | Belongs to one department. Calls audit, sales call audit and tickets audit to start. New types are data, not code |
| Productivity | Not tracked. No effort scores, urgency, SLA timers or wait conditions |
| Calls / sales intake | Daily upload of the Vonage "Disposition codes by interaction" sheet. The previous day's sheet is uploaded today. Both types use the same columns; only the task type and supervisor differ |
| Tickets intake | Daily pull from the eDesk Insight QA API (`QA_API_BASE_URL`) for the previous reporting day |
| Ticket details | eDesk official API `GET https://api.edesk.com/v1/tickets/{id}`, fetched when a QA agent opens the task and cached on it |
| Recordings | No URL in the sheet. The QA agent finds the call in Vonage by Interaction ID, using a copy button on the task page |
| Sampling | Per employee, per day: `ceil(X% × their rows)`, so anyone who worked gets at least 1 audit. Picks are spread across **different disposition codes / tags**. For tickets, about 20% of the picks are untagged tickets. A per-type skip list holds codes that are never sampled |
| Employees | Come from the HR sheet (its Employees tab), uploaded again whenever HR updates it. People are matched on HR Employee ID, then email. Only the audited departments are brought in: Calls support, Ticket support, New Sales and Marketplace support. Portal departments carry the same names as HR's |
| Queue | Auto-assign like followup: personal queues with a cap per QA agent, filled from the agent's own department only |
| Scorecard | Dynamic metrics per task type, managed by the supervisor (own department) and the admin |
| Score | Points converted to a %. On a **critical** metric that scored 0 (a No; since 17 Oct, partial credit doesn't), the QA agent can tick *Fail the whole audit*, which sets the score to 0 (since 16 Oct; before, earning 0 did it by itself). Every metric has an optional notes box |
| After submit | Locked for the QA agent. Only the supervisor or admin can edit, and every edit is audit-logged |
| Employees' view | They log in and see their own evaluations, read-only |

---

## 2. Roles & permissions

| Can… | Admin | Supervisor (own dept) | QA agent | Employee |
|---|---|---|---|---|
| Manage departments | ✅ | | | |
| Create, rename, deactivate task types (incl. sheet columns) | ✅ | ✅ | | |
| Manage users (incl. roster import) | ✅ all | ✅ own dept | | |
| Edit scorecard, sampling settings, pass threshold | ✅ | ✅ | | |
| Import sheets / trigger a ticket pull | ✅ | ✅ | | |
| Reassign / cancel tasks | ✅ | ✅ | | |
| Edit a submitted evaluation | ✅ | ✅ | | |
| Work queue, fill and submit scorecard, "Can't audit" | | | ✅ own dept | |
| Reports / monitoring | ✅ all | ✅ own dept | | |
| See own evaluations | | | | ✅ |

Department scoping lives in one helper (`scope(q, user)` adds `department_id = user.dept`
unless the user is an admin), and every list and report query goes through it.

---

## 3. Data model

There are six tables. Evaluation fields live on `tasks` because each task has at most one
evaluation.

**`departments`**: `id`, `name`.

**`users`**: `id`, `name`, `email` (unique, nullable; needed to log in, and it's how ticket rows match),
`role`, `department_id` (null only for admin), `agent_code` (unique, nullable; the Vonage
**Agent ID** that calls rows match on), `active`, `is_available` (QA online/offline),
`queue_limit` (default 12), `password_hash`, `must_change_password`, timestamps.
- `CHECK (role = 'admin' OR department_id IS NOT NULL)`
- Partial unique index `(department_id) WHERE role = 'supervisor' AND active`, which allows one supervisor per department.

**`sessions`**: copied from followup (hashed bearer tokens).

**`task_types`**: `id`, `department_id`, `code`, `name`, `active`,
`source` (`sheet` | `tickets_api`), `scorecard` JSONB (§4), `pass_threshold` (default 80), and sampling settings:
`sample_percent`, `skip_labels` text[], `untagged_share` (default 0.20).
- `columns` JSONB holds the sheet headers the importer needs. Calls and sales use
  `{"external_id": "Interaction ID", "agent_code": "Agent ID", "label": "Disposition code"}`.

**`import_runs`**: `id`, `task_type_id`, `source` (`upload` | `api`), `work_date`, `filename`, `user_id`,
`rows_read`, `created`, `duplicates`, `rejected`, `skipped`, `sampled`, `status`, `error`, `detail` JSONB (rejected agents), timestamps.

**`tasks`**: one row per imported item, sampled or not.

| Field | Notes |
|---|---|
| `id`, `task_type_id`, `import_run_id` | |
| `external_id` | Interaction ID or ticket ID |
| `employee_id` | `UNIQUE (task_type_id, external_id, employee_id)`. A transferred call has the same Interaction ID for both agents, and a ticket can be answered by two agents; each agent's part is its own row |
| `work_date` | The day the work happened: the date chosen at upload (default yesterday), or the ticket reporting day. All reports use it |
| `labels` text[] | Disposition code (calls) or tag names (tickets). Sampling and reports use it |
| `data` JSONB | The full sheet row or ticket JSON, shown on the task page. `data.edesk` holds the cached eDesk ticket info |
| `state` | `unsampled` → `ready` → `assigned` → `completed`, plus `cancelled` from ready or assigned |
| `assigned_qa_id`, `assigned_at`, `queue_position` | |
| `cancel_reason` | Supervisor cancel or QA "Can't audit" |
| `scorecard` JSONB | Snapshot of the type's scorecard at submit time |
| `answers` JSONB | `[{metric_id, value, notes}]` |
| `score` numeric, `critical_failed` bool, `passed` bool | Computed server-side, never sent by the client |
| `evaluated_by`, `submitted_at`, `completed_at`, timestamps | |

**`audit_logs`**: `id`, `task_id`, `actor_id`, `action`, `detail` JSONB (before/after), `created_at`.
Covers assignment, submit, edit-after-submit, reassign and cancel.

---

## 4. Scorecards & scoring

A scorecard is a JSON array on the task type, edited in a builder UI:

```json
{ "id": "uuid", "label": "Greeted the customer", "type": "yes_no",
  "points": 10, "critical": false, "allow_na": true }
```

| Type | Answer | Points earned | Possible |
|---|---|---|---|
| `yes_no` | Yes / No / N/A | Yes = `points`, No = 0 | `points` |
| `scale` | 0…`scale_max` | `points × value / scale_max` | `points` |
| `dropdown` | one of `options: [{label, points}]` | chosen option's points | max option points |
| `text` | free text | none | none |

- **Notes**: every metric has an optional notes box, so the QA agent can explain the score to the employee.
- **N/A** (when `allow_na` is set) leaves the metric out of both earned and possible.
- **Score** = `earned / possible × 100`, rounded to 1 decimal. If the QA agent failed the audit on a critical metric (it must have lost points), the score is 0.
- **Passed** = `score ≥ pass_threshold` and no critical fail.
- Scorecard edits apply to evaluations submitted after the edit. A submitted evaluation keeps its own snapshot, so old scores never change.
  Metric `id`s stay stable across label edits, so per-metric reports still group correctly.

`internal/scorecard` holds `Validate(scorecard)` and `Score(scorecard, answers)`, with one test file.

---

## 5. Intake & sampling

Every source goes through one contract, `importer.Ingest(ctx, taskType, workDate, rows, source)`,
the same pattern as followup's `ingest.Upsert`. It works per batch because one batch is one day's work.

1. **Match the employee**:
   - The calls export ("Disposition codes by interaction") matches `Agent ID` against `users.agent_code`.
   - The sales export ("Search results") has no Agent ID, so it matches "First agent name" by name: full name, alias or a remembered spelling, then the alias-email rule, then a near-identical spelling (at most 2 letters off, only when one person is that close). Any match other than an exact name is remembered in `users.sheet_names`, which is editable on Team.
   - Tickets match the agent email against `users.email` (case ignored).
   - Rows with no agent (abandoned calls) are dropped and counted.
   Rows for unknown agents are **rejected** and listed by name and ID, so a re-upload after you add them picks them up.
2. **Dedupe** on `(task type, external_id, employee)`. Rows that already exist are counted and left untouched, so re-uploading the same sheet creates nothing.
3. **Store** every new row as an `unsampled` task, with its labels and full data.
4. **Smart sample** each employee's new rows (`internal/sampling`, a pure function with a test):
   - Rows carrying a **skip-list** label are never picked.
   - `k = ceil(n × sample_percent)` over the remaining rows.
   - The **untagged share** goes to rows with no label (`round(k × untagged_share)`) and the rest to labelled rows. If one side runs out, the other fills in.
   - Labelled picks are spread with a greedy rule: take the label that has been picked least so far (ties broken at random), pick a random row carrying it, and repeat.
     So an agent with 30 Fitment Check calls and 2 Warranty calls gets Warranty before a second Fitment Check.
     A ticket with several tags counts toward all of them.
   - The picks go to `ready`.
5. **Run the assign pass** right after a commit.

Sources:
- **Calls / sales upload**: pick the task type and the work date (defaults to yesterday), drop the .xlsx/.csv, preview, then commit.
  The preview (`dry_run` writes nothing) shows new, duplicate and rejected rows and the sample count per employee. Parsing uses excelize for xlsx and stdlib for csv.
- **Tickets pull** (`internal/qaapi`):
  - Runs daily at 06:00 Asia/Amman for the previous reporting day (the QA API's day runs from 05:00 to 05:00). A **Pull now** button with a date picker covers re-runs.
  - It calls `GET /agents` (keeping only `is_team` agents), then `GET /agents/{email}/tickets?from=D&to=D`, paged with `limit=500`. Each ticket becomes a row with `external_id = ticket_id` and `labels =` tag names.
  - The QA API sends tags by id with no name, so names come from eDesk's `GET /tags`, and the ticket keeps every tag with its name.
  - Each task type also has an **ignore list**. Tags like "Read", "9" and channel tags are dropped from a ticket's labels, so sampling spreads across reason tags (Warranty, Fitment issue…) and a ticket with only ignored tags counts as untagged.
    - On 10/14, 84% of tickets carried no reason tag. With the ~20% untagged share, 18 of the 89 audits were untagged.
  - `tags_known: false` counts as untagged. Calls stay under the 120/min limit, and a `429` is honoured through `Retry-After`.
- **eDesk ticket info** (`internal/edesk`): when a QA agent opens a ticket task, `GET /tickets/{id}` fills subject, type, status, order, items, tracking and reply count.
  The result is cached in `data.edesk`. If eDesk is down, the page still works with the QA API data and the eDesk link.
- **HR sheet** (`importer.ImportRoster`): Team → Upload HR sheet, with a preview of who is added, updated or deactivated.
  - People are matched on Employee ID, then email, then name for anyone added by hand before.
  - It updates name, email, alias, job title, HR supervisor and department, and reactivates returning people.
  - An option deactivates employees no longer in the sheet.
  - Rows from departments the portal doesn't audit are counted and left out.
- **Vonage Agent IDs** are not in the HR sheet. A new Agent ID on a calls upload is linked to an employee the first time it appears, then remembered:
  - **By name:** full name or alias, ignoring case, hyphens and word order.
  - **Otherwise by email:** alias agents' work email is first initial + last name ("Jim Griffin" → `jgriffin@`).
  - Only an unambiguous match counts. The upload preview lists every new link, and anything left over is linked by hand on Team.
- Deactivated people are treated as not on the team, and their Agent ID is never reassigned by name.

---

## 6. Queue & assignment

The assignment logic is copied from followup's `internal/assign` (pure `Plan()` plus a runner), with one rule added:
**a task only goes to QA agents in its type's department.**

- Each QA agent has a cap (`queue_limit`, default 12). The pass gives each task to the agent with the fewest open tasks, oldest work date first. Overflow stays `ready`.
- The pass runs after every import, every minute, and when a QA agent goes online.
- Going offline stops new work but keeps the current queue (same as followup). Deactivating a user returns their tasks to `ready`.
- The supervisor can reassign to another QA agent in the same department, or cancel with a reason.

---

## 7. Screens

All screens reuse followup's shell, sidebar, topbar, theme, login, toasts, modal and stat/chart cards.

**QA agent** (sidebar-less, like followup's agent role)
- **My queue**: list plus an online/offline toggle.
- **Task page**:
  - Left side shows task type, employee and labels.
    - **Calls**: every sheet column, with a copy button on Interaction ID for finding it in Vonage.
    - **Tickets**: QA API data (status, channel, tags, replies, first/last reply) plus eDesk info (subject, type, order, items, tracking) and an **Open in eDesk** link.
  - Right side shows the scorecard form with per-metric notes and a live score preview.
  - Actions are **Submit** (locks the evaluation, then loads the next task) and **Can't audit** (asks for a reason, then cancels the task).

**Employee**
- **My scores**: a list of evaluations (date, type, ID, score, pass/fail) with an average. Opening one shows the answers and notes, read-only.

**Supervisor** (scoped to own department) **and Admin** (everything)
- **Dashboard / Reports**, filtered by date range, task type and employee:
  - **Employee scores**: average per employee, weekly trend, per-metric pass rate / average points, and score by disposition code or tag.
  - **Queue status**: per type, counts of imported, sampled, ready, assigned, completed and cancelled.
  - **QA activity**: evaluations completed per QA agent per day.
  - **Failed audits**: evaluations below the pass threshold or with a critical fail.
- **All tasks**: a filterable table. Opening a task shows the evaluation, with edit (audit-logged), reassign and cancel.
- **Imports**: upload, preview and commit, Pull tickets now, plus import history.
- **Task types**: create (in the supervisor's own department; the code is derived from the name), rename and deactivate a type, plus the scorecard builder, sample %, skip and ignore lists, untagged share, pass threshold and sheet columns. Only one active type can be fed by the tickets API; the database enforces it.
- **Team**: users of the department, roster import, add an employee by hand, set a temporary password, activate/deactivate, queue limit.
- **Departments** (admin only).

---

## 8. Reuse from followup-portal

| Copy (and trim) | Adapt | Leave behind |
|---|---|---|
| `internal/config`, `db`, `authn`, `cmd/migrate`, `cmd/set-password`, httpapi helpers (`writeJSON`, auth middleware), Dockerfile, compose, dev-db script | `internal/assign` (department filter), import preview/commit flow, `ImportsPage`, `QueuePage`, `TasksPage`, `TeamPage`, `ReportsPage` | waker, waitpoll, wait conditions, templates, comms logs, completion trigger, delivery, eDesk send/dashboard login, Deposco, ShipStation, tracking, refunds, calls desk, cart recovery, workers controller, websockets |
| `web/src/styles/*`, `layout/*`, `auth/*`, `api/client.ts` + `useApi`, `theme/*`, Modal, Toasts, StatCard, ChartCard | | |

One binary runs the API plus the background loops (assign pass and the daily ticket pull).
There is no separate worker container. Pages poll instead of using websockets.

Layout:

```
cmd/api  cmd/migrate  cmd/set-password
internal/config  db  authn  model  httpapi
internal/scorecard   Validate + Score
internal/sampling    per-employee diversity picking (pure)
internal/importer    sheet parse, employee match, dedupe, store, sample (all intake goes here)
internal/assign      dept-scoped Plan + runner
internal/qaapi       eDesk Insight QA API client + daily ticket pull
internal/edesk       eDesk official API: GetTicket
migrations/  web/
```

Config (`.env`): `DATABASE_URL`, `QA_API_BASE_URL`, `QA_API_KEY`, `EDESK_API_TOKEN`. Business time zone, ticket pull hour, Vonage clock, live match window and defaults are admin settings (Settings page, `app_settings` table).
Both keys go in `.env` only and are never committed.

---

## 9. Phases

**Status (2026-10-15):** phases 0–7 are built. They were checked end to end against the real Vonage sample sheet, through
the API and in the browser, for all four roles. The ticket pull and eDesk info are written to the documented APIs but
have not been run against them, because there is no key yet. The HR roster import is done and was checked against the real sheet: 64 people, and a re-upload changes nothing. All 14 agents in the calls sample link to employees. Deploy (phase 8) is still open.

| # | Work | Done when |
|---|---|---|
| **0** | Scaffold: repo, go.mod, copied base (config/db/migrate/authn), web shell + theme + login, local Postgres script, compose | Seeded admin logs in and sees an empty shell |
| **1** | Departments, users with the 4 roles, department scoping, Team page (add employee with Agent ID/email), password set/change | Admin creates departments and supervisors; each role lands on its own home page |
| **2** | Task types + scorecard builder + `internal/scorecard` (Validate/Score + test) | Supervisor builds the calls scorecard with all 4 metric types, critical and N/A; preview score is correct |
| **3** | Importer + `internal/sampling` (+ test), upload page, import history | Uploading a calls sheet rejects unknown agents, samples `ceil(X%)` per agent across different codes, and a re-upload creates 0 new rows |
| **4** | Assignment + queue control: department filter, cap, online toggle, reassign/cancel, All tasks page | Calls tasks reach only calls QA agents, capped |
| **5** | QA workspace: My queue, task page (calls view), scorecard form, submit/lock, can't audit, supervisor edit with audit log | QA scores a call end to end; supervisor edits it and the diff is logged |
| **6** | Employee "My scores" + the 4 reports | Employee sees only their own; supervisor sees only their department |
| **7** | Tickets: QA API daily pull + Pull now, ticket task view, eDesk info on open | Yesterday's tickets arrive each morning, sampled per agent across tags with ~20% untagged |
| **8** | Roster import (once the sheet arrives) + deploy (same docker-compose approach as followup) | Running on the server with the real team |

---

## 9b. QA2 scope (IT lead, 15 Oct 2026)

Decisions taken with you after reading the IT lead's scope. 16 Oct is an internal milestone; deploy comes after.

**Status (16 Oct):** everything in this table is built, negatives included.

- **Backend tests:** each feature was checked against the real data:
  - the tickets pull for 10/13
  - a live audit matched and one flagged
  - an escalation past the queue cap
  - a focus plan
  - a dispute that was upheld
  - a coaching through to acknowledgement
  - a rotation case through to the calibration report
- **UI:** checked in the browser as admin, QA agent and agent.

| Area | Decision |
|---|---|
| Teams | **Calls & Sales** stays one team (one supervisor, shared QA agents). The IT lead's per-department settings live on each **task type**, so Calls and Sales still get their own. New teams: **Livechat** (HR "Live chat support") and **Special processes**. Each gets a task type with source `manual` until their data source is known; audits reach them through escalations meanwhile |
| Users | The "employee" role is shown as **Agent**. Agents carry name, email, alias, HR employee ID, Vonage ID and **eDesk ID**. The eDesk ID is filled from the QA API on each ticket pull and is editable on Team |
| Bands | Each type has a **pass %** and a **borderline %**: ≥ pass is Pass, ≥ borderline is Borderline, below is Fail. A critical fail is always Fail. Reports show all three rates |
| N/A weight | Metrics can be marked **N/A receiver**. When a metric is answered N/A, its weight moves to the receivers, split by their own weights (A 20% is N/A, so B + C go from 40% to 60%). With no receivers, N/A drops out as before. The builder shows each metric's % of the score |
| Audit kinds | Each audit is one of **Daily sample**, **Live monitoring**, **Supervisor escalation**, **Focus plan** or **Rotation**. Only sample, live and escalation count in agent scores and appear on the agent's My scores. Focus plans and rotation are excluded |
| Sampling | Per type: a **tagged %** per agent (`ceil`, spread across tags/codes, then across reply-count buckets **1 / 2 / 3+** for tickets) plus an **untagged %** pooled across all agents. Pooled picks go to the least-sampled agents first, so everyone who worked still gets audited. This replaces the 20% share inside each agent's picks |
| Audits per agent | Per task type (so calls and sales differ): at least / at most per day, week and month, each a number of audits or a percent of the agent's work, set by the supervisor or admin. Weekly and monthly minimums are spread over the days left |
| Live monitoring | Calls and sales. A QA agent starts a live audit for an agent, and the start time is stamped. When that day's Vonage sheet is uploaded, a call by the same agent starting within **20 s** links the audit to that Interaction ID; otherwise the audit is **flagged**. Vonage times are **UTC−05:00**; the window and the clock are admin settings |
| Escalations | A supervisor sends a call/ticket ID, the agent and a reason. It goes to the top of a QA agent's queue in the team (ignoring the queue cap) as a Supervisor escalation, and the supervisor sees the result. An interaction already in the system is reused |
| Acknowledgement | The agent **acknowledges** each counted evaluation (optional comment) or **disputes** it with a reason. A dispute goes to the supervisor first, who can keep the score, edit it, or send it to the QA agent who scored it; from there both the supervisor and that QA agent can keep the score (with a reply) or edit it, which marks it changed. Pending acknowledgements and open disputes show on the dashboard |
| Coaching | The supervisor creates a coaching for an agent with a topic (e.g. Warranty) and/or linked audits, a due date and the QA agent who runs it. The QA agent records notes and outcome and marks it done. The agent acknowledges it |
| Rotation (QA over QA) | When on for a type: each QA agent in the team gets **N rotation cases a week** (admin setting, default 3, spread from Monday), a fresh interaction from the latest imported day. It doesn't count in agent scores. After **X days** (per type) the same case goes, blind, to one other QA agent. The **variance report** shows each pair's score gap and each QA agent's average gap and lean (stricter or more lenient) |
| Focus plan | A QA agent picks an agent, a tag/code, a count X and a date range (default last 7 days). X not-yet-audited interactions are pulled at random into their own queue. These don't count in agent scores |
| Negatives | A **negatives agent** (own role, one page) reports an order number / call ID, the agent who caused the negative review, and the error. It becomes a `negative` task waiting for the agent's supervisor (state `review`), who **confirms** it as reported, **sends it to a QA agent** (top of their queue, audited with the task type's scorecard) or **dismisses** it. The task type is the one of the agent's team that audits them (calls / sales / tickets). Negatives show on the agent's page, read-only, and don't change quality scores |
| Team leader escalations | Same flow as negatives: a **team leader** (floor support, own role, one page) escalates an order / call of an agent **on their own team** with what happened; it waits for the supervisor, who confirms it, sends it to a QA agent or dismisses it. Shown read-only on the agent's page, apart from quality scores |

---

## 9c. QA3 scope (16 Oct 2026)

Decisions from your answers on 16 Oct. Points still open are at the end.

### A. Escalations: checked as valid or not, never disputed, never in the score

Escalations don't go into the audit queue. They sit in their own **Escalations** list:

```
negatives agent / team leader  -> Escalations list -> a QA agent checks it: Valid (agent's mistake) or Not valid, with a note
QA agent (new QA escalation)   -> Escalations list -> the supervisor approves (valid) or rejects, with a note
Valid -> on the agent's profile (read-only)       Not valid -> closed, kept in the history
supervisor: sees the whole list and can decide any of them
```

- **QA escalation:** a new button in the QA workspace next to Live monitoring and Focus plan. Same form as the others:
  order / call ID, the agent, what happened.
- **Escalations list:** QA agents and the supervisor see it.
  - Tabs: To check / Valid / Not valid.
  - Filters: source (Negative / TL / QA) and agent.
  - It replaces today's Negatives and TL escalations pages.
- **Deciding:** **Valid** or **Not valid**, each with a required note. No scorecard.
- **No disputes:** an escalation is either the agent's mistake or not. On the profile it is read-only, as now.
- **Coaching on it:** a valid escalation can be linked to a coaching session (D) about that mistake.
- **Never in the quality score.**
- **Existing items:** negatives and TL escalations waiting today (state `review`) land in the new list as To check.
- **Data:**
  - kinds `negative`, `tl_escalation`, `qa_escalation`;
  - `review` keeps meaning "to check";
  - Valid -> completed with the note as the finding;
  - Not valid -> cancelled with the note;
  - the supervisor's Send to QA and the QA-queue path go away.

### B. Agent analysis page

- **Agents directory** (`/agents`): every agent in every team, with this month's average, audits, valid escalations and
  the last audit. Click one to open their page.
- **Agent page** (`/agents/:id`): the dashboard, for one agent.
  - profile header (team, HR department, supervisor, IDs);
  - date range (presets and custom);
  - headline numbers: average, pass / borderline / fail, critical fails, audits, disputes, escalations by source, coaching
    sessions;
  - weekly trend;
  - metrics weakest first, i.e. strengths and weaknesses;
  - results by code / tag;
  - every audit (open any of them);
  - escalations and coaching history.
- **Who sees it:** QA agents, supervisors and admins, for **all agents in all teams**.
- **Links to it:** from Team, the dashboard, the QA workspace and the agent's name on any audit.
- **Backend:** one endpoint, `GET /agents/{id}/report`, reusing the dashboard queries with the agent filter.

### C. Excel export (QA agents, supervisors, admins)

- **Buttons:** Export to Excel on the dashboard, the agent page and the directory (tick several).
- **Options:** agents (one, several, or a whole team), date range (presets or custom) and task type.
- **Built on the server** with excelize. One `.xlsx` with these sheets:
  1. **Summary**, one row per agent: name, alias, team, HR department, job title, IDs, audits, average, pass /
     borderline / fail %, critical fails, acknowledged / pending / disputed, valid escalations by source, coaching
     sessions.
  2. **Audits**, one row per audit: date worked, type, kind, interaction / ticket ID, codes / tags, QA agent, score,
     result, critical, the agent's answer.
  3. **Audit answers**, one row per audit and metric: metric, answer, points earned / possible, QA note.
  4. **Metrics**, per agent and metric: answered, average %, zeros.
  5. **Escalations**: source, date, ID, what happened, reporter, decision, note.
  6. **Coaching**: date, type, QA agent, topic, notes, outcome.

### D. Coaching sessions logged by QA agents

- **New session:** a button in the QA workspace.
  - fields: agent, type (**Coaching** or **Refresher**), topic, what was covered, outcome;
  - linking audits or valid escalations is **optional**;
  - it saves as done.
- **No agent acknowledgement** for logged sessions: the QA agent already had it from the agent.
- **Supervisor's Coaching page:** shows assigned and logged sessions together, filterable by QA agent, agent and type.

### E. QA agents' own audits: history, edits and approval

- **My audits:** a QA workspace view of every audit they submitted, filterable by date, agent, type and result.
- **Editing:**
  - **Notes only:** saved at once, with a history entry.
  - **Any answer** (it changes the score): a **pending change** with a reason. The audit keeps its score until a supervisor
    approves (applied and re-scored) or rejects it on an **Approvals** tab, showing each metric's before and after.
  - The same rule applies when a dispute was sent to the QA agent.
- **After an approved change:** the agent doesn't have to acknowledge again.
- **Edit history on every audit:** who, when, each metric before -> after, note changes, score before -> after, and who
  approved. Supervisors' direct edits appear there too; they still edit without approval.
- **Data:** an `evaluation_changes` table: task, requested by, proposed answers, reason, status, decided by / at, note.

### F. QA agents get the sidebar

Workspace, My audits, Agents, Escalations, Coaching.

### G. N/A metrics can also take N/A weight

- A metric may now be both **Allow N/A** and **Takes N/A weight**.
  - When it is answered, it takes a share of the N/A weight.
  - When it is N/A itself, it gives its weight away and takes none.
  - The scoring engine already works this way; only the editor rule that kept the two apart goes.
- **Split:** N/A weight is split **by each receiver's own points**, not evenly (this is what the engine does today). A
  receiver worth 30 takes three times what a receiver worth 10 takes, so the metrics keep the same importance relative to
  each other, as if the N/A metric had never been on the card.
  - Example: A 20 pts is N/A; B 10 and C 30 take the weight. B gets 5 and C gets 15, so B 15 and C 45: still 1 to 3.
  - An even split would give B 20 and C 40 (1 to 2).
  - Smaller-takes-more would give B 25 and C 35, making the minor metric nearly as heavy as the main one.
- The guard stays: at least one metric must never be N/A, so an audit always has a score.

### Order of work

1. A (escalations).
2. G (N/A weight): small, can ride along.
3. E (edits with approval and edit history).
4. D (coaching logs).
5. B (agent page and directory).
6. C (Excel export).

Each: migration if needed, tests, browser check, push, deploy with `deploy-script.sh`.

### Settled (16 Oct)

- **Supervisor escalations** ("Escalate an interaction", which counts in the score) stay as they are.
- **Negatives and TL escalations are auto-assigned** to a QA agent of the agent's team, like normal tasks: the least busy
  active one, online first. They appear in that QA agent's **Escalations** list, not the audit queue. If nobody is
  available, the assignment pass picks them up later.
- **QA agents and supervisors** can both mark any of them Valid or Not valid. QA escalations are decided by the
  supervisor.

### Built (16 Oct), and where it differs from the above

All of A to G is built (migration 00012), not yet committed or deployed. Differences:

- **A:** negatives and TL escalations a supervisor had already sent to QA (ready / assigned) go back to To check.
- **B:** no `/agents/{id}/report`: the agent page reads `/reports?employee_id=` (open across teams, to QA agents too),
  plus `/agents` and `/agents/{id}`. It's reached from the sidebar's Agents directory only; links from Team, the
  workspace and agent names on audits aren't added yet.
- **C:** no task type option in the export. The dashboard's button exports the picked agent, or the supervisor's team.
- **D:** New session is on the QA agent's Coaching page, not the workspace footer. The supervisor's Coaching page filters
  by open / assigned / logged / refresher, not by QA agent or agent.
- **Since then (16 Oct):** calls and sales can come in **one Vonage sheet**: each sheet task type can take only the rows
  whose column (e.g. Service name) is one of its values, and one upload fills every task type set up on that column.
  The Team edit dialog edits every field (alias, employee ID, job title, HR department, supervisor, organization). A
  critical metric no longer fails the audit by itself (migration 00013 ticks the box on audits that failed the old way).
- **Go-live review (16 Oct):** only employees are matched from sheets and tickets (never a team leader or QA agent
  with the same name); a sheet row with no interaction ID is skipped, not a refusal; the daily tickets pull catches up
  any day of the last week still missing (back to the type's first day); an admin's Vonage upload names the team when
  more than one team takes sheets.
- **Since then (16 Oct, later):** Team can remove a duplicate (someone with no work on record; the HR employee ID goes on
  Settings' "HR employee IDs left out" list so the next HR upload skips it), and flags names that appear twice. Live
  audits also ask for Phone number and Order number, both optional.
- **View only role (16 Oct):** for HR and others who follow quality. Sees every page an admin sees, every team, and
  exports; changes nothing (the server refuses every write but its own password and sign-out). The Settings page hides
  the default password from it. Created by an admin on Team, with no team.
- **Team leaders (16 Oct):** view only, for **their own team** (what a supervisor sees, without Settings or Departments),
  plus their TL escalations page (their home), where they escalate any agent of any team (the agent's team checks it).
  Nothing else they send is accepted. The View only role (HR) keeps every team. Negatives and QA escalations were
  already open to any agent; the supervisor's "Escalate an interaction" (a scored audit in their own queue) stays with
  their team.
- **Order numbers (17 Oct):** every audit has an optional list of order numbers the QA agent adds while scoring (type,
  Add or Enter, repeat; live audits start with the one typed while listening). Edit evaluation changes them without
  approval. They show on the audit page, are searchable on All tasks and My audits, and go into the Excel export.
- **Live chats (17 Oct):** a task type with source "eDesk live chats" pulls each day's closed chats (eDesk tickets of
  type Chat) from the official eDesk API, keeping only chats owned by active agents of that type's team (matched by
  eDesk ID or email). Sampling is the task type's own, spread across tags and chat lengths (Settings: replies per
  length group, default 5). The audit page shows the chat and its transcript (read from eDesk on first open, then
  kept). Same daily loop and week of catch-up as tickets; Imports has Pull now. eDesk's day filter uses the eDesk API
  user's own timezone. Needs EDESK_API_TOKEN in .env.
- **QA agents blind (17 Oct):** a QA agent never learns who audited, except on their own audits: no QA name or ID on
  others' audits (queue, disputes, agent page, report, export), no History or edit history there, and no QA activity
  or calibration on the agent page. Rotation cases read to them as ordinary audits (no badge, note or log entry).
  "Fail the whole audit" only takes on a critical metric that scored 0. Disputes has a **By agent** tab (accepted =
  score changed, rejected = score kept, waiting; most rejected first) for managers, and the export's Summary splits
  disputes into waiting, accepted and rejected.
- **Scores revealed weekly (17 Oct):** agents see a finished audit (and escalations found valid) only once their team's
  scores are revealed. The Dashboard shows each team's hidden count with **Reveal all scores** (supervisor: their team;
  admin: any team; view only and team leaders see the count only), which shows every hidden one at once. Until then
  managers and QA see it as usual, marked "not revealed yet", and it doesn't count as not acknowledged. Audits finished
  before this (migration 00017) stay visible.
- **17 Oct, later:** a supervisor escalates an interaction of **any agent of any team** from the Escalations page (moved
  from All tasks); it is still a scored audit, at the top of a QA queue of the agent's team, and shows under **Raised
  by me** (where it stands, then its score). QA agents' My audits has **Mine / My team** (every audit of their team
  but rotation cases; other QA agents' names hidden; only their own editable). The HR upload no longer moves someone
  out of a team the sheet never names (live chat agents set up by hand on Team stay there). New **QA productivity**
  page (managers): per QA agent for a period, audits by kind, per hour with work, scores given, pass / borderline /
  fail, critical fails, can't audit, escalations checked, coaching, disputes and score changes, first and last action,
  queue and online now; and a grid of audits by hour, day, week or month.
- **Departments (17 Oct):** an admin can remove a department added by mistake, only while it is empty (nobody in it,
  no task types).
- **QA productivity heat map (17 Oct):** the Activity heat map leads the page (summary under it): per QA agent per
  hour / day / week / month, by kind of work (Show: all work, audits, live monitoring, coaching, escalations checked,
  can't audit; dots mark the last four), and a click on a cell lists each piece of work in it.
- **QA agents (17 Oct):** see the Dashboard for their team (no QA activity, calibration, rotation or reveal) and the
  QA productivity heat map of their team's QA agents (no summary). They open only their own cells' work lists, and
  rotation reads to them as sample audits.
- **Special process agents (17 Oct):** a new role (A-Z guarantee, chargebacks, ...), with no team, that only escalates:
  any agent of any team, from the same page as team leaders. Their escalations and team leaders' are named after the
  sender's job title ("A-Z Guarantee Team Leader escalation", saved when sent) and, as before, go to the agent's
  team: its QA agents check them and its supervisor may decide. A supervisor's escalation must use one of the agent's
  own team's task types (the server refuses another team's).
- **Escalations, later (17 Oct):** the escalation forms find the agent with a search (name, alias, team or HR
  department, words in any order, forgiving a typo) instead of a list; only a supervisor's (scored) escalation asks
  which work it was. A QA agent sees only the escalations assigned to them (and the ones they decided or raised), and
  only the one assigned may decide it. Negatives are top priority: assigned first, listed first and marked for QA agents
  (and at the top of their Workspace), and for supervisors and admins they have their own Negatives page, out of
  Escalations. Every escalation, negatives included, goes to the agent's own team.
- **E:** Approvals is its own page. The audit page lists each changed metric before -> after; the Approvals list shows the
  score before -> after. The audit's History card is the edit history; QA agents see it on their own audits only.

---

## 10. Needed from you

1. ~~Employee roster sheet~~ (done: HR sheet).
2. **The 5 departments** and their supervisors (names and emails).
3. **First scorecard** for each type: metrics, type, points, critical. These can be entered in the UI, but a real one makes testing honest.
4. **QA API key** (`edi_…`) and **eDesk API token**, put in `.env` yourself (phase 7).
5. **Deploy target**: the same server as followup or a new one.

## 11. Defaults I picked (say if any should flip)

- Login is email + password. An admin/supervisor sets a temporary password and the user must change it on first login (copied from followup).
- Employees don't see which QA agent audited them.
- Each QA agent's queue cap defaults to 12, editable per agent.
- A ticket answered by two agents is audited separately for each of them, since each evaluation is about that agent's replies.
- If any of a ticket's tags is on the skip list, the ticket is skipped.
- "Can't audit" cancels the task with a reason. It never counts in scores and is not re-sampled.

## 12. Later (not in the base)

- Spreading codes across days, not just within a day (e.g. don't audit Fitment Check every day for the same agent)
- Disputes by employees
- Notifying employees of a new evaluation
- Manually queueing a specific unsampled row ("audit this call")
- Showing the full eDesk conversation inline (messages API)
- More task types (a new type plus a scorecard, no code)
