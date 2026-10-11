# ADR 0001. Remove Kafka from the data path

Status: Accepted, 2026-10-09

## Context

Kafka carries meter readings from one producer to one consumer, a bridge that PUTs them into AnyLog. The broker runs a JVM with a fixed 1 GB heap and measured 1.2 GB including swap. Kafka UI and the bridge add about 330 MB more. AnyLog already runs an MQTT broker, and the solar producer already publishes to it without Kafka.

## Decision

The eGauge producer publishes one JSON message per register to AnyLog's MQTT broker on topic `egauge`. An AnyLog message client maps the topic to `energy_readings`. Kafka, Kafka UI and the bridge are removed.

## Consequences

About 1.5 GB of memory is freed on the current host, and the Pi becomes viable. Two failure points disappear. Durable buffering between producer and store is lost, so the producer gains a bounded on-disk spool for broker outages. The schema of `energy_readings` does not change, so every consumer is unaffected.
