FROM node:20

WORKDIR /app

# Copiamos solo manifest primero para aprovechar capa de cache
COPY package.json ./
# Si tienes lock, descomenta la siguiente línea y asegúrate de que exista en backend/
# COPY package-lock.json ./

# Instala deps (usa npm ci si tienes lockfile)
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --only=production --no-audit --no-fund; fi

# Copia el resto del código del backend
COPY . .

ENV PORT=8080
EXPOSE 8080

# Ajusta si tu entrypoint es otro archivo
CMD ["node","index.js"]
