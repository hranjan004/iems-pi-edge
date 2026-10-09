# 03. Memory budget

## The board

The Raspberry Pi 3 Model B+ has a Broadcom BCM2837B0 quad-core Cortex-A53 at 1.4 GHz
and 1 GB of LPDDR2. Ethernet is gigabit over USB 2.0 with a ceiling of about 300 Mbps,
which is far more than this workload needs. The board is in production until at least
January 2030. The 3 A+ has 512 MB and is not viable for this design.

## Budget with Docker versus native services

| Component | Docker | Native | Source of the figure |
|---|---|---|---|
| OS, 64-bit Raspberry Pi OS Lite, idle | 177 MB | 177 MB | DietPi published comparison |
| AnyLog operator | about 300 MB | about 100 MB | AnyLog documented requirement |
| IEMS backend | 100 MB | 100 MB | Measured on the host |
| NILM inference loop | 80 MB | 80 MB | Measured on the host |
| Node dashboard | 37 MB | 37 MB | Measured on the host |
| Tailscale | 35 MB | 35 MB | Measured on the host |
| eGauge producer | 27 MB | 27 MB | Measured on the host |
| Solar producer | 16 MB | 16 MB | Measured on the host |
| Docker daemon and containerd | about 280 MB | none | Measured 377 MB on the host with 12 containers, scaled down |
| **Total** | **about 1050 MB** | **about 570 MB** | |

With Docker the stack exceeds 1 GB before any working set growth. Run natively, it
leaves roughly 400 MB of headroom. This is the reason for [ADR 0005](adr/0005-native-services-on-pi.md).

Merging the backend and inference loop into one process should recover a further
30 to 60 MB by loading onnxruntime once. Switching the OS to DietPi saves about 60 MB.

## Caveats on the figures

1. **Host measurements are x86_64.** The 64-bit ARM userland typically uses 10 to 30%
   more RAM than 32-bit for the same application, and x86_64 and arm64 are broadly similar,
   but every figure must be re-measured on the Pi in Phase 2.
2. **The AnyLog operator is the largest uncertainty.** It measures 695 MB on the host,
   where it also serves the MCP endpoint, the Postgres connector and the full archive.
   The Pi operator does none of those. The documented native figure of 100 MB is the
   target, and the Phase 2 acceptance threshold is set so that a figure up to about
   300 MB still fits.
3. **Swap is not headroom.** Swap on an SD card is slow and wears the card. The design
   uses zram for a small compressed swap and treats any sustained swap use as a failure.

## Limits enforced by systemd

Each unit in [pi/systemd/](../pi/systemd/) sets `MemoryHigh` and `MemoryMax` so that a
leak in one service is contained instead of pushing the whole board into OOM.

| Unit | MemoryHigh | MemoryMax |
|---|---|---|
| anylog-operator | 280M | 350M |
| iems-backend | 140M | 180M |
| iems-inference | 120M | 160M |
| iems-dashboard | 64M | 96M |
| iems-egauge-producer | 48M | 64M |
| iems-solar-producer | 40M | 56M |

These start loose and are tightened from the Phase 2 measurements.

## If it does not fit

In order of preference.

1. Merge backend and inference into one process
2. Switch to DietPi
3. Shorten the operator retention window
4. If AnyLog must run from its arm64 Docker image (no native arm64 build, see
   [06](06-anylog-topology.md)), run only that one container. Docker plus a 300 MB
   operator brings the total to about 790 MB, which fits but leaves little margin
5. Move to a Raspberry Pi 5 with 2 GB. As of October 2026 it lists at $77.50 after the
   memory-driven price increases, while Pi 3 pricing is unchanged because its LPDDR2
   inventory is held in stock. Nothing else in this design changes.
