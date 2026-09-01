# ================================================================
# DOCKERFILE FOR DOKPLOY & CONTAINER DEPLOYMENT
# JStore Digital Bot (Node.js 20 on Debian Bookworm Slim)
# ================================================================

FROM node:20-bookworm-slim AS base

# Install system dependencies required for canvas, cairo, pango, and sqlite build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ca-certificates \
    curl \
    sqlite3 \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Set timezone to Asia/Jakarta (WIB)
ENV TZ=Asia/Jakarta
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --build-from-source || npm install --build-from-source

# Copy the rest of the application files
COPY . .

# Create necessary persistent data directories
RUN mkdir -p /app/database /app/backups

# Set node environment
ENV NODE_ENV=production

# Start command
CMD ["npm", "start"]
