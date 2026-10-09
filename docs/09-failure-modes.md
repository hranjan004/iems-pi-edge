# 09. Failure modes

What each failure costs, and what the household sees.

| Failure | Ingestion | Inference and DSS | Dashboard | Archive | Cloud GUI and Ask | Recovery |
|---|---|---|---|---|---|---|
| Internet uplink down | Continues | Continues | Continues on the LAN | Paused, backfills on reconnect | Unavailable | Automatic |
| Cloud VM down | Continues | Continues | Continues | Paused, backfills | Unavailable | Automatic after VM returns |
| AnyLog master down | Continues on local metadata | Continues | Continues | Depends on transfer method | Network queries fail | Automatic, confirm in Phase 1 |
| Pi operator restart | Producers spool to SSD | Skips ticks, marks stale | Shows stale state | Unaffected | Shows Pi offline | Automatic, spool replays |
| Pi power loss | Lost for the outage | Lost | Lost | Unaffected | Shows Pi offline | Automatic on power return |
| SD card failure | Down | Down | Down | Unaffected | Shows Pi offline | Reflash, data on SSD survives |
| SSD failure | Down | Down | Down | Unaffected beyond last transfer | Shows Pi offline | Replace SSD, recent window lost |
| Meter unreachable | Gap | Insufficient evidence | Shows meter offline | Gap | Gap | Automatic |
| Bad model promoted | Continues | Wrong states | Wrong states | Unaffected | Unaffected | Flip symlink back |

## Rules that make failures visible

1. **Stale is never shown as current.** Every dashboard tile carries the age of its
   newest reading. Past a threshold the tile shows stale rather than a value.
2. **Missing is never shown as zero.** A cloud dashboard that cannot reach the Pi shows
   the Pi as offline, not a quiet house with zero load.
3. **Inference abstains on gaps.** A window with missing samples beyond a threshold
   produces no prediction rather than a guess, and the DSS skips that tick.
4. **The archive backfills in order.** Transfer resumes from its watermark and replays
   windows oldest first.

Sequence for the uplink outage case: [architecture/offline-sequence.md](../architecture/offline-sequence.md).

## Watchdogs

| Watchdog | Mechanism |
|---|---|
| Service crash | `Restart=always` with backoff in every unit |
| Producer stuck | Producer touches a heartbeat file each poll, healthcheck restarts it after 60 s without one |
| Memory leak | `MemoryMax` per unit, OOM kill is contained to that unit |
| Board hang | Hardware watchdog enabled through systemd `RuntimeWatchdogSec` |
| Disk full | Healthcheck alerts at 80% on the SSD and prunes the spool oldest first at 90% |
