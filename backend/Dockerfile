FROM node:20
WORKDIR /app

# Manifest primero para cache
COPY package.json ./
# COPY package-lock.json ./   # si tienes lockfile, descomenta

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --only=production --no-audit --no-fund; \
    fi

# Copia TODO el backend (incluye public/, routes/, data/, etc.)
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node","index.js"]
