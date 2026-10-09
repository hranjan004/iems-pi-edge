# streaming

| File | Purpose |
|---|---|
| `egauge_mqtt_producer.py` | Polls the eGauge register API once per second and publishes to the EdgeLake node's MQTT broker, with an on-disk spool for broker outages |
| `edgelake_msg_client.al` | EdgeLake message clients that map the `egauge` and `solar` topics to tables, installed as the node's local script |
| `test_egauge_mqtt_producer.py` | Unit tests for message building and the spool, no meter or broker needed |

The solar producer is unchanged and stays in `microgrid-manager`.

## Run

```bash
pip install -r ../pi/requirements.txt
set -a; . /etc/iems/edge.env; set +a
python3 egauge_mqtt_producer.py --dry-run --once   # meter only, prints rows
python3 egauge_mqtt_producer.py                    # publish
```

## Test

```bash
python3 -m pytest -q
```

See [docs/05-kafka-removal.md](../docs/05-kafka-removal.md) for the cutover procedure.
