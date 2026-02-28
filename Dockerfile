# ============ Build Stage ============
FROM node:22-alpine AS builder

WORKDIR /app

# Bağımlılıkları önce kopyala (Docker cache optimizasyonu)
COPY package*.json ./
RUN npm ci --omit=dev

# ============ Production Stage ============
FROM node:22-alpine

WORKDIR /app

# Güvenlik: root olmayan kullanıcı
RUN addgroup -S retro && adduser -S retro -G retro

# Build stage'den sadece gerekli dosyaları al
COPY --from=builder /app/node_modules ./node_modules

# Kaynak kodları kopyala
COPY server.js ./
COPY package.json ./
COPY index.html ./
COPY room.html ./

# Port
EXPOSE 3000

# Root olmayan kullanıcıya geç
USER retro

# Sağlık kontrolü
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

# Uygulamayı başlat
CMD ["node", "server.js"]
