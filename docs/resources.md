# Resources

Annotated references used in this design. Facts that change over time, such as prices,
were checked in October 2026 and should be rechecked before relying on them.

## Hardware

| Resource | Why it matters |
|---|---|
| [Raspberry Pi 3 Model B+ product page](https://www.raspberrypi.com/products/raspberry-pi-3-model-b-plus/) | Specifications, Ethernet over USB 2.0 ceiling, production guaranteed until at least January 2030 |
| [Raspberry Pi news: more memory-driven price rises](https://www.raspberrypi.com/news/more-memory-driven-price-rises/) | Pi 3 pricing held because LPDDR2 inventory is in stock, while Pi 4 and Pi 5 with 2 GB or more rose |
| [October 2026 Pi price change coverage](https://www.omgubuntu.co.uk/2026/10/raspberry-pi-2gb-costs-how-much-now/amp) | 2 GB Pi 5 at $77.50 from 1 October 2026, the fallback board |
| [Booting a Raspberry Pi from SSD](https://raspberry.tips/en/?p=10028) | 3 B+ has USB boot enabled from the factory |
| [usb-boot notes](https://mtf.duckdns.org/pub/linux/barjac/soft/usb-boot/usb-boot.txt) | Native USB boot on the 3 B+ has compatibility problems, which is why the SD card keeps the OS |

## Operating system and storage

| Resource | Why it matters |
|---|---|
| [Raspberry Pi OS documentation](https://www.raspberrypi.com/documentation/computers/os.html) | Lite image, configuration, 64-bit userland |
| [DietPi](https://dietpi.com/) | Lighter alternative image |
| [Pi OS Lite and DietPi idle RAM comparison](https://fast.io/resources/openclaw-raspberry-pi-os-best-operating-system-selection-agent.md) | 177 MiB versus 118 MiB idle on 64-bit |
| [Jeff Geerling on 64-bit Pi OS](https://www.jeffgeerling.com/blog/2022/its-official-raspberry-pi-os-goes-64-bit/) | 64-bit applications use 10 to 30% more RAM than 32-bit |
| [log2ram](https://github.com/azlux/log2ram) | Keeps /var/log in RAM to reduce SD writes |
| [openHAB thread on zram and SD wear](https://community.openhab.org/t/reduce-wear-leveling-by-using-zram-for-influxdb/84448) | Why zram is not a place for a database on a 1 GB board |
| [systemd resource control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) | `MemoryHigh` and `MemoryMax` used in every unit |
| [Tailscale on Linux](https://tailscale.com/kb/1031/install-linux) | Tailnet between the Pi and the cloud VM |

## EdgeLake and AnyLog

EdgeLake keeps AnyLog's command language and configuration, so AnyLog's documentation
applies to EdgeLake except where it describes commercial features.

| Resource | Why it matters |
|---|---|
| [AnyLog prerequisites](https://github.com/AnyLog-co/documentation/blob/main/01-%20Getting%20Started/02-%20Prerequisite.md) | 100 MB without Docker, 300 MB with, ARM supported, SQLite for small nodes, archival to larger nodes |
| [AnyLog as a pip package](https://github.com/AnyLog-co/documentation/blob/main/02-%20Installation%20%26%20Deployment/02-%20Virtualization/99-06-%20Pip%20Install.md) | Native install path. Published wheels are x86_64 only |
| [AnyLog as a service](https://github.com/AnyLog-co/documentation/blob/main/02-%20Installation%20%26%20Deployment/02-%20Virtualization/99-05-%20AnyLog%20as%20a%20Service.md) | Running a node under systemd with `EnvironmentFile` |
| [AnyLog blockchain commands](https://github.com/AnyLog-co/documentation/blob/main/08-%20Blockchain%20%26%20Metadata/03-%20Blockchain%20Commands.md) | Nodes query their local synchronized copy of the metadata, synchronization from a master |
| [AnyLog high availability](https://github.com/AnyLog-co/documentation/blob/main/09-%20Data%20Management/03-%20High%20Availability.md) | Clusters replicate operator data, which is why they are not used for the edge to archive path |
| [AnyLog MQTT message broker](https://github.com/AnyLog-co/documentation/blob/main/06-%20Networking%20%26%20Security/05-%20MQTT%20Message%20Broker.md) | The broker the producers publish to |
| [AnyLog documentation index](https://github.com/AnyLog-co/documentation) | Message clients, streaming, deployment |
| [EdgeLake](https://github.com/EdgeLake/EdgeLake) | The platform every node runs. Mozilla Public License 2.0. Pinned at `faba50ddf8ee` |
| [LF Edge, EdgeLake 2.0](https://lfedge.org/edgelake-2-0-building-momentum-at-the-edge/) | EdgeLake as the open-source core, AnyLog EDF as the commercial superset with HA and hardening |
| [EdgeLake on Docker Hub](https://hub.docker.com/r/anylogco/edgelake) | arm64 and amd64 images, newest tag 1.4.2510 is older than the source |
| [EdgeLake deployment scripts](https://github.com/EdgeLake/deployment-scripts) | `main.al` and `set_params.al`, every configuration variable used in pi/config/edgelake.env.example. Pinned at `45b830b473a5` |
| [EdgeLake docker-compose](https://github.com/EdgeLake/docker-compose) | Reference node configurations by node type |

## Inference

| Resource | Why it matters |
|---|---|
| [onnxruntime on PyPI](https://pypi.org/project/onnxruntime/) | arm64 Linux wheels exist |
| [Prebuilt onnxruntime for 32-bit Pi](https://github.com/Kazuhito00/built-onnxruntime-for-raspberrypi-linux) | No official 32-bit ARM wheels, so the OS must be 64-bit |
| [Arm learning path: ONNX on Arm64](https://learn.arm.com/learning-paths/mobile-graphics-and-gaming/onnx/) | Optimization guidance for Arm64 targets |
| [ONNX Runtime threading](https://onnxruntime.ai/docs/performance/tune-performance/threading.html) | Thread settings used in the benchmark |

## Messaging

| Resource | Why it matters |
|---|---|
| [uv Python management](https://docs.astral.sh/uv/guides/install-python/) | Installs the Python 3.11 runtime on the Pi |
| [Eclipse Paho Python client](https://eclipse.dev/paho/files/paho.mqtt.python/html/index.html) | MQTT client used by both producers, callback API version 2 |
| [eGauge web API](https://webapi.egauge.net/) | Register API polled by the producer |

## Models and retraining

| Resource | Why it matters |
|---|---|
| [Gemma release notes](https://ai.google.dev/gemma/docs/releases) | Gemma 4 sizes and dates |
| [Gemma 4 release coverage](https://letsdatascience.com/news/google-releases-gemma-4-open-models-05c4c02a) | Apache 2.0 license, E2B, E4B, 26B MoE, 31B dense |
| [Hugging Face PEFT](https://huggingface.co/docs/peft) | Adapter training for label review |
| [Snorkel weak supervision](https://www.snorkel.org/) | Optional upgrade from fixed source weights to a learned label model |
| [Lambda pricing](https://lambda.ai/pricing) | On-demand GPU rates for batch review |
| [Lambda pricing summary, June 2026](https://usagepricing.com/blueprint/lambda-labs) | Per-minute billing and no egress fees, to be confirmed in the console |

## Papers

| Paper | Relevance |
|---|---|
| Xue et al., [Prompting Large Language Models for Training-Free Non-Intrusive Load Monitoring](https://arxiv.org/abs/2505.06330), 2025 | Earlier LLM-based NILM approach in this project, replaced by BiLSTM for cost and latency |
| Xiong et al., [MATNilm: Multi-appliance-task Non-intrusive Load Monitoring with Limited Labeled Data](https://arxiv.org/abs/2307.14778), 2023 | Evaluated as a replacement. It collapsed to per-appliance priors on this data and BiLSTM was kept |
| Kamyshev et al., [arXiv 2401.01828](https://arxiv.org/abs/2401.01828) | Appliance signature model used by the physics-informed labeler |
| Adabi, UC Santa Cruz PhD dissertation, 2016 | Four-domain IEMS architecture: Load, Generation, Storage, Decision Support |

## Related repositories

| Repository | Relevance |
|---|---|
| `microgrid-manager`, branch `dev_fin` | Services, models and the current compose file |
| `gemma-anomaly` | Snapshot, prompt and review structure reused for label review |
