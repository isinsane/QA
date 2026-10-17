-- +goose Up

-- A focus plan: who planned which of an agent's interactions for which QA
-- agent, and why. Its audits (tasks of kind focus) point to it. While a QA
-- agent has focus audits open, their normal queue waits.
CREATE TABLE focus_plans (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id  uuid NOT NULL REFERENCES departments (id),
    task_type_id   uuid NOT NULL REFERENCES task_types (id),
    employee_id    uuid NOT NULL REFERENCES users (id),
    assigned_qa_id uuid NOT NULL REFERENCES users (id),
    created_by     uuid NOT NULL REFERENCES users (id),
    labels         jsonb NOT NULL DEFAULT '[]', -- codes; none: any code, at random
    from_date      date NOT NULL,
    to_date        date NOT NULL,
    asked          int NOT NULL CHECK (asked BETWEEN 1 AND 50),
    pulled         int NOT NULL DEFAULT 0,
    reason         text NOT NULL CHECK (reason <> ''),
    status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    closed_at      timestamptz,
    closed_by      uuid REFERENCES users (id),
    cancel_reason  text NOT NULL DEFAULT ''
);
CREATE INDEX idx_focus_plans_dept ON focus_plans (department_id, status, created_at DESC);

ALTER TABLE tasks ADD COLUMN focus_plan_id uuid REFERENCES focus_plans (id);
CREATE INDEX idx_tasks_focus_plan ON tasks (focus_plan_id) WHERE focus_plan_id IS NOT NULL;

-- +goose Down
DROP INDEX idx_tasks_focus_plan;
ALTER TABLE tasks DROP COLUMN focus_plan_id;
DROP TABLE focus_plans;
