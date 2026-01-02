FROM node:20-slim

# Install dependencies for Chromium/Puppeteer
RUN apt-get update && apt-get install -y \
    wget curl unzip gnupg ca-certificates \
    fonts-liberation libx11-6 libx11-xcb1 libxcb1 \
    libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
    libnss3 libxrandr2 libasound2 libatk1.0-0 libcups2 libdbus-1-3 \
    libxss1 libxext6 libglib2.0-0 libgbm1 libpangocairo-1.0-0 \
    libpango-1.0-0 libgtk-3-0 --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --production

# Copy application code
COPY . .

# Cloud Run sets PORT environment variable (default 8080)
ENV PORT=8080
EXPOSE 8080

# Start the scanner server
CMD ["node", "server.js"]
