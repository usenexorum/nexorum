#!/bin/bash
# Deploy the Nexorum website to usenexorum.com on the VPS.   bash deploy/deploy.sh
# The box has very little free RAM, so the site is served as static files by nginx (no Node process).
# /api/sim/status answers {"enabled":false}, so /try runs the Recorded simulation and hides Live.
# Only touches /var/www/usenexorum and the nginx site "usenexorum.com"; never other sites or services.
set -e
H=${NEXORUM_VPS:-root@202.10.40.112}
KEY="$HOME/.ssh/peppy_vps"
K="-i $KEY -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$(mktemp -d)/usenexorum-site.tgz"

echo "== 1/4 SSH"
ssh $K $H true && echo "login ok"

echo "== 2/4 Package site/"
tar czf "$PKG" -C "$ROOT/site" .
ls -la "$PKG" | awk '{print $5" bytes"}'

echo "== 3/4 Upload"
scp -q $K "$PKG" $H:/root/usenexorum-site.tgz

echo "== 4/4 Install"
ssh $K $H 'bash -s' <<'REMOTE'
set -e
D=/var/www/usenexorum
NEW=$D.new
rm -rf $NEW && mkdir -p $NEW
tar xzf /root/usenexorum-site.tgz -C $NEW
chown -R www-data:www-data $NEW 2>/dev/null || true
[ -d $D ] && rm -rf $D.old && mv $D $D.old
mv $NEW $D

CONF=/etc/nginx/sites-available/usenexorum.com
if [ ! -f $CONF ] || ! grep -q "managed by Certbot" $CONF; then
cat > $CONF <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name usenexorum.com www.usenexorum.com;
    root /var/www/usenexorum;
    index index.html;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header X-Frame-Options SAMEORIGIN always;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/css application/javascript text/javascript application/json image/svg+xml application/xml text/plain;

    location = /api/sim/status { default_type application/json; add_header Cache-Control no-store; return 200 '{"enabled":false,"model":null}'; }
    location /api/ { default_type application/json; return 404 '{"error":{"type":"not_found","message":"Not found."}}'; }

    location ~* \.(png|jpg|jpeg|webp|svg|ico|woff2)$ { expires 7d; add_header Cache-Control "public"; try_files $uri =404; }
    location ~* \.(js|css)$ { expires 1h; try_files $uri =404; }
    location / { add_header Cache-Control "no-cache"; try_files $uri $uri/ =404; }

    error_page 404 /404.html;
}
NGINX
fi
ln -sf $CONF /etc/nginx/sites-enabled/usenexorum.com
nginx -t
systemctl reload nginx
rm -rf $D.old /root/usenexorum-site.tgz
echo "-- deployed $(find $D -type f | wc -l) files"
curl -s -o /dev/null -w "-- local check: %{http_code}\n" -H "Host: usenexorum.com" http://127.0.0.1/
curl -s -H "Host: usenexorum.com" http://127.0.0.1/api/sim/status; echo
REMOTE
