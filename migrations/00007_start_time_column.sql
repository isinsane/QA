-- +goose Up
-- Sheet types created before live monitoring had no start-time column; both
-- Vonage exports call it "Start time".
UPDATE task_types SET columns = columns || '{"start_time": "Start time"}'::jsonb
WHERE source = 'sheet' AND coalesce(columns ->> 'start_time', '') = '';

-- +goose Down
UPDATE task_types SET columns = columns - 'start_time' WHERE source = 'sheet';
