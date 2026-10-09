# 06. AnyLog topology

## Nodes

| Node | Location | Role | Storage | Retention |
|---|---|---|---|---|
| master | Cloud | Network metadata | Local ledger | n/a |
| edge-operator | Pi | Broker, ingest, local queries | SQLite on SSD | A few days |
| archive-operator | Cloud | Full history, training source | Postgres | Indefinite |

All three join one AnyLog network. Queries issued anywhere in the network are routed
to whichever operator holds the requested rows.

## Why the master is in the cloud

Every node needs to reach the master to join the network and to learn about other
nodes. The house uplink is the least reliable link. Putting the master in the cloud
means a house outage removes one node from the network rather than removing the
network's metadata authority.

## Operating while the master is unreachable

AnyLog nodes answer most metadata queries from their own locally synchronized copy of the
metadata, and blockchain synchronization refreshes that copy from the master. The Pi
operator therefore keeps its local copy and keeps serving local queries and ingesting
data while the master is down. This must be confirmed against the licensed build in
Phase 1, along with what happens to policy updates made during the outage.

## Getting data from the edge to the archive

Two options. Both keep the Pi in charge of when data leaves.

| Option | How | Pros | Cons |
|---|---|---|---|
| A. AnyLog archival transfer | AnyLog's automated archival and transfer to larger nodes | Native, no custom code | Configuration for this case not yet confirmed |
| B. Forwarder | A small service tails the Pi operator by time window and streaming-PUTs to the archive operator | Fully under our control, easy to replay | Custom code to maintain |

AnyLog clusters with high availability replicate data between member operators,
which would push the full archive back onto the Pi. Clusters are therefore not used
for this purpose.

Option A is preferred if the AnyLog team confirms it fits. Option B is the fallback and
is specified as follows.

1. Keep a watermark per table in a small state file on the SSD
2. Every 60 seconds, read rows newer than the watermark from the Pi operator in bounded windows
3. PUT them to the archive operator, excluding `insert_timestamp`, with timestamps lacking a trailing Z
4. Advance the watermark only after the archive confirms the write
5. After an outage, replay windows in order until caught up, rate-limited so the dashboard stays responsive

## Advertising the right address

A cross-host query previously returned empty because the ledger advertised the
operator at `127.0.0.1`. Each node must advertise its Tailscale address as its
external IP, and bind its REST and TCP services to that address and loopback.

## Query patterns that carry over

These are known behaviors of the current AnyLog deployment and apply unchanged.

1. Send `User-Agent: AnyLog/1.23` on every REST request
2. Use `127.0.0.1`, not `localhost`, from clients on hosts that resolve localhost to IPv6
3. Omit `destination: network` for local SQL against the node you are talking to
4. Do not use the `run client ()` prefix inside REST command headers
5. Avoid WHERE clauses on channel names containing parentheses. Fetch by time window and filter client-side
6. `state` in `nilm_disaggregated` is a string, `'on'` or `'off'`
7. Exclude `insert_timestamp` from streaming PUT payloads

## Native deployment on the Pi

AnyLog documents roughly 100 MB without Docker against 300 MB with it, supports running
as an executable in the background, and recommends SQLite for smaller nodes. Its
documentation covers two native paths, a pip package and a systemd service, and the
deployment scripts start a node with
`python3 anylog.py process deployment-scripts/node-deployment/main.al`.
[pi/systemd/anylog-operator.service](../pi/systemd/anylog-operator.service) wraps that.

The catch, checked against the documentation in October 2026: the published pip wheels
are for x86_64 only (Ubuntu and Alpine on linux_x86_64, and macOS x86_64), and the
service guide's binary names are x86_64 as well. An arm64 build of AnyLog does exist as a
Docker image, which is what the current deployment pins. So native arm64 is not
documented, and it is the single largest open question (Q1).

| If the answer to Q1 is | Edge node runs | Pi budget |
|---|---|---|
| A native arm64 build is available | AnyLog natively | About 570 MB |
| No native build | EdgeLake from source, natively | About 570 MB, license-free, feature parity to confirm |
| No native build and EdgeLake lacks a needed feature | AnyLog's arm64 Docker image, everything else native | About 790 MB, tight |
| None of the above fits | Raspberry Pi 5 with 2 GB | Comfortable |

## Questions for the AnyLog team

1. Is the licensed build available as a native arm64 executable, and under the current license?
2. Does an operator keep ingesting and answering local SQL with the master unreachable, and for how long?
3. Does automated archival transfer support pushing from a small operator to a larger one in the same network, with the small node pruning after confirmation?
4. Recommended SQLite settings and partition retention for a 1 GB node ingesting about 16 registers per second
