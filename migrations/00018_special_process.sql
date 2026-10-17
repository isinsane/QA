-- +goose Up

-- Special process agents (A-Z guarantee, chargebacks, ...) escalate agents'
-- work like team leaders. They belong to no QA team.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee', 'negative_agent', 'team_leader', 'viewer', 'special_process'));
ALTER TABLE users DROP CONSTRAINT users_department_required;
ALTER TABLE users ADD CONSTRAINT users_department_required
    CHECK (role IN ('admin', 'viewer', 'special_process') OR department_id IS NOT NULL);

-- +goose Down
DELETE FROM users WHERE role = 'special_process';
ALTER TABLE users DROP CONSTRAINT users_department_required;
ALTER TABLE users ADD CONSTRAINT users_department_required CHECK (role IN ('admin', 'viewer') OR department_id IS NOT NULL);
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'supervisor', 'qa_agent', 'employee', 'negative_agent', 'team_leader', 'viewer'));
