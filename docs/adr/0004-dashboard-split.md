# ADR 0004. Node dashboard on the Pi, AnyLog GUI in the cloud

Status: Accepted, 2026-10-09

## Context

The deployment has two interfaces. The Node dashboard is a single-file server using only Node built-ins, measured at 37 MB, and it controls the thermostat through Home Assistant on the LAN. The AnyLog remote GUI with the IEMS plugin and MCP client is a 632 MB image bundling FastAPI and a React frontend.

## Decision

The Node dashboard runs on the Pi and serves the household on the LAN. The AnyLog GUI runs in the cloud next to the language model. Accept, Defer and Dismiss on the dashboard call the IEMS backend on the Pi directly.

## Consequences

The live view and thermostat control survive an outage, and the Home Assistant token never leaves the house. The GUI's IEMS plugin proxies to the backend on the Pi over the tailnet, so it shows the Pi as offline when the link is down. The dashboard's sources handler must be fixed first, since it currently pulls about 28,000 rows per poll.
