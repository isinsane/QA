-- +goose Up

-- A critical metric no longer fails the audit by itself: the QA agent ticks
-- "Fail the whole audit" on it (critical_fail on the answer). Audits that
-- failed under the old rule (a critical metric that earned 0) get the box
-- ticked, so editing them later doesn't quietly drop the fail.
UPDATE tasks t SET answers = (
    SELECT jsonb_agg(
        CASE WHEN EXISTS (
            SELECT 1 FROM jsonb_array_elements(t.scorecard) m
            WHERE m->>'id' = a->>'metric_id' AND (m->>'critical')::boolean
              AND (a->>'value' IN ('no', '0')
                   OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                                  CASE WHEN jsonb_typeof(m->'options') = 'array' THEN m->'options' ELSE '[]'::jsonb END) o
                              WHERE o->>'label' = a->>'value' AND (o->>'points')::numeric = 0))
        ) THEN a || '{"critical_fail": true}'::jsonb ELSE a END
        ORDER BY ord)
    FROM jsonb_array_elements(t.answers) WITH ORDINALITY AS x(a, ord)
)
WHERE t.critical_failed AND jsonb_typeof(t.scorecard) = 'array'
  AND jsonb_typeof(t.answers) = 'array' AND jsonb_array_length(t.answers) > 0;

-- +goose Down
UPDATE tasks t SET answers = (
    SELECT jsonb_agg(a - 'critical_fail' ORDER BY ord)
    FROM jsonb_array_elements(t.answers) WITH ORDINALITY AS x(a, ord)
)
WHERE jsonb_typeof(t.answers) = 'array' AND jsonb_array_length(t.answers) > 0;
