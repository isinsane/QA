# QA Portal

Quality audits for calls, sales calls and tickets. Each day's work comes in (a Vonage sheet upload, or the
daily tickets pull). A share of each agent's work is sampled across different disposition codes and tags into
the department's QA queues. QA agents score it against the supervisor's scorecard.

Plan and decisions: [PLAN.md](PLAN.md). Built on the design of `followup-portal`.

## Run it locally

Needs Go 1.26+, Node 20+, and Postgres 18 (`scoop install postgresql`).

```powershell
./scripts/dev-db.ps1 init          # once: local cluster on port 5433 (qa_dev, qa_test)
Copy-Item .env.example .env
go run ./cmd/set-password -email you@company.com -name "Your Name"   # first admin
go run ./cmd/api                   # API on :8090; runs migrations on start
npm --prefix web install
npm --prefix web run dev           # web app on http://localhost:5174
```

```powershell
go test ./...                      # scorecard, sampling, assignment
```

## Run it with Docker

Needs Docker only; everything is built inside the image.

```bash
cp .env.example .env               # set POSTGRES_PASSWORD (and QA_API_*, EDESK_API_TOKEN if used)
docker compose up -d --build       # Postgres + the portal on http://localhost:8080
docker compose exec app set-password -email you@company.com -name "Your Name"   # first admin
```

The app container runs the migrations when it starts. Data lives in the `db-data` volume. Update with
`git pull && docker compose up -d --build`.

## How it fits together

| | |
|---|---|
| `internal/importer` | The one way work enters: matches rows to employees, drops rows already imported, stores the rest, samples |
| `internal/sampling` | Per agent, per day: `ceil(X%)` of tagged rows spread across codes/tags (and reply counts), plus `ceil(Y%)` of untagged rows pooled across agents |
| `internal/rotation` | QA over QA: a daily rotation case per QA agent, re-scored blind by a colleague after X days |
| `internal/scorecard` | Metric definitions and the server-side score (points → %, N/A weight to receivers, critical metrics, pass / borderline / fail) |
| `internal/assign` | Fills QA agents' queues from their own department, capped per agent |
| `internal/qaapi` | Daily pull from the eDesk Insight QA API (`QA_API_KEY`) |
| `internal/edesk` | Ticket general info from eDesk's official API (`EDESK_API_TOKEN`) |
| `internal/httpapi` | JSON API, role and department scoping, reports |
| `web/` | React app (same shell and theme as followup-portal) |

One binary (`cmd/api`) runs the API, the assignment pass (every minute and after each import), and the daily
tickets pull.
