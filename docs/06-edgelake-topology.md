# 06. EdgeLake topology

Every node in the new deployment runs EdgeLake, the open-source distribution of the
AnyLog data platform hosted at LF Edge under the Mozilla Public License 2.0. No
licensed AnyLog build is used anywhere. See [ADR 0007](adr/0007-edgelake-only.md).

## Why EdgeLake fits without code changes

EdgeLake is the open-source core of AnyLog: connectivity, ingestion, query and node
identity. The commercial AnyLog edition adds high availability and security hardening
on top, neither of which this deployment uses. EdgeLake keeps AnyLog's command
language, REST interface, message clients and partitioning, so everything written
against the current AnyLog deployment carries over. That includes the
`run msg client` mappings, the SQL REST calls in `anylog_query.py` and `server.js`, and
the `User-Agent: AnyLog/1.23` header. The node's configuration variables also keep
their `ANYLOG_` names, for example `ANYLOG_REST_PORT`.

## Nodes

| Node | Location | EdgeLake role | Storage | Retention |
|---|---|---|---|---|
| master | Cloud | `master` | Local ledger | n/a |
| edge-operator | Pi | `operator`, native, from source | SQLite on SSD | 3 days |
| archive-operator | Cloud | `operator`, MCP endpoint on | Postgres | Indefinite |

All three join one network. A query issued anywhere is routed to whichever operator
holds the rows.

## Edge operator configuration

The full file is [pi/config/edgelake.env.example](../pi/config/edgelake.env.example).
These are the settings that differ from EdgeLake's defaults and why.

| Setting | Value | Default | Reason |
|---|---|---|---|
| `NODE_TYPE` | `operator` | varies | Master lives in the cloud |
| `DB_TYPE` | `sqlite` | `sqlite` | Recommended for small nodes, no server process |
| `ANYLOG_BROKER_PORT` | `1883` | `32150` | Producers already publish to 1883 |
| `PARTITION_INTERVAL` | `1 day` | `14 days` | Retention can drop one day at a time |
| `PARTITION_KEEP` | `3` | `3` | With daily partitions, three days of history on the Pi |
| `THRESHOLD_TIME` | `30 seconds` | `60 seconds` | Bounds file flushes |
| `THRESHOLD_VOLUME` | `100KB` | `10KB` | Fewer, larger archive files, see below |
| `ARCHIVE_DELETE` | `2` | `30` | Archived JSON kept two days, not thirty |
| `ENABLE_MCP` | `false` | `false` | MCP is served from the cloud node instead |
| `NODE_MONITORING`, `STORE_MONITORING`, `SYSLOG_MONITORING`, `DOCKER_MONITORING` | `false` | `true` | Saves threads and writes on a 1 GB board |
| `OPERATOR_THREADS` | `1` | `3` | One table at about 16 rows per second |
| `DISABLE_CLI` | `true` | `false` | No terminal under systemd |
| `OVERLAY_IP` | Pi Tailscale address | empty | Advertise a reachable address, not 127.0.0.1 |

### The archive behavior

With `write_immediate` on, the default, EdgeLake archives every processed JSON file
even when `ARCHIVE=false`. A daily job deletes archive files older than
`ARCHIVE_DELETE` days. At the default 30 days and a small file threshold this would
hold about 8 GB of 4 KB files. With the settings above it holds about 30 MB, which
also leaves two days of compressed raw readings for replay if the SQLite file is lost.
Measured details are in [measurements/2026-10-09-edgelake.md](measurements/2026-10-09-edgelake.md).

## Measured footprint

| Item | Value |
|---|---|
| RAM, idle and at site ingest rate | 96 to 99 MB |
| CPU on the x86 test machine | about 2.5% of one core |
| Virtualenv, arm64 | 123 MB |
| Source and deployment scripts | 40 MB |
| Data written per day | about 305 MB, all tables |
| Data held on the Pi | about 1.2 GB at three days |

## Operating while the master is unreachable

EdgeLake nodes answer metadata queries from their own locally synchronized copy of the
ledger, and blockchain synchronization refreshes that copy from the master on a timer.
The edge operator should therefore keep ingesting and answering local SQL during an
uplink outage. This is tested in Phase 3 by stopping the cloud master for two hours.

## Getting data from the edge to the archive

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Forwarder | A small service reads the Pi operator by time window and streaming-PUTs to the archive operator | Fully under our control, easy to replay | Custom code |
| B. Replay archived JSON | Ship the Pi's compressed archive files to the cloud operator's watch directory | Uses files EdgeLake already writes, exact copies | Up to one file threshold of delay, needs a file transfer job |

High-availability clusters replicate data between member operators, which would copy
the full archive back onto the Pi, so they are not used here.

Option A is the default. Its specification:

1. Keep a watermark per table in a small state file on the SSD
2. Every 60 seconds, read rows newer than the watermark from the Pi in bounded windows
3. PUT them to the archive operator without `insert_timestamp`, with timestamps lacking a trailing Z
4. Advance the watermark only after the archive confirms the write
5. After an outage, replay oldest first, rate-limited so the dashboard stays responsive

## Advertising the right address

A cross-host query previously returned empty because the ledger advertised the
operator at 127.0.0.1. Each node sets `OVERLAY_IP` to its Tailscale address and binds
its REST and TCP services to that address and loopback.

## Version alignment

The Pi runs EdgeLake from source at a pinned commit. The Docker Hub image
`anylogco/edgelake` publishes arm64 and amd64 builds, but its newest tag, 1.4.2510
from October 2025, is older than the source. The cloud nodes therefore run an image
built with EdgeLake's own Dockerfile from the same commit the Pi uses, so every node
in the network runs the same code.

| Component | Pinned to |
|---|---|
| `EdgeLake/EdgeLake` | `main` at `faba50ddf8ee`, package 2.0.2606 |
| `EdgeLake/deployment-scripts` | `main` at `45b830b473a5` |

## Query patterns that carry over

1. Send `User-Agent: AnyLog/1.23` on every REST request
2. Use `127.0.0.1`, not `localhost`, from clients on hosts that resolve localhost to IPv6
3. Omit `destination: network` for local SQL against the node you are talking to
4. Do not use the `run client ()` prefix inside REST command headers
5. Query partition tables directly, since the parent table returns nothing. Confirmed again on EdgeLake
6. Avoid WHERE clauses on channel names containing parentheses. Fetch by time window and filter client-side
7. `state` in `nilm_disaggregated` is a string, `'on'` or `'off'`
8. Exclude `insert_timestamp` from streaming PUT payloads

## Moving existing history

The current host keeps months of readings in Postgres under AnyLog. Before the host is
retired, export each table by month and load it into the cloud archive operator by
streaming PUT. Since both platforms use the same schema and partitioning, no
transformation is needed beyond dropping the system columns.

## Still to confirm

1. The AnyLog remote GUI and its IEMS plugin against an EdgeLake network. It talks to
   the node REST API, so it is expected to work, and the AnyLog EDM GUI is documented
   as usable with both. Tested in Phase 3
2. The MCP client against EdgeLake's `/mcp/sse` endpoint. The endpoint answered in the
   test. The full tool set is checked in Phase 3
