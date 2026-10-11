# Architecture decision records

Each record states the context, the decision and its consequences. Records are not
edited after acceptance. A changed decision gets a new record that supersedes the old one.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-remove-kafka.md) | Remove Kafka from the data path | Accepted |
| [0002](0002-cloud-llm.md) | Use a cloud language model for Ask and MCP | Accepted |
| [0003](0003-inference-on-pi.md) | Run NILM inference on the Pi | Accepted |
| [0004](0004-dashboard-split.md) | Node dashboard on the Pi, AnyLog GUI in the cloud | Accepted |
| [0005](0005-native-services-on-pi.md) | Run Pi services natively under systemd, not in Docker | Accepted |
| [0006](0006-cloud-retraining-pull-model.md) | Retrain in the cloud, Pi pulls promoted models | Accepted |
| [0007](0007-edgelake-only.md) | Use EdgeLake, the open-source distribution, on every node | Accepted |
