-- +goose Up

-- Team leaders (floor supports) escalate an order or call of an agent on
-- their team. Like a negative, it waits for the supervisor's review.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee', 'negative_agent', 'team_leader'));

ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('sample', 'live', 'escalation', 'focus', 'rotation', 'negative', 'tl_escalation'));

DROP INDEX tasks_one_per_agent;
CREATE UNIQUE INDEX tasks_one_per_agent ON tasks (task_type_id, external_id, employee_id)
    WHERE kind NOT IN ('rotation', 'negative', 'tl_escalation');

-- +goose Down
DELETE FROM tasks WHERE kind = 'tl_escalation';
DROP INDEX tasks_one_per_agent;
CREATE UNIQUE INDEX tasks_one_per_agent ON tasks (task_type_id, external_id, employee_id)
    WHERE kind NOT IN ('rotation', 'negative');
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('sample', 'live', 'escalation', 'focus', 'rotation', 'negative'));
UPDATE users SET role = 'employee', active = false WHERE role = 'team_leader';
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee', 'negative_agent'));
