-- Rank recent inference windows for review.
-- Uncertainty is closeness of model confidence to the 0.5 decision threshold.
-- Disagreement is 1 when the production model and the rules layer differ.
-- Appliances with few trusted labels are boosted so questions spread out.
WITH recent AS (
    -- nilm_disaggregated names the panel column circuit, and state is 'on' or 'off'
    SELECT circuit AS panel, appliance, ts, TRIM(state) AS model_state, confidence::REAL AS confidence
    FROM nilm_disaggregated
    WHERE ts >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day'
),
rules AS (
    SELECT panel, appliance, t_start, t_end, state AS rules_state
    FROM label_provenance
    WHERE source = 'rules' AND t_start >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day'
),
trusted AS (
    SELECT panel, appliance, COUNT(*) AS n_trusted
    FROM label_provenance
    WHERE source IN ('measured', 'human', 'device')
    GROUP BY panel, appliance
)
SELECT r.panel, r.appliance, r.ts,
       1 - 2 * ABS(r.confidence - 0.5)                          AS uncertainty,
       CASE WHEN ru.rules_state IS NOT NULL
                 AND ru.rules_state <> r.model_state THEN 1 ELSE 0 END AS disagreement,
       COALESCE(t.n_trusted, 0)                                 AS n_trusted,
       (1 - 2 * ABS(r.confidence - 0.5))
         + 0.5 * CASE WHEN ru.rules_state IS NOT NULL AND ru.rules_state <> r.model_state THEN 1 ELSE 0 END
         + 0.2 / (1 + COALESCE(t.n_trusted, 0))                 AS score
FROM recent r
LEFT JOIN rules ru
       ON ru.panel = r.panel AND ru.appliance = r.appliance
      AND r.ts >= ru.t_start AND r.ts < ru.t_end
LEFT JOIN trusted t
       ON t.panel = r.panel AND t.appliance = r.appliance
ORDER BY score DESC
LIMIT 400;
