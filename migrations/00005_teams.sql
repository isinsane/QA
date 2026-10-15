-- +goose Up

-- A portal department is a QA team: one supervisor, its QA agents, and the
-- task types they audit. It can take in several HR departments (Calls &
-- Sales = Calls support + New Sales).
ALTER TABLE departments ADD COLUMN hr_names jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Other spellings an agent appears under in Vonage sheets that carry names
-- only ("Bartholomew Alnoury" for HR's "Bartholomew Al-Nouri"). Learned on
-- import, editable on Team, never touched by the HR upload.
ALTER TABLE users ADD COLUMN sheet_names jsonb NOT NULL DEFAULT '[]'::jsonb;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS sheet_names;
ALTER TABLE departments DROP COLUMN IF EXISTS hr_names;
