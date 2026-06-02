#!/usr/bin/env python3
"""Add no-cache headers for clean URL routes in nginx config"""

CONF = '/etc/nginx/sites-enabled/retrosesler'

content = open(CONF).read()

new_block = """    # Temiz URL rotalari - HTML sayfalar, cachelenmesin
    location ~ ^/(oda|giris|sifre-sifirla|yonetim-r3tro|okey|hakkimizda|gizlilik|kullanim-sartlari) {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

"""

marker = '    # Ana sayfa'
if 'Temiz URL rotalari' not in content:
    content = content.replace(marker, new_block + marker)
    with open(CONF, 'w') as f:
        f.write(content)
    print('INSERTED')
else:
    print('ALREADY EXISTS')
