# Single image that runs BOTH the Node API and the Python scripts it spawns.
# The server auto-detects .venv/bin/python, so we build the venv at /app/.venv.

FROM node:20-slim

# Python for the gex / voldesk / faber / optionstrat_flow scripts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Node deps (cached layer) ---
COPY package*.json ./
RUN npm ci

# --- App source ---
COPY . .

# --- Python venv (yfinance + openpyxl) ---
RUN python3 -m venv .venv \
    && .venv/bin/pip install --no-cache-dir --upgrade pip \
    && .venv/bin/pip install --no-cache-dir -r gex/requirements.txt

# --- Build the React frontend into dist/ (Express serves it in prod) ---
RUN npm run build

ENV NODE_ENV=production
# Render injects PORT; the server reads process.env.PORT (fallback 3001).
EXPOSE 3001

CMD ["node", "server/index.js"]
