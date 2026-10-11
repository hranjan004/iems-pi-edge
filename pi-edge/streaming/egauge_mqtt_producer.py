#!/usr/bin/env python3
"""eGauge register poller that publishes to the EdgeLake node's MQTT broker.

Replaces the Kafka producer and the Kafka to AnyLog bridge. Each poll reads the
instantaneous rate of every register and publishes one JSON message per register
to the node's broker. A message client (see edgelake_msg_client.al) maps the
topic onto the energy_readings table, whose schema is unchanged:

    ts timestamp, dev varchar, nm varchar, tp char(1), w float, kwh float

Timestamps are UTC without a trailing Z, because AnyLog and EdgeLake streaming
ingest have failed to coerce the Z form.

The same producer works against the current AnyLog host, which is how Kafka is
removed there before any Pi exists.

When the broker is unreachable, messages are appended to a bounded spool file and
replayed in order on reconnect. The spool lives on the SSD, never the SD card.

Configuration comes from the environment (see pi/config/edge.env.example).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("egauge-mqtt")

EGAUGE_URI = os.environ.get("EGAUGE_URI", "")
EGAUGE_USER = os.environ.get("EGAUGE_USER", "owner")
EGAUGE_PASS = os.environ.get("EGAUGE_PASS", "")
EGAUGE_DEV_ID = os.environ.get("EGAUGE_DEV_ID", "")
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "1"))

BROKER_HOST = os.environ.get("ANYLOG_BROKER", "127.0.0.1")
BROKER_PORT = int(os.environ.get("ANYLOG_BROKER_PORT", "1883"))
TOPIC = os.environ.get("EGAUGE_TOPIC", "egauge")
QOS = int(os.environ.get("MQTT_QOS", "0"))

SPOOL_PATH = Path(os.environ.get("SPOOL_PATH", "/srv/iems/buffer/egauge.spool"))
SPOOL_MAX_BYTES = int(os.environ.get("SPOOL_MAX_BYTES", str(256 * 1024 * 1024)))
HEARTBEAT_PATH = Path(os.environ.get("HEARTBEAT_PATH", "/run/iems/egauge.heartbeat"))

_running = True


def _stop(signum, _frame):
    global _running
    log.info("signal %s received, stopping", signum)
    _running = False


def format_ts(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


def device_id() -> str:
    if EGAUGE_DEV_ID:
        return EGAUGE_DEV_ID
    host = EGAUGE_URI.split("//")[-1]
    return host.split(".")[0] or "egauge"


def build_messages(resp: dict, dev: str) -> list[dict]:
    """Turn one /register?rate response into energy_readings rows."""
    ts = format_ts(float(resp.get("ts", "0")))
    rows = []
    for reg in resp.get("registers", []):
        rows.append({
            "ts": ts,
            "dev": dev,
            "nm": reg.get("name", "unknown"),
            "tp": (reg.get("type") or "P")[:1],
            "w": float(reg.get("rate", 0.0)),
            "kwh": 0.0,
        })
    return rows


class Spool:
    """Append-only newline-delimited JSON spool with a size cap.

    When the cap is reached the oldest half is dropped, so a long outage loses the
    oldest readings first and ingestion never stops for lack of disk.
    """

    def __init__(self, path: Path, max_bytes: int):
        self.path = path
        self.max_bytes = max_bytes
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, rows: list[dict]) -> None:
        with self.lock:
            with self.path.open("a", encoding="utf-8") as f:
                for r in rows:
                    f.write(json.dumps(r, separators=(",", ":")) + "\n")
            if self.path.stat().st_size > self.max_bytes:
                self._truncate_oldest_half()

    def _truncate_oldest_half(self) -> None:
        lines = self.path.read_text(encoding="utf-8").splitlines(keepends=True)
        keep = lines[len(lines) // 2:]
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text("".join(keep), encoding="utf-8")
        tmp.replace(self.path)
        log.warning("spool over %d bytes, dropped %d oldest rows", self.max_bytes, len(lines) - len(keep))

    def drain(self, publish) -> int:
        """Replay spooled rows in order. Stops at the first failure and keeps the rest."""
        with self.lock:
            if not self.path.exists() or self.path.stat().st_size == 0:
                return 0
            lines = self.path.read_text(encoding="utf-8").splitlines()
            sent = 0
            for line in lines:
                if not publish(line):
                    break
                sent += 1
            rest = lines[sent:]
            self.path.write_text("".join(l + "\n" for l in rest), encoding="utf-8")
            return sent


class Publisher:
    """Thin wrapper over paho-mqtt that tolerates paho 1.x and 2.x."""

    def __init__(self, host: str, port: int, qos: int):
        import paho.mqtt.client as mqtt

        self.host, self.port, self.qos = host, port, qos
        try:
            self.client = mqtt.Client(
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                client_id="iems-egauge-pub",
            )
        except AttributeError:  # paho 1.x
            self.client = mqtt.Client(client_id="iems-egauge-pub")
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        self.connected = threading.Event()
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

    def _on_connect(self, _c, _u, _f, rc, *_):
        ok = (rc == 0) if isinstance(rc, int) else not getattr(rc, "is_failure", False)
        if ok:
            self.connected.set()
            log.info("connected to broker %s:%s", self.host, self.port)
        else:
            log.error("broker refused connection rc=%s", rc)

    def _on_disconnect(self, *_args):
        self.connected.clear()
        log.warning("disconnected from broker")

    def start(self) -> None:
        self.client.connect_async(self.host, self.port, keepalive=60)
        self.client.loop_start()

    def publish(self, payload: str) -> bool:
        if not self.connected.is_set():
            return False
        info = self.client.publish(TOPIC, payload, qos=self.qos)
        return info.rc == 0

    def stop(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()


def connect_egauge():
    from egauge import webapi

    if not EGAUGE_URI or not EGAUGE_PASS:
        log.error("EGAUGE_URI and EGAUGE_PASS are required")
        sys.exit(2)
    dev = webapi.device.Device(EGAUGE_URI, webapi.JWTAuth(EGAUGE_USER, EGAUGE_PASS))
    log.info("eGauge connected")
    return dev


def heartbeat() -> None:
    try:
        HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        HEARTBEAT_PATH.touch()
    except OSError:
        pass


def run(dry_run: bool, once: bool) -> int:
    dev = connect_egauge()
    dev_id = device_id()
    spool = Spool(SPOOL_PATH, SPOOL_MAX_BYTES)
    pub = None if dry_run else Publisher(BROKER_HOST, BROKER_PORT, QOS)
    if pub:
        pub.start()
        pub.connected.wait(timeout=10)

    polls = errors = spooled = 0
    while _running:
        t0 = time.monotonic()
        try:
            rows = build_messages(dev.get("/register?rate"), dev_id)
            errors = 0
            if dry_run:
                print(json.dumps(rows[:3], indent=2))
                print(f"... {len(rows)} registers")
            else:
                if spool.path.exists() and spool.path.stat().st_size:
                    spool.drain(pub.publish)
                failed = [r for r in rows if not pub.publish(json.dumps(r, separators=(",", ":")))]
                if failed:
                    spool.append(failed)
                    spooled += len(failed)
            polls += 1
            heartbeat()
            if polls % 300 == 0:
                log.info("polls=%d registers=%d spooled_total=%d", polls, len(rows), spooled)
        except Exception as exc:  # meter or network error, keep the loop alive
            errors += 1
            log.error("poll error %d: %s", errors, exc)
            if errors % 3 == 0:
                try:
                    dev = connect_egauge()
                except Exception as exc2:
                    log.error("reconnect failed: %s", exc2)
            time.sleep(min(errors * 2, 30))
            continue
        if once:
            break
        time.sleep(max(0.0, POLL_INTERVAL - (time.monotonic() - t0)))

    if pub:
        pub.stop()
    log.info("stopped after %d polls", polls)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="poll the meter and print, publish nothing")
    ap.add_argument("--once", action="store_true", help="poll once and exit")
    args = ap.parse_args()
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    return run(args.dry_run, args.once)


if __name__ == "__main__":
    sys.exit(main())
