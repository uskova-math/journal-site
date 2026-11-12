'use strict';
// Ночная копия базы: DATA_DIR/backups/journal-ГГГГ-ММ-ДД.db, хранятся последние 14.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const d = new Date();
const name = `journal-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.db`;
const target = path.join(dir, name);
fs.rmSync(target, { force: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'journal.db'));
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();
const old = fs.readdirSync(dir).filter(f => /^journal-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(14);
old.forEach(f => fs.rmSync(path.join(dir, f), { force: true }));
console.log('Копия базы сохранена:', target);
