# IEMS on the GX10: screenshots

Captured live from the ASUS Ascent GX10 (NVIDIA GB10) on October 11, 2026, with headless Firefox. The readings come from the authenticated eGauge and Solar Assistant web collectors; replay is off.

## Dashboard (port 47821)

### General
![General tab overview](01_general_overview.png)
Live power cards for each panel, the grid, solar, battery and generator, source status, house demand by panel, and the recommended appliance plan.

![All power cards expanded](02_general_all_power_cards.png)
Every power card expanded: each panel, the shop, the generator, solar, battery state of charge and the inverter.

![Solar, battery and inverter series](03_general_detail_series.png)
Solar, battery and inverter series, battery state of charge, daily energy figures and the tariff planning rates.

### Anomalies
![Anomalies tab](04_anomalies.png)
Critical issues, the relay action log and the full event history of unusual panel behaviour.

### Appliances (NILM)
![Appliances tab](05_appliances_nilm_heatmap.png)
Live ON/OFF decisions for the appliances on each panel, written by the inference engine. That engine is Nemotron 3.5 Lightning fine-tuned with LoRA, with a per-appliance BiLSTM fallback.

![All 22 appliance heads](06_appliances_all_22_heads.png)
All 22 appliance heads across the HVAC, H2O and kitchen panels, idle appliances included.

### Ask
![Ask tab](07_ask_nemotron.png)
A question answered from live telemetry by Nemotron 3.5 Lightning running locally on the GX10. The answer includes its own consistency check, which flags an ON report the measured panel total does not support.

### Predictions
![Power outlook](08_predictions_power_outlook.png)
24-hour forecasts in 15-minute steps for each channel, with calibrated uncertainty bands. Each channel uses the model that won validation: TiDE, XGBoost, a blend or a seasonal baseline.

![Battery outlook](09_predictions_battery_outlook.png)
Battery state of charge and battery temperature forecasts, with their upper and lower bounds.

### System map
![System map](10_system_map.png)
The verified deployment graph: hardware, external sources, datasets, services, models, meters and meter channels.

### Weather
![Weather tab](11_weather_readiness.png)
Temperature and solar irradiance, past and forecast. These feed the readiness monitor.

## Supporting services

![AnyLog remote GUI](12_anylog_remote_gui.png)
The AnyLog remote GUI (port 3001), connected to the operator node that stores the telemetry.

![Kafka UI](13_kafka_ui.png)
Kafka UI (port 8080): live messages on the `egauge-energy` topic.

![Appliance forecaster](14_appliance_forecaster.png)
The appliance-usage forecaster (port 8765). It shows the 24-hour P(on) heatmap per appliance, the house load forecast, the model leaderboard (deep, LightGBM, climatology) and the champion history with hot swaps.

![NVIDIA txt2kg](15_knowledge_graph_txt2kg.png)
NVIDIA txt2kg (port 47822), the knowledge-graph builder behind the system map, with its ArangoDB graph store (91 nodes, 127 relationships).
