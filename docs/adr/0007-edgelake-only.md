# ADR 0007. Use EdgeLake, the open-source distribution, on every node

Status: Accepted, 2026-10-09. Supersedes the parts of ADR 0005 and docs/06 that assumed a licensed AnyLog build.

## Context

The current deployment runs licensed AnyLog builds. AnyLog's documented native
packages are x86_64 only, the arm64 build exists only as a Docker image, and Docker
would push the Pi past 1 GB. The license also needs renewing and would have to cover
more nodes. EdgeLake is the open-source core of AnyLog, hosted at LF Edge under the
Mozilla Public License 2.0. The commercial AnyLog edition adds high availability and
security hardening, which this deployment does not use.

EdgeLake was tested on 2026-10-09 from source at commit `faba50ddf8ee`. A native node
ingested the site's meter rate through its own MQTT broker at 96 to 99 MB of RAM.
An operator joined a separate master, registered the IEMS message clients from its
local script, and answered a network query issued at the master.

## Decision

Every node runs EdgeLake. The Pi runs it natively from source at a pinned commit. The
cloud master and archive operator run an image built with EdgeLake's own Dockerfile
from the same commit. No licensed AnyLog build is used.

## Consequences

The Pi stays within its memory budget without Docker, and the license question goes
away for every node. Existing code carries over unchanged because EdgeLake keeps
AnyLog's command language, REST interface and message clients. The node's
configuration variables keep their `ANYLOG_` names.

EdgeLake's default settings archive every ingested JSON file for 30 days, which would
fill a small disk, so the Pi sets a larger file threshold and a two-day archive window.

The AnyLog remote GUI with the IEMS plugin and the MCP client must be verified against
an EdgeLake network in Phase 3. The project sponsor should be told of the change,
since the platform remains the sponsor's open-source project.
