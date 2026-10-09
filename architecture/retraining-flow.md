# Retraining flow

## Nightly cycle

```mermaid
sequenceDiagram
  autonumber
  participant SCH as Scheduler
  participant AR as Archive and label store
  participant SEL as Window selector
  participant REV as Gemma review job
  participant HQ as Human review queue
  participant TR as Retrain job
  participant EV as Shadow evaluator
  participant RG as Model registry
  participant PI as Pi model puller

  SCH->>AR: export new windows, feedback, device states
  SCH->>SEL: rank by uncertainty and model-rules disagreement
  SEL->>REV: top contested windows plus random confident sample
  REV-->>AR: confirm, correct with confidence, or abstain
  SEL->>HQ: a few questions for the dashboard
  HQ-->>AR: human labels arrive over following days
  SCH->>TR: train per panel with source-weighted loss
  TR->>TR: export ONNX, assert feature counts
  TR->>EV: candidate model set
  EV->>AR: replay archived windows, score on held-out set
  alt candidate beats production on every changed head
    EV->>RG: publish vN+1 with manifest and report
  else
    EV->>RG: store report only
  end
  PI->>RG: poll manifest
  PI->>PI: download, verify hashes, flip symlink, restart inference
```

## Label precedence

```mermaid
flowchart LR
  M["measured"] --> H["human"] --> D["device"] --> R["review"] --> W["rules"]
```

Read left to right as highest to lowest trust. At read time the most trusted label for
a window and appliance wins. Only measured, human and device labels enter the held-out
evaluation set.
