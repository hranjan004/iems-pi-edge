# 03. Memory and storage budget

Figures marked measured come from [measurements/2026-10-09-edgelake.md](measurements/2026-10-09-edgelake.md)
or from the live host. Figures marked estimate have not been measured yet and are
checked in Phase 2.

## The board

The Raspberry Pi 3 Model B+ has a Broadcom BCM2837B0 quad-core Cortex-A53 at 1.4 GHz
and 1 GB of LPDDR2. Ethernet is gigabit over USB 2.0 with a ceiling of about 300 Mbps,
which is far more than this workload needs. The board is in production until at least
January 2030. The 3 A+ has 512 MB and is not viable for this design.

## RAM

| Component | RAM | Basis |
|---|---|---|
| OS, 64-bit Raspberry Pi OS Lite, idle | 177 MB | Published comparison |
| EdgeLake edge operator, native, at site ingest rate | 99 MB | Measured, steady over 5 minutes |
| IEMS backend | 100 MB | Measured on the host |
| NILM inference loop | 80 MB | Measured on the host |
| Node dashboard | 37 MB | Measured on the host |
| Tailscale | 35 MB | Measured on the host |
| eGauge producer | 27 MB | Measured on the host |
| Solar producer | 16 MB | Measured on the host |
| **Total** | **571 MB** | Leaves about 430 MB of the 1 GB |

The EdgeLake figure is now measured rather than taken from documentation, and it
matches the documented 100 MB for a node without Docker. It did not grow during the
load test and was the same with the MCP endpoint enabled.

For comparison, the same stack in Docker would total about 1050 MB: EdgeLake's
documented 300 MB under Docker, plus about 280 MB for the Docker daemon and containerd.
That is why every Pi service runs under systemd ([ADR 0005](adr/0005-native-services-on-pi.md)).

### Caveats

1. The host and EdgeLake measurements are x86_64. Python RSS is broadly similar on
   arm64, but every figure is re-measured on the Pi in Phase 2 with
   [pi/scripts/footprint.sh](../pi/scripts/footprint.sh).
2. EdgeLake used about 2.5% of one x86 core at the site rate. The Cortex-A53 is several
   times slower per core, so expect a low double-digit percentage of one core on the Pi.
   This is an estimate.
3. Swap is not headroom. zram provides a small compressed swap, and sustained swap use
   is treated as a failure.

### Limits enforced by systemd

| Unit | MemoryHigh | MemoryMax |
|---|---|---|
| edgelake-operator | 150M | 200M |
| iems-backend | 140M | 180M |
| iems-inference | 120M | 160M |
| iems-dashboard | 64M | 96M |
| iems-egauge-producer | 48M | 64M |
| iems-solar-producer | 40M | 56M |

These start loose and are tightened from Phase 2 measurements.

## Storage

### Software, on the microSD card

| Item | Size | Basis |
|---|---|---|
| Raspberry Pi OS Lite, 64-bit | about 2.8 GB | Published image requirement |
| Python 3.11 runtime from uv | 90 MB | Measured |
| IEMS virtualenv, arm64 wheels | 451 MB | Measured |
| EdgeLake virtualenv, arm64 wheels | 123 MB | Measured |
| EdgeLake source and deployment scripts | 40 MB | Measured |
| IEMS service code, sparse checkout | 3 MB | Measured |
| Node.js runtime from apt | about 80 MB | Estimate |
| Tailscale | about 40 MB | Estimate |
| Room for package upgrades and logs | 1 GB | Allowance |
| **Total** | **about 4.6 GB** | Leaves about 10 GB free on a 16 GB card |

Python 3.11 comes from uv rather than the OS because Raspberry Pi OS on Debian 13 ships
Python 3.13, and the inference code pins numpy below 2.0, which has no wheels for 3.13.
This matches the `python:3.11-slim` containers the services run in today.

### Data, on the USB SSD

| Item | Per day | Held | Steady state |
|---|---|---|---|
| `energy_readings` | 273 MB | 3 closed daily partitions plus the open one | about 1.1 GB |
| `nilm_disaggregated` and `solar_data` | 22 MB | Same partitions | about 90 MB |
| Archived JSON at a 100 KB threshold | about 9 MB | `ARCHIVE_DELETE=2` | about 30 MB |
| Producer spool | 0 normally | Capped | up to 256 MB during an outage |
| Model sets | n/a | 3 versions | about 5 MB |
| **Total** | **about 305 MB written** | | **about 1.2 GB, 1.5 GB worst case** |

Three days of retention is what the Pi needs to ride out an uplink outage without
losing rows that have not reached the cloud archive. Each additional day costs about
300 MB.

### Do you need the SSD?

For space, no. A 16 GB card has room for three days, or even a week, of data. The
SSD is about write endurance. The Pi writes at least 300 MB of new data per day, and
SQLite rewrites index pages on top of that. A consumer card can wear out in months
under that load. Without the SSD, use a high-endurance card and keep a spare imaged
card on site.

## If it does not fit

In order of preference.

1. Merge the backend and the inference loop into one process, so onnxruntime loads once
2. Switch the OS to DietPi, which idles about 60 MB lower
3. Shorten retention, each day removed saves about 300 MB of disk
4. Move to a Raspberry Pi 5 with 2 GB, listed at $77.50 from October 2026. Nothing
   else in this design changes
