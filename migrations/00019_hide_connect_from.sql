-- +goose Up

-- Live monitoring asks for the caller's number as Phone number; "Connect
-- from" (the sheet's name for it) is no longer asked too. Where the
-- settings already hold the hidden list, it joins it; otherwise the default
-- (internal/settings) has it.
UPDATE app_settings
SET data = jsonb_set(data, '{live_hidden_columns}', (data->'live_hidden_columns') || '["Connect from"]'::jsonb)
WHERE jsonb_typeof(data->'live_hidden_columns') = 'array' AND NOT (data->'live_hidden_columns') ? 'Connect from';

-- +goose Down
UPDATE app_settings
SET data = jsonb_set(data, '{live_hidden_columns}', (data->'live_hidden_columns') - 'Connect from')
WHERE jsonb_typeof(data->'live_hidden_columns') = 'array';
