# Nest API for Google Cloud Run (uses firebase-admin → Firestore in the same GCP / Firebase project).
# Build: docker build -t trading-signals-api ./backend
# Cloud Run sets PORT (typically 8080); configuration.ts reads process.env.PORT.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/main.js"]
