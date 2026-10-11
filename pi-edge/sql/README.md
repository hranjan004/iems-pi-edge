# sql

| File | Lives on | Purpose |
|---|---|---|
| `nilm_feedback.sql` | Pi, archived to the cloud | Household confirmations, corrections and live tags |
| `label_provenance.sql` | Cloud only | Every training label with its source, plus views that resolve precedence and loss weights |

The cloud compose mounts this folder as Postgres init scripts, so both run on first start.
The Pi operator uses SQLite and creates `nilm_feedback` from the first streamed row,
so the Postgres DDL is the reference schema there.

Design: [docs/08-retraining-pipeline.md](../docs/08-retraining-pipeline.md).
