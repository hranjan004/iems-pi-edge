# ADR 0006. Retrain in the cloud, Pi pulls promoted models

Status: Accepted, 2026-10-09

## Context

Retraining needs the full archive and occasional GPU time for label review. Pushing models into the house would require the cloud to have a route onto the home network.

## Decision

Label review and retraining run as cloud batch jobs. Promoted models are written to a versioned registry with a manifest of hashes, feature counts and evaluation results. The Pi pulls on a timer, verifies, switches a symlink and keeps the previous version.

## Consequences

No inbound path into the house is needed. Shadow evaluation happens in the cloud by replaying archived windows, so the Pi never holds two model sets in memory. Rollback is a symlink flip. Model updates are delayed by the pull interval, which is acceptable for models that change at most nightly.
