#!/usr/bin/env bash
# Забирает свежий код с GitHub; если он изменился — перезапускает сайт.
set -euo pipefail
cd /opt/journal
git fetch -q origin main
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0
git reset -q --hard origin/main
chmod +x deploy/*.sh
# обновлённые файлы служб, если они поменялись
for u in journal.service journal-update.service journal-update.timer journal-backup.service journal-backup.timer; do
  cmp -s "deploy/$u" "/etc/systemd/system/$u" || install -m 644 "deploy/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl restart journal.service
echo "Обновлено: ${LOCAL:0:7} -> ${REMOTE:0:7}"
