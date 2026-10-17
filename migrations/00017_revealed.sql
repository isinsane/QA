-- +goose Up

-- Agents see a finished audit only once their team's scores are revealed
-- (Dashboard, Reveal scores), usually weekly. Audits finished before this
-- stay visible.
ALTER TABLE tasks ADD COLUMN revealed_at timestamptz;
UPDATE tasks SET revealed_at = coalesce(completed_at, now()) WHERE state = 'completed';
CREATE INDEX idx_tasks_unrevealed ON tasks (task_type_id) WHERE state = 'completed' AND revealed_at IS NULL;

-- +goose Down
DROP INDEX idx_tasks_unrevealed;
ALTER TABLE tasks DROP COLUMN revealed_at;
