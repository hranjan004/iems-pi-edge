# 07. Cloud services

## What runs in the cloud and why

| Service | Why it is not on the Pi |
|---|---|
| EdgeLake master | Must outlive house outages, see [06](06-edgelake-topology.md) |
| EdgeLake archive operator and Postgres | Indefinite history does not fit on a 1 GB edge node |
| AnyLog remote GUI with the IEMS plugin and MCP client | 632 MB image, not needed for the live view |
| Language model for Ask and MCP | Replaces a local 3B model that used 1.37 GB |
| Retraining and label review | Batch compute, GPU for review only |

## Hosting shape

One small always-on VM for the master, archive operator, Postgres and GUI. Batch jobs
run on separate on-demand instances that exist only while a job runs.

| Workload | Instance | Always on |
|---|---|---|
| Master, archive operator, Postgres, GUI | 2 vCPU, 4 GB RAM, 100 GB disk | Yes |
| BiLSTM retraining | CPU instance, 4 to 8 vCPU | No, nightly or weekly |
| Label review with Gemma | Single GPU, by the hour | No, nightly batch |

The VM joins the same tailnet as the Pi. It exposes no public ports.

## Language model

The Ask box and the MCP client call a hosted model over its API. The model choice is a
configuration value in the GUI environment, not a code change. The prompt context
assembly in the Ask path currently fetches feeds serially, which was the main source of
its latency. That fix is independent of where the model runs and should land first.

## Compose skeleton

[cloud/docker-compose.yml](../cloud/docker-compose.yml) defines the always-on services
with placeholders for images, credentials and addresses. Values come from
`cloud/.env`, which is gitignored. [cloud/.env.example](../cloud/.env.example) lists
every variable.

## Cost shape

The always-on VM is the only recurring compute cost. GPU time is rented per job.
Lambda lists on-demand single-GPU rates from under $1 to several dollars per hour as of
mid 2026, and billing granularity has been reported as both per-minute and per-hour,
so check the console before scheduling many short jobs. A nightly review job of under an
hour on a mid-range GPU keeps GPU spend small relative to the VM.

## Handover

The cloud side needs an owner after the current maintainer graduates. Before Phase 4,
the cloud account, the tailnet and the model registry should be under a lab or project
account, not a personal one, and this repository should name who holds each credential.
