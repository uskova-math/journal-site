#!/usr/bin/env bash
# Сменить пароль учителя:  bash /opt/journal/deploy/set-password.sh
set -euo pipefail
read -rsp "Новый пароль: " P1; echo
read -rsp "Ещё раз: " P2; echo
[ "$P1" = "$P2" ] || { echo "Пароли не совпали."; exit 1; }
printf '%s' "$P1" | runuser -u journal -- env DATA_DIR=/var/lib/journal node --no-warnings /opt/journal/server/server.js set-password
