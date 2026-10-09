-- Household feedback on NILM detections, captured on the Pi dashboard.
--
-- Written through the IEMS backend on the Pi and archived to the cloud like any
-- other table. When streamed through AnyLog, omit insert_timestamp from the payload
-- and send timestamps in UTC without a trailing Z.
--
-- label:
--   'on'               the appliance was running in [t_start, t_end]
--   'off'              it was not
--   'wrong_appliance'  something ran, but not this appliance (see corrected_to)
--   'no_event'         nothing ran
--
-- source:
--   'confirm'       user answered a card for a detected event
--   'live_tag'      user tagged an event as it started, snapped to a power transition
--   'active_query'  system asked about an uncertain window

CREATE TABLE IF NOT EXISTS nilm_feedback (
    feedback_id    BIGSERIAL PRIMARY KEY,
    panel          TEXT        NOT NULL,
    appliance      TEXT        NOT NULL,
    t_start        TIMESTAMP   NOT NULL,
    t_end          TIMESTAMP   NOT NULL,
    label          TEXT        NOT NULL CHECK (label IN ('on', 'off', 'wrong_appliance', 'no_event')),
    corrected_to   TEXT,
    source         TEXT        NOT NULL CHECK (source IN ('confirm', 'live_tag', 'active_query')),
    model_version  TEXT,
    model_conf     REAL,
    rules_label    TEXT,
    snapped        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMP   NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
    CHECK (t_end >= t_start)
);

CREATE INDEX IF NOT EXISTS nilm_feedback_appliance_time
    ON nilm_feedback (panel, appliance, t_start);
