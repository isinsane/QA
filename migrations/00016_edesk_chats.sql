-- +goose Up

-- Live chats pulled daily from the eDesk official API.
ALTER TABLE task_types DROP CONSTRAINT task_types_source_check;
ALTER TABLE task_types ADD CONSTRAINT task_types_source_check
    CHECK (source IN ('sheet', 'tickets_api', 'manual', 'edesk_chats'));

-- +goose Down
UPDATE task_types SET source = 'manual' WHERE source = 'edesk_chats';
ALTER TABLE task_types DROP CONSTRAINT task_types_source_check;
ALTER TABLE task_types ADD CONSTRAINT task_types_source_check
    CHECK (source IN ('sheet', 'tickets_api', 'manual'));
