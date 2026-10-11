# 04. Raspberry Pi build guide

## Hardware

| Item | Choice | Note |
|---|---|---|
| Board | Raspberry Pi 3 Model B+ | 1 GB LPDDR2, Cortex-A53 |
| Boot media | 16 GB high-endurance microSD | Holds the OS only |
| Data media | USB SSD in a powered enclosure | Holds the EdgeLake data directory and models |
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

## Python

Raspberry Pi OS on Debian 13 ships Python 3.13. The inference code pins numpy below
2.0, and numpy 1.26 publishes no wheels for 3.13, so the services run on Python 3.11
installed by uv. This is the same version as the `python:3.11-slim` containers the
services run in today, so there is no behavior change from moving to the Pi.

| Environment | Requirements | Size on disk, arm64 |
|---|---|---|
| Python 3.11 runtime | uv | 90 MB |
| `/opt/iems/venv` | [pi/requirements.txt](../pi/requirements.txt) | 451 MB |
| `/opt/iems/venv-edgelake` | [pi/requirements-edgelake.txt](../pi/requirements-edgelake.txt) | 123 MB |

The two environments are separate because EdgeLake and the IEMS services pin
different versions of shared packages. `netifaces`, which EdgeLake needs, has no arm64
wheels and builds from source, which is why bootstrap installs `build-essential`.

## Directory layout on the Pi

```
/opt/iems/                     code and environments, read-only to services
  microgrid-manager/           sparse checkout: services/iems without training, streaming/solar-pipeline
  iems-pi-edge/                this repository
  edgelake/EdgeLake/           EdgeLake source at the pinned commit
  edgelake/deployment-scripts/ node scripts, local_script.al installed from streaming/
  python311/                   uv-managed interpreter
  venv/                        IEMS services
  venv-edgelake/               EdgeLake node
/etc/iems/edge.env             IEMS environment, mode 0600
/etc/iems/edgelake.env         EdgeLake node environment, mode 0600
/srv/iems/                     on the SSD
  edgelake/EdgeLake/data/      SQLite databases, JSON archive, watch and bkup folders
  edgelake/EdgeLake/blockchain/ local copy of the network metadata
  models/current -> v12/       symlink flipped by pull_models.sh
  models/v12/                  versioned ONNX sets
  buffer/                      producer overflow spool
```

The sparse checkout keeps the services at about 3 MB. The full `microgrid-manager`
checkout is several gigabytes because of training data and results the Pi never uses.

```bash
git clone --filter=blob:none --sparse -b dev_fin <remote> /opt/iems/microgrid-manager
git -C /opt/iems/microgrid-manager sparse-checkout set --no-cone \
  '/services/iems/*' '!/services/iems/training/' '!/services/iems/models/' \
  '/streaming/solar-pipeline/'
```

## Seeding the first model set

The services load models from `services/iems/models` relative to the repository root.
install.sh replaces that folder with a symlink to `/srv/iems/models/current`, so the
model puller can swap versions. Until the cloud registry exists, seed it by hand with
the six files the inference loop loads.

```bash
sudo -u iems mkdir -p /srv/iems/models/v0
scp host:microgrid-manager/services/iems/models/{nilm_panel1.onnx,nilm_panel2.onnx,nilm_panel3.onnx,panel1_norm_bilstm.json,panel2_norm_bilstm.json,panel3_norm_bilstm.json} /srv/iems/models/v0/
sudo -u iems ln -sfn /srv/iems/models/v0 /srv/iems/models/current
```

## Install

[pi/scripts/install.sh](../pi/scripts/install.sh) installs uv and Python 3.11, builds
both environments, clones EdgeLake and its deployment scripts at the pinned commits,
installs the message clients as the node's local script, copies the units from
[pi/systemd/](../pi/systemd/) and enables them. It does not start anything until both
`/etc/iems/edge.env` and `/etc/iems/edgelake.env` exist.

## Verify

```bash
systemctl status 'iems-*' edgelake-operator
free -m
/opt/iems/iems-pi-edge/pi/scripts/footprint.sh
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
| EdgeLake data and archive | SSD |
| Model files | SSD |
| apt cache | Cleaned after upgrades |

zram is not a substitute for the SSD. It keeps data in RAM, and with 1 GB shared
between programs and zram there is no room for a database there.
