-- +goose Up

-- View only: sees what an admin sees, every team, and changes nothing (HR).
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee', 'negative_agent', 'team_leader', 'viewer'));
-- Like an admin, a view-only account belongs to no team (it sees all of them).
ALTER TABLE users DROP CONSTRAINT users_department_required;
ALTER TABLE users ADD CONSTRAINT users_department_required CHECK (role IN ('admin', 'viewer') OR department_id IS NOT NULL);

-- +goose Down
DELETE FROM users WHERE role = 'viewer';
ALTER TABLE users DROP CONSTRAINT users_department_required;
ALTER TABLE users ADD CONSTRAINT users_department_required CHECK (role = 'admin' OR department_id IS NOT NULL);
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee', 'negative_agent', 'team_leader'));
