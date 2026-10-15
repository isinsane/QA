-- +goose Up

-- Which agents a task type audits, by their HR department (users.profile
-- ->> 'department'): calls agents only under the calls type, sales agents
-- only under sales. Empty = every agent of the team.
ALTER TABLE task_types ADD COLUMN agent_groups jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE task_types DROP COLUMN agent_groups;
