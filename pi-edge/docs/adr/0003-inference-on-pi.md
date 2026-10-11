# ADR 0003. Run NILM inference on the Pi

Status: Accepted, 2026-10-09

## Context

Moving inference to the cloud was considered. The three ONNX models are about 480 KB each, the inference loop measured 80 MB, and it runs every 30 seconds. The decision support engine on the Pi needs current NILM states to make recommendations.

## Decision

The inference loop runs on the Pi against the local AnyLog operator. The cloud is used for retraining, not serving.

## Consequences

Appliance states and recommendations keep working during an internet outage. The Pi carries an extra 80 MB, which the budget allows when services run natively. Inference latency on the Cortex-A53 must be benchmarked before cutover, with a p95 tick time under 10 seconds as the acceptance threshold.
