FROM node:20
WORKDIR /app

COPY package.json ./
# COPY package-lock.json ./   # descomenta si usas lockfile

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --only=production --no-audit --no-fund; \
    fi

# Copiá todo el backend (public/, routes/, data/, etc.)
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# ⬇️ Tu entrypoint real está en backend/
CMD ["node","backend/index.js"]
