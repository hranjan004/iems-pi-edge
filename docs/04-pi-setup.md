# 04. Raspberry Pi build guide

## Hardware

| Item | Choice | Note |
|---|---|---|
| Board | Raspberry Pi 3 Model B+ | 1 GB LPDDR2, Cortex-A53 |
| Boot media | 16 GB high-endurance microSD | Holds the OS only |
| Data media | USB SSD in a powered enclosure | Holds the AnyLog data directory |
| Power | Official 5V 2.5A supply | Undervoltage corrupts SD cards |
| Network | Wired Ethernet | Wi-Fi off |

### Why the SSD holds data but not the OS

The 3 B+ ships with USB boot enabled, but its native USB boot mode has well documented
compatibility problems with many drives. The reliable pattern is to boot from the
SD card and mount the SSD for write-heavy data. The SD card then sees almost no writes
after boot.

## Operating system

Use a 64-bit image. Prebuilt onnxruntime wheels exist for Linux arm64 on PyPI, but
not for 32-bit ARMv7.

| Option | Idle RAM | Note |
|---|---|---|
| Raspberry Pi OS Lite, 64-bit | about 177 MiB | Default choice, best documented |
| DietPi, 64-bit | about 118 MiB | Saves about 60 MiB, fewer default services |

Flash with Raspberry Pi Imager and set the hostname, user, SSH key and timezone in the
imager's advanced options. Leave Wi-Fi unset.

## Bootstrap

[pi/scripts/bootstrap.sh](../pi/scripts/bootstrap.sh) applies the following. It is
idempotent and prints each change.

1. Minimum GPU memory split (`gpu_mem=16`), Wi-Fi and Bluetooth disabled in `config.txt`
2. Volatile journald with a 32 MB cap, so logs live in RAM
3. log2ram for the remaining `/var/log` writes
4. zram swap sized at 256 MB with zstd, and the SD swap file disabled
5. `noatime` on the root filesystem
6. Unattended security upgrades
7. Tailscale installed and brought up with a pre-auth key from the environment
8. The SSD mounted at `/srv/iems` by UUID with `noatime`
9. A service user `iems` with no login shell

## Directory layout on the Pi

```
/opt/iems/                 code, one virtualenv, read-only to services
  microgrid-manager/       checkout of the services
  iems-pi-edge/            this repository
  venv/
/etc/iems/edge.env         environment, mode 0600, owned by root
/srv/iems/                 on the SSD
  anylog/                  AnyLog home and SQLite files
  models/current -> v12/   symlink flipped by pull_models.sh
  models/v12/              versioned ONNX sets
  models/v11/
  buffer/                  producer overflow spool
```

## Install

[pi/scripts/install.sh](../pi/scripts/install.sh) creates the virtualenv, installs
[pi/requirements.txt](../pi/requirements.txt), copies the units from
[pi/systemd/](../pi/systemd/) and enables them. It does not start anything until the
environment file exists.

## Verify

```bash
systemctl status 'iems-*' anylog-operator
free -m
/opt/iems/venv/bin/python /opt/iems/iems-pi-edge/pi/scripts/bench_onnx.py \
  --models /srv/iems/models/current --ticks 50
/opt/iems/iems-pi-edge/pi/scripts/healthcheck.sh
```

## SD card hygiene

| Write source | Mitigation |
|---|---|
| systemd journal | Volatile storage, capped |
| /var/log | log2ram, synced daily |
| Swap | zram only |
| AnyLog data | SSD |
| Model files | SSD |
| apt cache | Cleaned after upgrades |

zram is not a substitute for the SSD. It keeps data in RAM, and with 1 GB shared
between programs and zram there is no room for a database there.
