# System overview

```mermaid
flowchart LR
  subgraph HOUSE["House LAN"]
    direction TB
    EG["eGauge meter<br/>1 s register API"]
    SA["Solar Assistant<br/>MQTT"]
    HA["Home Assistant<br/>thermostat, device states"]
  end

  subgraph PI["Raspberry Pi 3 B+, native systemd services"]
    direction TB
    EGP["egauge producer"]
    SAP["solar producer"]
    OP[("AnyLog edge operator<br/>MQTT broker, SQLite on SSD")]
    INF["NILM inference<br/>3 BiLSTM ONNX models"]
    BE["IEMS backend<br/>FastAPI, decision support"]
    DASH["Node dashboard :47821"]
    PULL["model puller"]
  end

  subgraph CLOUD["Cloud, on the tailnet"]
    direction TB
    MS["AnyLog master"]
    AOP[("Archive operator<br/>Postgres")]
    GUI["AnyLog GUI<br/>IEMS plugin, MCP, Ask"]
    LLM["Hosted LLM API"]
    REV["Label review<br/>Gemma, GPU, nightly"]
    TRN["BiLSTM retraining<br/>CPU, weekly"]
    REG[("Model registry")]
  end

  EG --> EGP
  SA --> SAP
  EGP -->|MQTT| OP
  SAP -->|MQTT| OP
  OP <--> INF
  OP --> BE
  BE --> DASH
  DASH <--> HA

  OP -.->|metadata| MS
  OP -.->|archive| AOP
  GUI -.->|network query| OP
  GUI --> LLM
  AOP --> REV --> TRN --> REG
  PULL -.->|pull, verify| REG
  PULL --> INF
```

Solid lines stay on one machine or the house LAN. Dashed lines cross the tailnet.
The Pi opens every tailnet connection except GUI queries, which reach only the Pi's
AnyLog REST port. Nothing in the cloud can reach Home Assistant or the meter.
