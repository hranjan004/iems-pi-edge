# Internet outage

```mermaid
sequenceDiagram
  autonumber
  participant P as Producers
  participant OP as Edge operator
  participant INF as Inference and DSS
  participant D as Dashboard
  participant AR as Archive operator
  participant G as Cloud GUI

  Note over OP,AR: Uplink drops
  P->>OP: readings continue over loopback
  INF->>OP: inference continues
  D->>OP: live view continues on the LAN
  OP-xAR: archive transfer fails, watermark held
  G-xOP: network queries fail
  G->>G: shows Pi offline, not zero load

  Note over OP,AR: Uplink returns
  OP->>AR: replay windows oldest first from watermark
  AR-->>OP: confirm each window
  OP->>OP: advance watermark, prune beyond retention
  G->>OP: network queries resume
```

The Pi's retention window must be longer than the longest outage it should survive
without loss. A few days of SQLite on the SSD covers ordinary outages. Longer ones
lose the oldest unarchived rows, and the healthcheck alerts before that happens.
