-- +goose Up

-- Live chat agents are known by their job title: a live chat type that
-- doesn't say whose work it audits takes Live Chat Associates (editable on
-- Task types), so their work goes there without asking.
UPDATE task_types SET agent_groups = '["Live Chat Associate"]'::jsonb
WHERE source = 'edesk_chats' AND (agent_groups IS NULL OR agent_groups = '[]'::jsonb);

-- +goose Down
SELECT 1; -- left as set
