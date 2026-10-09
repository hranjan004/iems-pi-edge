# Deployment

## Raspberry Pi

```mermaid
flowchart TB
  subgraph PI["Raspberry Pi 3 B+, 64-bit OS Lite"]
    direction TB
    subgraph SYSTEMD["systemd units with MemoryMax"]
      U1["edgelake-operator<br/>32148 TCP, 32149 REST, 1883 MQTT<br/>MemoryMax 200M"]
      U2["iems-egauge-producer<br/>MemoryMax 64M"]
      U3["iems-solar-producer<br/>MemoryMax 56M"]
      U4["iems-inference<br/>MemoryMax 160M"]
      U5["iems-backend<br/>8009<br/>MemoryMax 180M"]
      U6["iems-dashboard<br/>47821<br/>MemoryMax 96M"]
      U7["iems-pull-models.timer"]
      U8["tailscaled"]
    end
    subgraph SD["microSD, read-mostly"]
      OS["OS, /opt/iems code and venv"]
      RAM["journal and /var/log in RAM<br/>zram swap"]
    end
    subgraph SSD["USB SSD at /srv/iems"]
      AL[("edgelake/ SQLite and JSON archive")]
      MD[("models/current -> vN")]
      SP[("buffer/ producer spool")]
    end
  end
  U1 --- AL
  U4 --- MD
  U2 --- SP
```

## Cloud

```mermaid
flowchart TB
  subgraph VM["Always-on VM, 2 vCPU, 4 GB, Docker Compose"]
    M["edgelake-master<br/>32048, 32049"]
    A["edgelake-archive<br/>32158, 32159, MCP"]
    PG[("postgres")]
    G["iems-remote-gui<br/>3001"]
    T["tailscale"]
  end
  subgraph STORE["Object storage"]
    R[("model registry<br/>v1 ... vN with manifests")]
    X[("training exports")]
  end
  subgraph JOBS["On-demand instances"]
    J1["label review, GPU"]
    J2["retrain, CPU"]
  end
  A --- PG
  PG --> X
  X --> J1
  X --> J2
  J1 --> J2
  J2 --> R
```

## Network

| From | To | Port | Path |
|---|---|---|---|
| Producers | Edge operator | 1883 | Loopback |
| Inference, backend, dashboard | Edge operator | 32149 | Loopback |
| Dashboard | Backend | 8009 | Loopback |
| Dashboard | Home Assistant | 8123 | House LAN |
| Household browsers | Dashboard | 47821 | House LAN |
| Edge operator | Master | 32048 | Tailnet |
| Edge operator | Archive operator | 32158 | Tailnet |
| GUI | Edge operator | 32149 | Tailnet |
| GUI IEMS plugin | Backend | 8009 | Tailnet |
| Model puller | Registry | 443 | Internet |
