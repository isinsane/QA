-- +goose Up

-- Negatives: a negatives agent reports an order or call that drew a negative
-- review, the agent who caused it and what went wrong. It waits for the
-- agent's supervisor ('review'), who confirms it or sends it to a QA agent.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee', 'negative_agent'));

ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('sample', 'live', 'escalation', 'focus', 'rotation', 'negative'));

ALTER TABLE tasks DROP CONSTRAINT tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check
    CHECK (state IN ('unsampled', 'review', 'ready', 'assigned', 'completed', 'cancelled'));

-- A negative may be about an interaction that was also sampled.
DROP INDEX tasks_one_per_agent;
CREATE UNIQUE INDEX tasks_one_per_agent ON tasks (task_type_id, external_id, employee_id)
    WHERE kind NOT IN ('rotation', 'negative');
CREATE INDEX idx_tasks_review ON tasks (task_type_id) WHERE state = 'review';

-- +goose Down
DROP INDEX idx_tasks_review;
DELETE FROM tasks WHERE kind = 'negative';
DROP INDEX tasks_one_per_agent;
CREATE UNIQUE INDEX tasks_one_per_agent ON tasks (task_type_id, external_id, employee_id) WHERE kind <> 'rotation';
ALTER TABLE tasks DROP CONSTRAINT tasks_state_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_state_check
    CHECK (state IN ('unsampled', 'ready', 'assigned', 'completed', 'cancelled'));
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('sample', 'live', 'escalation', 'focus', 'rotation'));
UPDATE users SET role = 'employee', active = false WHERE role = 'negative_agent';
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee'));
