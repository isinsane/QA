-- +goose Up

-- QA escalations: a QA agent raises one; the supervisor decides it.
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('sample', 'live', 'escalation', 'focus', 'rotation', 'negative', 'tl_escalation', 'qa_escalation'));
DROP INDEX tasks_one_per_agent;
CREATE UNIQUE INDEX tasks_one_per_agent ON tasks (task_type_id, external_id, employee_id)
    WHERE kind NOT IN ('rotation', 'negative', 'tl_escalation', 'qa_escalation');

-- Negatives and TL escalations a supervisor had sent to QA to audit are
-- checked the new way instead: back to review, unassigned (a QA agent of the
-- team is picked on the next assignment run).
UPDATE tasks SET state = 'review', assigned_qa_id = NULL, assigned_at = NULL, queue_position = NULL
WHERE kind IN ('negative', 'tl_escalation') AND state IN ('ready', 'assigned');

-- What whoever decided an escalation found (it is Valid or Not valid).
ALTER TABLE tasks ADD COLUMN finding text NOT NULL DEFAULT '';
-- Escalations waiting for a decision, by who checks them.
CREATE INDEX idx_tasks_review_qa ON tasks (assigned_qa_id) WHERE state = 'review';

-- A QA agent's change to the answers of a submitted audit waits for a
-- supervisor; until then the audit keeps its score. Notes-only edits don't
-- come here (they apply at once).
CREATE TABLE evaluation_changes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id       uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    requested_by  uuid NOT NULL REFERENCES users (id),
    answers       jsonb NOT NULL,
    reason        text NOT NULL DEFAULT '',
    score_before  numeric(5, 1),
    score         numeric(5, 1), -- what the audit would score with these answers
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by    uuid REFERENCES users (id),
    decided_at    timestamptz,
    decision_note text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX evaluation_changes_one_pending ON evaluation_changes (task_id) WHERE status = 'pending';
CREATE INDEX idx_evaluation_changes_status ON evaluation_changes (status, created_at);

-- Coaching sessions have a type, and a QA agent can log one they already
-- held (it is done at once, and the agent isn't asked to acknowledge it).
ALTER TABLE coachings ADD COLUMN kind text NOT NULL DEFAULT 'coaching' CHECK (kind IN ('coaching', 'refresher'));
ALTER TABLE coachings ADD COLUMN logged boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE coachings DROP COLUMN logged;
ALTER TABLE coachings DROP COLUMN kind;
DROP TABLE evaluation_changes;
DROP INDEX idx_tasks_review_qa;
ALTER TABLE tasks DROP COLUMN finding;
DELETE FROM tasks WHERE kind = 'qa_escalation';
DROP INDEX tasks_one_per_agent;
CREATE UNIQUE INDEX tasks_one_per_agent ON tasks (task_type_id, external_id, employee_id)
    WHERE kind NOT IN ('rotation', 'negative', 'tl_escalation');
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('sample', 'live', 'escalation', 'focus', 'rotation', 'negative', 'tl_escalation'));
