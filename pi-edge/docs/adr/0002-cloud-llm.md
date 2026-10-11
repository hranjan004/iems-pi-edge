# ADR 0002. Use a cloud language model for Ask and MCP

Status: Accepted, 2026-10-09

## Context

A local 3B instruct model served by Ollama measured 1.37 GB, mostly in swap because it stays resident while idle. Ask responses took tens of seconds. No machine in the house can host a better model.

## Decision

The Ask box and the MCP client call a hosted model over its API. No local model runs on any house machine.

## Consequences

About 1.4 GB is freed. Answer quality and latency improve. Ask and MCP become unavailable during an internet outage, which is acceptable because neither is part of the live monitoring path. Prompts containing household data leave the house, which is covered by the data sharing sign-off in Phase 1. API spend becomes a recurring cost.
