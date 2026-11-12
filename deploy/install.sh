#!/usr/bin/env bash
# Установка «Журнала групп» на чистый сервер Ubuntu 24.04.
# Запускать от root:
#   curl -fsSL https://raw.githubusercontent.com/uskova-math/journal-site/main/deploy/install.sh | bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/uskova-math/journal-site.git}"
APP_DIR=/opt/journal
DATA_DIR=/var/lib/journal
NODE_MAJOR=24

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mОшибка: %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = 0 ] || fail "запустите от root (в консоли Selectel вы и так root)."
exec </dev/tty   # чтобы вопросы работали и при запуске через curl | bash

say "Обновляю систему и ставлю нужные программы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates xz-utils apt-transport-https gnupg

say "Ставлю Node.js $NODE_MAJOR"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  ARCH=x64; [ "$(uname -m)" = aarch64 ] && ARCH=arm64
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  FILE=$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '{print $2}' | grep "linux-${ARCH}.tar.xz$" | head -1)
  [ -n "$FILE" ] || fail "не нашла Node.js на nodejs.org"
  curl -fsSL "$BASE/$FILE" -o /tmp/node.tar.xz
  curl -fsSL "$BASE/SHASUMS256.txt" | grep " $FILE\$" | sed "s#$FILE#/tmp/node.tar.xz#" | sha256sum -c -
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -f /tmp/node.tar.xz
fi
node --version

say "Ставлю Caddy (он открывает сайт в интернете и сам получает HTTPS-сертификат)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

say "Скачиваю код сайта"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin main && git -C "$APP_DIR" reset -q --hard origin/main
else
  git clone -q "$REPO_URL" "$APP_DIR"
fi

say "Создаю пользователя и папку для данных"
id journal >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin journal
mkdir -p "$DATA_DIR/files" "$DATA_DIR/backups"
chown -R journal:journal "$DATA_DIR"
chmod 750 "$DATA_DIR"

if [ ! -f "$DATA_DIR/config.json" ]; then
  say "Придумайте пароль для входа в ваш кабинет (не короче 6 символов)"
  while true; do
    read -rsp "Пароль: " P1; echo
    read -rsp "Ещё раз: " P2; echo
    [ "$P1" = "$P2" ] || { echo "Пароли не совпали, попробуйте снова."; continue; }
    [ ${#P1} -ge 6 ] || { echo "Слишком короткий пароль."; continue; }
    break
  done
  printf '%s' "$P1" | runuser -u journal -- env DATA_DIR="$DATA_DIR" node --no-warnings "$APP_DIR/server/server.js" set-password
  unset P1 P2
fi

say "Адрес сайта"
CUR_DOMAIN=""
[ -f /etc/journal-domain ] && CUR_DOMAIN=$(cat /etc/journal-domain)
echo "Если у вас есть домен (например matematika-ivanova.ru), который уже указывает на этот сервер, введите его."
echo "Если домена пока нет, просто нажмите Enter: сайт будет открываться по IP-адресу сервера."
read -rp "Домен [${CUR_DOMAIN:-нет}]: " DOMAIN
DOMAIN=${DOMAIN:-$CUR_DOMAIN}
DOMAIN=$(echo "$DOMAIN" | sed -e 's#^https\?://##' -e 's#/.*$##' | tr 'A-Z' 'a-z')
echo -n "$DOMAIN" > /etc/journal-domain
if [ -n "$DOMAIN" ]; then
  SITE_ADDR="$DOMAIN"
else
  SITE_ADDR=":80"
fi
cat > /etc/caddy/Caddyfile <<EOF
$SITE_ADDR {
	encode gzip
	request_body {
		max_size 1GB
	}
	reverse_proxy 127.0.0.1:3000
}
EOF

say "Настраиваю автозапуск и автообновление"
install -m 644 "$APP_DIR/deploy/journal.service"        /etc/systemd/system/journal.service
install -m 644 "$APP_DIR/deploy/journal-update.service" /etc/systemd/system/journal-update.service
install -m 644 "$APP_DIR/deploy/journal-update.timer"   /etc/systemd/system/journal-update.timer
install -m 644 "$APP_DIR/deploy/journal-backup.service" /etc/systemd/system/journal-backup.service
install -m 644 "$APP_DIR/deploy/journal-backup.timer"   /etc/systemd/system/journal-backup.timer
chmod +x "$APP_DIR/deploy/"*.sh
systemctl daemon-reload
systemctl enable --now journal.service journal-update.timer journal-backup.timer
systemctl restart journal.service
systemctl reload caddy || systemctl restart caddy

sleep 2
curl -fsS http://127.0.0.1:3000/healthz >/dev/null || fail "сайт не запустился. Посмотрите: journalctl -u journal -n 50"

IP=$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
say "Готово!"
if [ -n "$DOMAIN" ]; then
  echo "Ваш кабинет: https://$DOMAIN/login"
else
  echo "Ваш кабинет: http://$IP/login"
  echo "Когда появится домен, запустите эту же команду ещё раз и введите его: включится защищённое соединение HTTPS."
fi
echo "Сайт будет сам забирать обновления с GitHub каждые 5 минут."
