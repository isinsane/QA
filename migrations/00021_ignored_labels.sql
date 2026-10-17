-- +goose Up

-- eDesk's language tags "9" and "10" say nothing about the work: Settings now
-- ignores them by default (ignored_labels); take them off what is imported.
UPDATE tasks SET labels = (
    SELECT coalesce(jsonb_agg(e.l ORDER BY e.n), '[]'::jsonb)
    FROM jsonb_array_elements_text(labels) WITH ORDINALITY e(l, n) WHERE e.l NOT IN ('9', '10'))
WHERE labels ?| ARRAY['9', '10'];

-- +goose Down
SELECT 1; -- the tags are not put back
