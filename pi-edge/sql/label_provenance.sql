-- Label store for the cloud retraining pipeline.
--
-- One row per labeled window per appliance per source. Rows are never updated.
-- A newer or more trusted label supersedes an older one at read time through the
-- effective_labels view.
--
-- Trust order, highest first: measured, human, device, review, rules.
-- Only measured, human and device labels may enter the held-out evaluation set.

CREATE TABLE IF NOT EXISTS label_provenance (
    label_id       BIGSERIAL PRIMARY KEY,
    panel          TEXT        NOT NULL,
    appliance      TEXT        NOT NULL,
    t_start        TIMESTAMP   NOT NULL,
    t_end          TIMESTAMP   NOT NULL,
    state          TEXT        NOT NULL CHECK (state IN ('on', 'off', 'abstain')),
    source         TEXT        NOT NULL CHECK (source IN ('measured', 'human', 'device', 'review', 'rules')),
    confidence     REAL        CHECK (confidence BETWEEN 0 AND 1),
    source_ref     TEXT,       -- feedback_id, review run id, rules version, channel name
    model_version  TEXT,       -- production model at the time, for disagreement analysis
    model_state    TEXT,
    rules_state    TEXT,
    split          TEXT        NOT NULL DEFAULT 'train' CHECK (split IN ('train', 'heldout')),
    created_at     TIMESTAMP   NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CHECK (t_end > t_start),
    CHECK (split = 'train' OR source IN ('measured', 'human', 'device'))
);

CREATE INDEX IF NOT EXISTS label_provenance_lookup
    ON label_provenance (panel, appliance, t_start);

CREATE OR REPLACE VIEW source_rank AS
SELECT * FROM (VALUES
    ('measured', 1), ('human', 2), ('device', 3), ('review', 4), ('rules', 5)
) AS r(source, rank);

-- Most trusted, then most recent, non-abstaining label per window.
CREATE OR REPLACE VIEW effective_labels AS
SELECT DISTINCT ON (l.panel, l.appliance, l.t_start, l.t_end)
       l.*
FROM label_provenance l
JOIN source_rank r USING (source)
WHERE l.state <> 'abstain'
ORDER BY l.panel, l.appliance, l.t_start, l.t_end, r.rank, l.created_at DESC;

-- Training loss weight by source. Tune from review accuracy measured on the audit sample.
CREATE OR REPLACE VIEW source_weight AS
SELECT * FROM (VALUES
    ('measured', 1.0), ('human', 1.0), ('device', 0.9), ('review', 0.5), ('rules', 0.3)
) AS w(source, weight);
