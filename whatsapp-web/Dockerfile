FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Auth sessions directory (persisted via volume mount)
RUN mkdir -p auth-sessions

CMD ["node", "src/index.js"]
