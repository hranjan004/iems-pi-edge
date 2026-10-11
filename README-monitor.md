# GX10 Los Gatos readiness monitor

Runs inside iems-dashboard on startup and every 300 seconds, even when no browser is open. Latest results persist in the readiness-data Docker volume. GET /api/readiness returns source status, successful fetch times, PG&E publication times, scope, and recommendations. Failed/stale sources are unknown, never interpreted as zero outages. Successful fetches expire after 15 minutes; PG&E current outage publication expires after 45 minutes. No device commands are issued.

Sources: Open-Meteo 24-hour temperature/wind forecast; NWS active point alerts; PG&E's public aggregate-outage-data and seven-day-weather-forecast endpoints used by its official outage map. These PG&E endpoints are public website interfaces, not a guaranteed stable API; schema errors surface as unavailable. No account/login needed.

Location defaults to 37.24,-121.96. Nearby means Santa Clara County, not a circular radius or the home's electric circuit. PG&E city counts are affected customers, not event counts. County PSPS risk does not confirm a home shutoff. Live external feeds are separate from replayed energy data.

DSS preparation rules: affected customers in Los Gatos; Santa Clara County PSPS elevated/watch/warning; severe/extreme NWS alerts or fire/wind/flood/thunderstorm alerts; forecast gusts >=35 mph. Heat >=95F adds cooling advice. These are conservative preparation heuristics, not an outage probability model. Backend cycle responses include readiness and prepend its concise recommendations. In prepare mode optional cost-saving suggestions are suppressed, while anomaly warnings remain. No automatic battery charging, thermostat changes, or load shedding.

Deployment: rebuild/recreate only iems-dashboard and iems-backend with gx10/docker-compose.gx10.yaml and gx10/.env. The existing inference/training containers are unaffected. Rollback source copies and previous Docker image tags are saved under ~/gx10-readiness-backup-*.

Tests: node --test services/iems/web/readiness.test.js
