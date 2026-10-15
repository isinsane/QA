-- +goose Up

-- Every mutable table stamps updated_at from the database clock.
-- +goose StatementBegin
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd

CREATE TABLE departments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_departments_updated_at BEFORE UPDATE ON departments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One table for all four roles. Employees are the people being audited; they
-- need an email only if they are going to sign in, and calls rows match them
-- on agent_code (the Vonage Agent ID) instead.
CREATE TABLE users (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 text NOT NULL,
    email                text,
    role                 text NOT NULL
                             CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee')),
    department_id        uuid REFERENCES departments (id),
    agent_code           text,
    active               boolean NOT NULL DEFAULT true,
    -- QA agents only: whether the assignment pass may give them new work.
    is_available         boolean NOT NULL DEFAULT true,
    queue_limit          integer NOT NULL DEFAULT 12 CHECK (queue_limit >= 0),
    -- '' = no password set yet, so login is refused with a distinct message.
    password_hash        text NOT NULL DEFAULT '',
    must_change_password boolean NOT NULL DEFAULT false,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_department_required CHECK (role = 'admin' OR department_id IS NOT NULL)
);
CREATE UNIQUE INDEX idx_users_email ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX idx_users_agent_code ON users (agent_code) WHERE agent_code IS NOT NULL;
-- Each department has exactly one active supervisor.
CREATE UNIQUE INDEX idx_users_one_supervisor ON users (department_id)
    WHERE role = 'supervisor' AND active;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Opaque bearer tokens; only a hash is stored.
CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   text NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);
CREATE INDEX idx_sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE task_types (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id  uuid NOT NULL REFERENCES departments (id),
    code           text NOT NULL UNIQUE,
    name           text NOT NULL,
    source         text NOT NULL CHECK (source IN ('sheet', 'tickets_api')),
    active         boolean NOT NULL DEFAULT true,
    -- The metric list; see internal/scorecard.
    scorecard      jsonb NOT NULL DEFAULT '[]'::jsonb,
    pass_threshold integer NOT NULL DEFAULT 80 CHECK (pass_threshold BETWEEN 0 AND 100),
    -- Sampling; see internal/sampling.
    sample_percent numeric(5, 2) NOT NULL DEFAULT 5 CHECK (sample_percent > 0 AND sample_percent <= 100),
    skip_labels    jsonb NOT NULL DEFAULT '[]'::jsonb,
    untagged_share numeric(3, 2) NOT NULL DEFAULT 0.20 CHECK (untagged_share BETWEEN 0 AND 1),
    -- Sheet headers the importer needs: external_id, agent_code, label.
    columns        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_task_types_updated_at BEFORE UPDATE ON task_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE import_runs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type_id uuid NOT NULL REFERENCES task_types (id),
    source       text NOT NULL CHECK (source IN ('upload', 'api')),
    work_date    date NOT NULL,
    filename     text NOT NULL DEFAULT '',
    user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
    rows_read    integer NOT NULL DEFAULT 0,
    created      integer NOT NULL DEFAULT 0,
    duplicates   integer NOT NULL DEFAULT 0,
    rejected     integer NOT NULL DEFAULT 0,
    skipped      integer NOT NULL DEFAULT 0,
    sampled      integer NOT NULL DEFAULT 0,
    status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    error        text NOT NULL DEFAULT '',
    -- Rejected agents and per-employee sample counts, for the history view.
    detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz
);
CREATE INDEX idx_import_runs_type ON import_runs (task_type_id, started_at DESC);

-- One row per imported item, sampled or not. The evaluation lives on the same
-- row because a task has at most one.
CREATE TABLE tasks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_type_id    uuid NOT NULL REFERENCES task_types (id),
    import_run_id   uuid REFERENCES import_runs (id) ON DELETE SET NULL,
    employee_id     uuid NOT NULL REFERENCES users (id),
    -- Interaction ID or ticket ID. Not unique alone: a transferred call has one
    -- Interaction ID for both agents, and a ticket can be answered by two.
    external_id     text NOT NULL,
    work_date       date NOT NULL,
    labels          jsonb NOT NULL DEFAULT '[]'::jsonb,
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    state           text NOT NULL DEFAULT 'unsampled'
                        CHECK (state IN ('unsampled', 'ready', 'assigned', 'completed', 'cancelled')),
    assigned_qa_id  uuid REFERENCES users (id),
    assigned_at     timestamptz,
    queue_position  integer,
    cancel_reason   text NOT NULL DEFAULT '',
    scorecard       jsonb,
    answers         jsonb,
    score           numeric(5, 1),
    critical_failed boolean NOT NULL DEFAULT false,
    passed          boolean,
    evaluated_by    uuid REFERENCES users (id),
    submitted_at    timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tasks_one_per_agent UNIQUE (task_type_id, external_id, employee_id),
    CONSTRAINT tasks_assigned_has_qa CHECK (state <> 'assigned' OR assigned_qa_id IS NOT NULL),
    CONSTRAINT tasks_completed_has_evaluation
        CHECK (state <> 'completed' OR (completed_at IS NOT NULL AND answers IS NOT NULL))
);
CREATE INDEX idx_tasks_ready ON tasks (work_date, created_at) WHERE state = 'ready';
CREATE INDEX idx_tasks_qa_queue ON tasks (assigned_qa_id, queue_position) WHERE state = 'assigned';
CREATE INDEX idx_tasks_employee ON tasks (employee_id, work_date);
CREATE INDEX idx_tasks_type_date ON tasks (task_type_id, work_date);
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_logs (
    id         bigserial PRIMARY KEY,
    task_id    uuid REFERENCES tasks (id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    action     text NOT NULL,
    detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_task ON audit_logs (task_id, created_at DESC);

-- +goose Down
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS import_runs;
DROP TABLE IF EXISTS task_types;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS departments;
DROP FUNCTION IF EXISTS set_updated_at();
