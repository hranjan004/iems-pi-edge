# ADR 0005. Run Pi services natively under systemd, not in Docker

Status: Accepted, 2026-10-09

## Context

With Docker the Pi budget totals about 1050 MB, over the 1 GB of the board. AnyLog documents about 100 MB without Docker versus 300 MB with it, and the Docker daemon and containerd measured 377 MB on the current host.

## Decision

Every service on the Pi runs as a systemd unit with `MemoryHigh` and `MemoryMax`, from one Python virtualenv and one Node runtime. The cloud side keeps Docker Compose.

## Consequences

The budget drops to about 570 MB, leaving roughly 400 MB of headroom. The single `docker compose up` bring-up is replaced by an install script and unit files on the Pi. Dependency isolation between Python services is weaker, so they share one pinned requirements file. This depends on a native arm64 AnyLog build, which is open question Q1. The documented pip wheels are x86_64 only, so the fallbacks are EdgeLake from source or running AnyLog alone from its arm64 Docker image, as set out in docs/06.
