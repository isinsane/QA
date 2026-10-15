-- +goose Up

-- The HR sheet is the roster. Its Employee ID is the stable key a re-upload
-- matches on; the alias is the name some agents use on calls; profile keeps
-- the rest of the HR row (organization, department, job title, supervisor)
-- for display.
ALTER TABLE users ADD COLUMN hr_id text;
ALTER TABLE users ADD COLUMN alias_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX idx_users_hr_id ON users (hr_id) WHERE hr_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_users_hr_id;
ALTER TABLE users DROP COLUMN IF EXISTS profile;
ALTER TABLE users DROP COLUMN IF EXISTS alias_name;
ALTER TABLE users DROP COLUMN IF EXISTS hr_id;
