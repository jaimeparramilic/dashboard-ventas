# backend/Dockerfile
FROM node:20
WORKDIR /app

COPY package.json ./
# COPY package-lock.json ./

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --only=production --no-audit --no-fund; \
    fi

# Copia todo el backend (public/, routes/, data/, index.js, etc.)
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# ✅ Con contexto backend/, el entry está en /app/index.js
CMD ["node","index.js"]
