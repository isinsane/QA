-- +goose Up

-- Task types: Livechat / Special processes have no feed yet ("manual"); bands
-- (pass / borderline / fail); a pooled untagged % instead of a per-agent
-- share; QA-over-QA rotation.
ALTER TABLE task_types DROP CONSTRAINT task_types_source_check;
ALTER TABLE task_types ADD CONSTRAINT task_types_source_check
    CHECK (source IN ('sheet', 'tickets_api', 'manual'));
ALTER TABLE task_types ADD COLUMN borderline_threshold integer NOT NULL DEFAULT 70
    CHECK (borderline_threshold BETWEEN 0 AND 100);
ALTER TABLE task_types ADD COLUMN untagged_percent numeric(5, 2) NOT NULL DEFAULT 1
    CHECK (untagged_percent >= 0 AND untagged_percent <= 100);
ALTER TABLE task_types DROP COLUMN untagged_share;
ALTER TABLE task_types ADD COLUMN rotation_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE task_types ADD COLUMN rotation_days integer NOT NULL DEFAULT 3 CHECK (rotation_days >= 1);

-- Tasks: what kind of audit it is, and the state each kind adds.
ALTER TABLE tasks ADD COLUMN kind text NOT NULL DEFAULT 'sample'
    CHECK (kind IN ('sample', 'live', 'escalation', 'focus', 'rotation'));
-- Escalations jump the queue (and the cap).
ALTER TABLE tasks ADD COLUMN priority integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN result text CHECK (result IN ('pass', 'borderline', 'fail'));
UPDATE tasks SET result = CASE WHEN passed THEN 'pass' ELSE 'fail' END WHERE passed IS NOT NULL;
ALTER TABLE tasks ADD COLUMN created_by uuid REFERENCES users (id);
-- Escalation reason, focus-plan description.
ALTER TABLE tasks ADD COLUMN note text NOT NULL DEFAULT '';
-- Live monitoring: when the QA agent started listening, and whether the
-- day's Vonage sheet had a call by that agent within 20 seconds of it.
ALTER TABLE tasks ADD COLUMN live_started_at timestamptz;
ALTER TABLE tasks ADD COLUMN match_status text NOT NULL DEFAULT ''
    CHECK (match_status IN ('', 'pending', 'matched', 'flagged'));
-- Rotation: the second, blind review points at the first.
ALTER TABLE tasks ADD COLUMN rotation_of uuid REFERENCES tasks (id) ON DELETE CASCADE;
-- Agent acknowledgement / dispute and its resolution.
ALTER TABLE tasks ADD COLUMN ack_status text NOT NULL DEFAULT ''
    CHECK (ack_status IN ('', 'acknowledged', 'disputed', 'upheld', 'changed'));
ALTER TABLE tasks ADD COLUMN ack_comment text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN ack_at timestamptz;
ALTER TABLE tasks ADD COLUMN dispute_resolution text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN dispute_resolved_by uuid REFERENCES users (id);
ALTER TABLE tasks ADD COLUMN dispute_resolved_at timestamptz;

-- A rotation case is a copy of an interaction already stored as a row, so
-- only the other kinds stay one-per-agent-per-interaction.
ALTER TABLE tasks DROP CONSTRAINT tasks_one_per_agent;
CREATE UNIQUE INDEX tasks_one_per_agent ON tasks (task_type_id, external_id, employee_id)
    WHERE kind <> 'rotation';
CREATE INDEX idx_tasks_live_pending ON tasks (task_type_id, work_date) WHERE match_status = 'pending';
CREATE INDEX idx_tasks_disputed ON tasks (task_type_id) WHERE ack_status = 'disputed';

ALTER TABLE users ADD COLUMN edesk_id text;

CREATE TABLE coachings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id   uuid NOT NULL REFERENCES departments (id),
    employee_id     uuid NOT NULL REFERENCES users (id),
    topic           text NOT NULL DEFAULT '',
    task_ids        jsonb NOT NULL DEFAULT '[]'::jsonb,
    assigned_qa_id  uuid NOT NULL REFERENCES users (id),
    created_by      uuid REFERENCES users (id),
    due_date        date,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    notes           text NOT NULL DEFAULT '',
    outcome         text NOT NULL DEFAULT '',
    completed_at    timestamptz,
    ack_at          timestamptz,
    ack_comment     text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT coachings_has_subject CHECK (topic <> '' OR task_ids <> '[]'::jsonb)
);
CREATE INDEX idx_coachings_qa ON coachings (assigned_qa_id, status);
CREATE INDEX idx_coachings_employee ON coachings (employee_id);
CREATE TRIGGER trg_coachings_updated_at BEFORE UPDATE ON coachings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +goose Down
DROP TABLE IF EXISTS coachings;
ALTER TABLE users DROP COLUMN IF EXISTS edesk_id;
DROP INDEX IF EXISTS idx_tasks_disputed;
DROP INDEX IF EXISTS idx_tasks_live_pending;
DROP INDEX IF EXISTS tasks_one_per_agent;
DELETE FROM tasks WHERE kind = 'rotation';
ALTER TABLE tasks ADD CONSTRAINT tasks_one_per_agent UNIQUE (task_type_id, external_id, employee_id);
ALTER TABLE tasks DROP COLUMN dispute_resolved_at, DROP COLUMN dispute_resolved_by, DROP COLUMN dispute_resolution,
    DROP COLUMN ack_at, DROP COLUMN ack_comment, DROP COLUMN ack_status, DROP COLUMN rotation_of,
    DROP COLUMN match_status, DROP COLUMN live_started_at, DROP COLUMN note, DROP COLUMN created_by,
    DROP COLUMN result, DROP COLUMN priority, DROP COLUMN kind;
ALTER TABLE task_types DROP COLUMN rotation_days, DROP COLUMN rotation_enabled, DROP COLUMN untagged_percent,
    DROP COLUMN borderline_threshold;
ALTER TABLE task_types ADD COLUMN untagged_share numeric(3, 2) NOT NULL DEFAULT 0.20;
ALTER TABLE task_types DROP CONSTRAINT task_types_source_check;
ALTER TABLE task_types ADD CONSTRAINT task_types_source_check CHECK (source IN ('sheet', 'tickets_api'));
