-- +goose Up

-- The orders a call or ticket was about, entered by the QA agent on every
-- audit (optional, one or more), like the live-monitoring details.
ALTER TABLE tasks ADD COLUMN order_numbers jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE tasks DROP COLUMN order_numbers;
