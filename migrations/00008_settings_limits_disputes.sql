-- +goose Up

-- A dispute goes to the supervisor first ('disputed'), who can send it on to
-- the QA agent who scored it ('dispute_qa'). Both can keep or change the score.
ALTER TABLE tasks DROP CONSTRAINT tasks_ack_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_ack_status_check
    CHECK (ack_status IN ('', 'acknowledged', 'disputed', 'dispute_qa', 'upheld', 'changed'));
DROP INDEX idx_tasks_disputed;
CREATE INDEX idx_tasks_disputed ON tasks (task_type_id) WHERE ack_status IN ('disputed', 'dispute_qa');

-- How many audits one agent gets per day / week / month, as a count or a
-- percent of their work: {"day": {"min": {"value": 1, "unit": "count"}, "max": ...}, "week": ..., "month": ...}.
-- The old fixed rule (at least one a day) becomes the starting value.
ALTER TABLE task_types ADD COLUMN agent_limits jsonb NOT NULL DEFAULT '{}';
UPDATE task_types SET agent_limits = '{"day": {"min": {"value": 1, "unit": "count"}}}';

-- Settings an admin edits from the UI. One row; missing keys fall back to the
-- defaults in internal/settings.
CREATE TABLE app_settings (
    id         int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    data       jsonb NOT NULL DEFAULT '{}',
    updated_by uuid REFERENCES users (id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (id) VALUES (1);

-- +goose Down
DROP TABLE app_settings;
ALTER TABLE task_types DROP COLUMN agent_limits;
UPDATE tasks SET ack_status = 'disputed' WHERE ack_status = 'dispute_qa';
DROP INDEX idx_tasks_disputed;
CREATE INDEX idx_tasks_disputed ON tasks (task_type_id) WHERE ack_status = 'disputed';
ALTER TABLE tasks DROP CONSTRAINT tasks_ack_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_ack_status_check
    CHECK (ack_status IN ('', 'acknowledged', 'disputed', 'upheld', 'changed'));
