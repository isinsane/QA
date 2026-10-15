-- +goose Up

-- The daily tickets pull feeds exactly one task type. With supervisors now
-- creating their own types, the database keeps a second active one out.
CREATE UNIQUE INDEX idx_task_types_one_tickets_api ON task_types (source)
    WHERE source = 'tickets_api' AND active;

-- +goose Down
DROP INDEX IF EXISTS idx_task_types_one_tickets_api;
