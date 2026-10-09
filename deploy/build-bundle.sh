#!/usr/bin/env bash
# Builds the two websites into one folder, ready to upload to a web host.
#
#   API_URL=https://api.example.co.za SITE_URL=https://invigilator.example.co.za deploy/build-bundle.sh
#
# The result is in deploy/bundle/:
#   the candidate website at the top of the folder,
#   the staff portal in the admin/ folder.
# Upload the contents of deploy/bundle/ to the host's web folder.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${API_URL:?Set API_URL to the address the API answers on, for example https://api.example.co.za}"
: "${SITE_URL:?Set SITE_URL to the address of the websites, for example https://invigilator.example.co.za}"
API_URL="${API_URL%/}"
SITE_URL="${SITE_URL%/}"

case "$API_URL" in https://*) ;; *) echo "API_URL must start with https://" >&2; exit 1 ;; esac
case "$SITE_URL" in https://*) ;; *) echo "SITE_URL must start with https://" >&2; exit 1 ;; esac

out=deploy/bundle
rm -rf "$out"
mkdir -p "$out/admin"

echo "Building the candidate website..."
(cd candidate-app && npm ci --silent && VITE_API_BASE="$API_URL" npm run build --silent)
cp -r candidate-app/dist/. "$out/"

echo "Building the staff portal..."
(cd staff-portal && npm ci --silent && VITE_API_BASE="$API_URL" VITE_BASE=/admin/ npm run build --silent)
cp -r staff-portal/dist/. "$out/admin/"

# The candidate website uses addresses such as /invitation/... and /status, so
# every path that is not a file goes to index.html. The staff portal uses
# addresses after a # and needs no such rule.
cat > "$out/.htaccess" <<'HT'
# Send the candidate website's own addresses to the app.
RewriteEngine On
RewriteCond %{REQUEST_URI} !^/admin/
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^ /index.html [L]

# Always use https.
RewriteCond %{HTTPS} off
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]

<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "DENY"
  Header always set Referrer-Policy "no-referrer"
  Header always set Strict-Transport-Security "max-age=31536000"
  Header always set Permissions-Policy "camera=(self), microphone=(self), display-capture=(self)"
  # Only this site and the API may be talked to; no scripts from anywhere else.
  Header always set Content-Security-Policy "default-src 'self'; connect-src 'self' API_URL_HERE; img-src 'self' data: blob: API_URL_HERE; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
</IfModule>

# The files' names change with their content, so browsers may keep them; the pages themselves are always checked.
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/html "access plus 0 seconds"
</IfModule>
HT
sed -i "s#API_URL_HERE#$API_URL#g" "$out/.htaccess"

echo "Done. Upload everything inside $out/ (including the hidden .htaccess file) to the web folder."
echo "Candidates: $SITE_URL/    Staff: $SITE_URL/admin/"
