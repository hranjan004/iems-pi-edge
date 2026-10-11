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

## Detail: every prediction chart

Each chart shows the next 24 hours in 15-minute steps, with the shaded uncertainty band, peak, low and the value at a selected time. The footer names the model that won validation for that channel, its test error and its band coverage.

| Battery state of charge | Battery temperature |
|---|---|
| ![Battery state of charge](detail/pred_01_battery_state_of_charge.png) | ![Battery temperature](detail/pred_02_battery_temperature.png) |

| Panel 1 (HVAC) | Panel 2 (H2O) |
|---|---|
| ![Panel 1 HVAC](detail/pred_03_panel1_hvac.png) | ![Panel 2 H2O](detail/pred_04_panel2_h2o.png) |

| Panel 3 (Kitchen) | Grid power |
|---|---|
| ![Panel 3 Kitchen](detail/pred_05_panel3_kitchen.png) | ![Grid power](detail/pred_06_grid_power.png) |

| Shop | Generac generator |
|---|---|
| ![Shop](detail/pred_07_shop.png) | ![Generac power](detail/pred_08_generac_power.png) |

| Solar PV |
|---|
| ![Solar PV](detail/pred_09_solar_pv.png) |

## Detail: weather charts

| Temperature | Solar irradiance |
|---|---|
| ![Temperature](detail/weather_01_temperature.png) | ![Solar irradiance](detail/weather_02_solar_irradiance.png) |

## Detail: Ask, one question each

Each preset question was asked in a fresh chat. Nemotron 3.5 Lightning, running locally on the GX10, answered it from the live meter, solar and appliance data.

**Which appliances are on right now and what is each drawing?** The answer includes Nemotron's own consistency check, which flags an ON report the measured panel total does not support.
![Ask: appliances on](detail/ask_01_which_appliances_are_on_right_now_and_wh.png)

**Is the battery charging or discharging, and how much energy is stored?**
![Ask: battery](detail/ask_02_is_the_battery_charging_or_discharging_a.png)

**How much of the house load is solar covering right now?**
![Ask: solar coverage](detail/ask_03_how_much_of_the_house_load_is_solar_cove.png)

**Which panel is drawing the most power, and how much?**
![Ask: biggest panel](detail/ask_04_which_panel_is_drawing_the_most_power_an.png)

**Summarise the last 24 hours of HVAC energy.**
![Ask: HVAC summary](detail/ask_05_summarise_the_last_24_hours_of_hvac_ener.png)

**Which loads could I defer to cut the next peak period?**
![Ask: deferrable loads](detail/ask_06_which_loads_could_i_defer_to_cut_the_nex.png)
