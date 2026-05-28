#!/usr/bin/env bash
# ============================================================
# RetroSesler v2 -> Hetzner CPX22 Deploy
# Usage (lokal makineden, bash/git-bash):
#   bash deploy-to-hetzner.sh
# ============================================================
set -euo pipefail

REMOTE_HOST="178.105.101.180"
REMOTE_USER="root"
SSH_KEY="$HOME/.ssh/retrosesler_hetzner"
REMOTE_DIR="/opt/retrosesler-v2"
NGINX_SITE="/etc/nginx/sites-available/retrosesler.com"
APP_PORT=3000
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $REMOTE_USER@$REMOTE_HOST"
RSYNC_SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no"

echo "==> 1/7  Sunucu durumu kontrol ediliyor"
$SSH "uname -a; node --version 2>/dev/null || echo 'no-node'; pm2 --version 2>/dev/null || echo 'no-pm2'; nginx -v 2>&1"

echo "==> 2/7  Eski Expo web build yedekleniyor (varsa)"
$SSH "if [ -d /var/www/html-app ]; then mv /var/www/html-app /var/www/html-app.backup-\$(date +%Y%m%d-%H%M%S); fi; mkdir -p $REMOTE_DIR"

echo "==> 3/7  Dosyalar tar+ssh ile gonderiliyor"
tar -C "$LOCAL_DIR" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='retrosesler.db' \
  --exclude='.env' \
  --exclude='deploy-to-hetzner.sh' \
  --exclude='data' \
  --exclude='metro.log' \
  --exclude='.idea' \
  -czf - . \
  | $SSH "tar -xzf - -C $REMOTE_DIR"

# data/ klasörü YOK ise (ilk deploy) şablon dosyaları oluştur — sonraki deploy'lar data'yı GEÇMEZ
$SSH "mkdir -p $REMOTE_DIR/data && \
  [ -f $REMOTE_DIR/data/users.json ] || echo '[]' > $REMOTE_DIR/data/users.json && \
  [ -f $REMOTE_DIR/data/dms.json ] || echo '[]' > $REMOTE_DIR/data/dms.json && \
  [ -f $REMOTE_DIR/data/bans.json ] || echo '[]' > $REMOTE_DIR/data/bans.json && \
  [ -f $REMOTE_DIR/data/locks.json ] || echo '{}' > $REMOTE_DIR/data/locks.json && \
  [ -f $REMOTE_DIR/data/friends.json ] || echo '{}' > $REMOTE_DIR/data/friends.json && \
  [ -f $REMOTE_DIR/data/user_rooms.json ] || echo '[]' > $REMOTE_DIR/data/user_rooms.json && \
  chmod 600 $REMOTE_DIR/data/*.json 2>/dev/null || true"

echo "==> 4/7  Mevcut .env korunuyor — secret'lar SADECE sunucuda yaşar"
# .env dosyası sunucuda manuel oluşturuldu (git'e veya scripte hiç girmez).
# Eksik field varsa kullanıcıya uyarı ver, deploy'u durdurmadan devam et.
MISSING_FIELDS=""
for FIELD in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET JWT_SECRET ADMIN_SECRET GOOGLE_CLIENT_ID; do
  if ! $SSH "grep -q '^${FIELD}=' $REMOTE_DIR/.env 2>/dev/null"; then
    MISSING_FIELDS="$MISSING_FIELDS $FIELD"
  fi
done
if [ -n "$MISSING_FIELDS" ]; then
  echo "⚠️  UYARI: Sunucu .env dosyasında eksik field var:$MISSING_FIELDS"
  echo "   SSH ile manuel ekle: ssh root@$REMOTE_HOST 'nano $REMOTE_DIR/.env'"
fi
# JWT_SECRET ve ADMIN_SECRET hiç yoksa rastgele üret (ilk deploy)
$SSH "
  [ -f $REMOTE_DIR/.env ] || touch $REMOTE_DIR/.env
  if ! grep -q '^JWT_SECRET=' $REMOTE_DIR/.env; then
    echo \"JWT_SECRET=\$(openssl rand -hex 32)\" >> $REMOTE_DIR/.env
  fi
  if ! grep -q '^ADMIN_SECRET=' $REMOTE_DIR/.env; then
    echo \"ADMIN_SECRET=\$(openssl rand -hex 16)\" >> $REMOTE_DIR/.env
  fi
  if ! grep -q '^NODE_ENV=' $REMOTE_DIR/.env; then
    echo 'NODE_ENV=production' >> $REMOTE_DIR/.env
  fi
  if ! grep -q '^PORT=' $REMOTE_DIR/.env; then
    echo 'PORT=$APP_PORT' >> $REMOTE_DIR/.env
  fi
  chmod 600 $REMOTE_DIR/.env
"

echo "==> 5/7  Bagimliliklar kuruluyor + pm2 ile baslatiliyor"
$SSH "cd $REMOTE_DIR \
  && (which node >/dev/null || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)) \
  && (which pm2 >/dev/null || npm install -g pm2) \
  && npm ci --omit=dev --no-audit --no-fund \
  && pm2 delete retrosesler-v2 2>/dev/null || true \
  && pm2 start server.js --name retrosesler-v2 --time \
  && pm2 save \
  && pm2 startup systemd -u root --hp /root | tail -1 | bash || true"

echo "==> 6/7  Nginx config yazilip reload ediliyor"
$SSH "cp $NGINX_SITE ${NGINX_SITE}.backup-\$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
cat > $NGINX_SITE << 'NGINXEOF'
# www.retrosesler.com -> retrosesler.com 301 redirect (origin'leri tek tutalim)
server {
    listen 443 ssl;
    server_name www.retrosesler.com;
    ssl_certificate /etc/letsencrypt/live/retrosesler.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/retrosesler.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    return 301 https://retrosesler.com\$request_uri;
}

server {
    server_name retrosesler.com 178.105.101.180;

    access_log /var/log/nginx/retrosesler.access.log;
    error_log  /var/log/nginx/retrosesler.error.log;

    client_max_body_size 16m;

    add_header X-Frame-Options \"SAMEORIGIN\" always;
    add_header X-Content-Type-Options \"nosniff\" always;
    add_header Referrer-Policy \"strict-origin-when-cross-origin\" always;

    # HTML cache'lenmesin — deploy sonrası kullanıcı eski sayfa görmesin
    location ~* \.(html|htm)\$ {
        add_header Cache-Control \"no-cache, no-store, must-revalidate\" always;
        add_header Pragma \"no-cache\" always;
        add_header Expires \"0\" always;
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # Ana sayfa (path /) da HTML olduğu için no-cache
    location = / {
        add_header Cache-Control \"no-cache, no-store, must-revalidate\" always;
        add_header Pragma \"no-cache\" always;
        add_header Expires \"0\" always;
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 86400;
    }

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/retrosesler.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/retrosesler.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    if (\$host = www.retrosesler.com) { return 301 https://\$host\$request_uri; }
    if (\$host = retrosesler.com)     { return 301 https://\$host\$request_uri; }
    listen 80;
    server_name retrosesler.com www.retrosesler.com 178.105.101.180;
    return 404;
}
NGINXEOF
ln -sf $NGINX_SITE /etc/nginx/sites-enabled/retrosesler.com
nginx -t && systemctl reload nginx"

echo "==> 6.5/7  Günlük backup cron + retention"
$SSH "
mkdir -p /root/backups/retrosesler
cat > /etc/cron.daily/retrosesler-backup << 'CRONEOF'
#!/usr/bin/env bash
# RetroSesler günlük veri yedeği (data/ klasörü)
set -e
DATE=\$(date +%Y%m%d)
DEST=/root/backups/retrosesler
mkdir -p \$DEST
tar -czf \$DEST/data-\$DATE.tar.gz -C /opt/retrosesler-v2 data 2>/dev/null || true
# 14 günden eski yedekleri sil
find \$DEST -name 'data-*.tar.gz' -mtime +14 -delete
CRONEOF
chmod +x /etc/cron.daily/retrosesler-backup
# İlk yedeği hemen al
/etc/cron.daily/retrosesler-backup || true
ls -la /root/backups/retrosesler/ | tail -5
"

echo "==> 7/7  Smoke test"
sleep 2
$SSH "curl -s -o /dev/null -w 'lokal:    HTTP %{http_code}\n' http://127.0.0.1:$APP_PORT/"
curl -sk -o /dev/null -w 'public:   HTTP %{http_code}\n' https://retrosesler.com/

echo ""
echo "==> BITTI"
echo "Lobi:   https://retrosesler.com/"
echo "Giris:  https://retrosesler.com/giris"
echo "Admin:  https://retrosesler.com/yonetim-r3tro"
echo ""
echo "pm2 log: ssh -i $SSH_KEY $REMOTE_USER@$REMOTE_HOST 'pm2 logs retrosesler-v2 --lines 50'"
