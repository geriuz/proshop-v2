# ---------- Etapa 1: construir el frontend (React) ----------
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- Etapa 2: dependencias de producción del backend ----------
FROM node:20-alpine AS backend-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---------- Etapa 3: imagen final (solo lo necesario para ejecutar) ----------
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=5000
WORKDIR /app

COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend
COPY --from=frontend-build /app/frontend/build ./frontend/build

# Seguridad: no ejecutar como root
RUN mkdir -p uploads && chown -R node:node /app
USER node

EXPOSE 5000

# Verificación de salud usada localmente con "docker run"
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://localhost:5000/api/health || exit 1

CMD ["node", "backend/server.js"]
