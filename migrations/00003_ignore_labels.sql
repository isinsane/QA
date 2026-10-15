-- +goose Up

-- Tags that say nothing about the ticket ("Read", channel tags) are dropped
-- from a row's labels on import, so sampling spreads across the tags that
-- matter and a ticket carrying only these counts as untagged. Distinct from
-- skip_labels, which keeps rows out of sampling altogether.
ALTER TABLE task_types ADD COLUMN ignore_labels jsonb NOT NULL DEFAULT '[]'::jsonb;

-- +goose Down
ALTER TABLE task_types DROP COLUMN IF EXISTS ignore_labels;
