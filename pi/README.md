# pi

Everything that runs on the Raspberry Pi, as native systemd services.

| Path | Purpose |
|---|---|
| `requirements.txt` | One shared Python environment for every service |
| `config/edge.env.example` | Environment template, copied to `/etc/iems/edge.env` |
| `systemd/` | Units, timers and the `iems-edge.target` that groups them |
| `scripts/bootstrap.sh` | One-time OS hardening: firmware, journald, log2ram, zram, watchdog, SSD, Tailscale |
| `scripts/install.sh` | Virtualenv, permissions, unit installation |
| `scripts/bench_onnx.py` | Inference benchmark, run on the host and the Pi |
| `scripts/healthcheck.sh` | Service, heartbeat, disk, swap, memory and throttling checks |
| `scripts/pull_models.sh` | Pull, verify and activate promoted models, with rollback and pinning |

## Units

| Unit | Runs | MemoryMax |
|---|---|---|
| `anylog-operator.service` | AnyLog edge operator, MQTT broker | 350M |
| `iems-egauge-producer.service` | `streaming/egauge_mqtt_producer.py` | 64M |
| `iems-solar-producer.service` | Solar producer from `microgrid-manager` | 56M |
| `iems-inference.service` | `iems.inference.inference_loop` | 160M |
| `iems-backend.service` | `main_api:app` on 8009 | 180M |
| `iems-dashboard.service` | `server.js` on 47821 | 96M |
| `iems-pull-models.timer` | `pull_models.sh` every 6 hours | n/a |
| `iems-healthcheck.timer` | `healthcheck.sh --fix` every minute | n/a |

```bash
sudo systemctl start iems-edge.target
systemctl list-units 'iems-*' anylog-operator.service
journalctl -u iems-inference -f
```

Guide: [docs/04-pi-setup.md](../docs/04-pi-setup.md).
