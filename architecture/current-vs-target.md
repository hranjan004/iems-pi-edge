# Current versus target

## Current, one x86 host, about 2.8 GB RAM plus 4.3 GB swap

```mermaid
flowchart LR
  EG[eGauge] --> EP[egauge-producer] --> K[(Kafka 1.2 GB)] --> BR[bridge] --> OP[operator1]
  K --> KUI[kafka-ui 305 MB]
  SA[Solar Assistant] --> SP[solar-producer] --> OP
  OP --> PG[(Postgres)]
  MS[master] --- OP
  OP --> INF[inference] --> OP
  OP --> BE[backend, started by hand]
  OP --> DASH[dashboard]
  BE --> GUI[remote GUI] --> OL[Ollama 1.37 GB]
  OP --> GR[Grafana]
```

## Target, Pi plus cloud, about 570 MB on the Pi

```mermaid
flowchart LR
  subgraph PI[Pi]
    EG[eGauge] --> EP[egauge producer] --> OP[edge operator]
    SA[Solar Assistant] --> SP[solar producer] --> OP
    OP --> INF[inference] --> OP
    OP --> BE[backend]
    OP --> DASH[dashboard]
    BE --> DASH
  end
  subgraph CLOUD[Cloud]
    MS[master]
    AR[archive operator] --> PG[(Postgres)]
    GUI[remote GUI] --> LLM[hosted LLM]
  end
  OP -.-> MS
  OP -.-> AR
  GUI -.-> OP
```

| Removed | Moved to cloud | Stays at the edge |
|---|---|---|
| Kafka, Kafka UI, bridge, Grafana, Ollama | Master, Postgres archive, remote GUI, LLM | Producers, operator, inference, backend, dashboard |
