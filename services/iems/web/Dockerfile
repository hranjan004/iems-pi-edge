# IEMS live dashboard — single-file zero-dependency Node server.
# Renders KPIs, NILM ON/OFF grid, derived solar, modeled battery SOC, DSS.
#
# Built from the repo root.

FROM node:20-alpine

WORKDIR /app

# server.js uses only Node built-ins (http). No npm install needed.
COPY services/iems/web/server.js /app/server.js
COPY services/iems/web/chart-analysis.js /app/chart-analysis.js
COPY services/iems/web/readiness.js /app/readiness.js
COPY services/iems/web/forecast.html /app/forecast.html
COPY services/iems/web/system-map.html /app/system-map.html

ENV NODE_ENV=production \
    PORT=47821

EXPOSE 47821
CMD ["node", "/app/server.js"]
