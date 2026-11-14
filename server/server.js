'use strict';
/*
 * Журнал групп — сервер сайта.
 * Без внешних зависимостей: только встроенные модули Node.js (22.13+ / 24).
 *
 *   DATA_DIR  — где лежат база и файлы (по умолчанию ./data)
 *   PORT      — порт (по умолчанию 3000)
 *   HOST      — адрес (по умолчанию 127.0.0.1, снаружи сайт открывает Caddy)
 *
 *   node server/server.js                 — запустить сайт
 *   node server/server.js set-password    — задать пароль учителя (читает из stdin)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
fs.mkdirSync(FILES_DIR, { recursive: true });

/* ---------- настройки и пароль ---------- */
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 }); }
function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  const c = loadConfig(); c.salt = salt; c.hash = hash; saveConfig(c);
}
function checkPassword(pw) {
  const c = loadConfig();
  if (!c.hash || typeof pw !== 'string') return false;
  const h = crypto.scryptSync(pw, c.salt, 64);
  const want = Buffer.from(c.hash, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

if (process.argv[2] === 'set-password') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    const pw = input.replace(/[\r\n]+$/, '');
    if (pw.length < 6) { console.error('Пароль должен быть не короче 6 символов.'); process.exit(1); }
    setPassword(pw);
    console.log('Пароль учителя сохранён.');
    process.exit(0);
  });
  return;
}

/* ---------- база ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'journal.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY (coll, id));
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS student_links (
    student_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
`);
try { db.exec('ALTER TABLE files ADD COLUMN owner TEXT'); } catch { /* уже есть */ }
const Q = {
  list: db.prepare('SELECT id, data, updated FROM docs WHERE coll = ?'),
  get: db.prepare('SELECT data FROM docs WHERE coll = ? AND id = ?'),
  put: db.prepare('INSERT INTO docs (coll, id, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, updated = excluded.updated'),
  del: db.prepare('DELETE FROM docs WHERE coll = ? AND id = ?'),
  delColl: db.prepare('DELETE FROM docs WHERE coll = ?'),
  fileAdd: db.prepare('INSERT OR REPLACE INTO files (id, name, mime, size, created, owner) VALUES (?, ?, ?, ?, ?, ?)'),
  fileRecent: db.prepare('SELECT COUNT(*) AS n FROM files WHERE owner = ? AND created > ?'),
  fileGet: db.prepare('SELECT * FROM files WHERE id = ?'),
  fileDel: db.prepare('DELETE FROM files WHERE id = ?'),
  sesAdd: db.prepare('INSERT INTO sessions (token, created) VALUES (?, ?)'),
  sesGet: db.prepare('SELECT created FROM sessions WHERE token = ?'),
  sesDel: db.prepare('DELETE FROM sessions WHERE token = ?'),
  sesOld: db.prepare('DELETE FROM sessions WHERE created < ?'),
  linkBySid: db.prepare('SELECT token FROM student_links WHERE student_id = ?'),
  linkByTok: db.prepare('SELECT student_id FROM student_links WHERE token = ?'),
  linkAll: db.prepare('SELECT student_id, token FROM student_links'),
  linkPut: db.prepare('INSERT INTO student_links (student_id, token, created) VALUES (?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET token = excluded.token, created = excluded.created'),
};
const COLLS = new Set(['groups', 'lessons', 'submissions']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function allDocs(coll) { return Q.list.all(coll).map(r => ({ id: r.id, data: JSON.parse(r.data), updated: r.updated })); }
function getDoc(coll, id) { const r = Q.get.get(coll, id); return r ? JSON.parse(r.data) : null; }
function putDoc(coll, id, data) { Q.put.run(coll, id, JSON.stringify(data), Date.now()); }

function isPlain(o) { return o && typeof o === 'object' && !Array.isArray(o); }
function merge(target, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (isPlain(v) && isPlain(target[k])) merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

/* ---------- http-помощники ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({}, SEC_HEADERS, headers || {}));
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function redirect(res, to) { send(res, 302, '', { Location: to }); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too_large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 2 * 1024 * 1024);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad_json'), { status: 400 }); }
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https'; }
function token(n) { return crypto.randomBytes(n).toString('base64url'); }

const MIME_BY_EXT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function sendStatic(res, file, extraHeaders) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Не найдено', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, 200, buf, Object.assign({ 'Content-Type': MIME_BY_EXT[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, extraHeaders || {}));
  });
}
function page(res, name) { sendStatic(res, path.join(PUBLIC, name), { 'Cache-Control': 'no-store' }); }

/* ---------- вход учителя ---------- */
const SESSION_DAYS = 180;
function isTeacher(req) {
  const t = cookies(req).sid;
  if (!t || t.length < 20) return false;
  const r = Q.sesGet.get(t);
  return !!r && r.created > Date.now() - SESSION_DAYS * 864e5;
}
const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now(), a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60e3) { a.n = 0; a.t = now; }
  attempts.set(ip, a);
  return a.n >= 10;
}

/* ---------- файлы ---------- */
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv', 'text/markdown']);
function safeMime(m) {
  m = String(m || '').split(';')[0].trim().toLowerCase();
  if (INLINE_TYPES.has(m)) return m;
  if (/^image\/hei[cf]$/.test(m)) return m;
  return 'application/octet-stream';
}
function fileId() { return crypto.randomBytes(16).toString('hex'); }
function storeFile(buf, name, mime, id, owner) {
  id = id || fileId();
  fs.writeFileSync(path.join(FILES_DIR, id), buf);
  Q.fileAdd.run(id, String(name || 'файл').slice(0, 200), safeMime(mime), buf.length, Date.now(), owner || 'teacher');
  return { id, url: '/_blob/' + id, contentType: safeMime(mime), sizeBytes: buf.length };
}
function serveFile(req, res, id, download) {
  const f = Q.fileGet.get(id);
  if (!f) return send(res, 404, 'Файл не найден', { 'Content-Type': 'text/plain; charset=utf-8' });
  const p = path.join(FILES_DIR, id);
  fs.stat(p, (err, st) => {
    if (err) return send(res, 404, 'Файл не найден', { 'Content-Type': 'text/plain; charset=utf-8' });
    const inline = !download && INLINE_TYPES.has(f.mime);
    const headers = Object.assign({}, SEC_HEADERS, {
      'Content-Type': f.mime + (f.mime.startsWith('text/') ? '; charset=utf-8' : ''),
      'Content-Length': st.size,
      'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(f.name),
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    if (f.mime.startsWith('text/')) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(p).pipe(res);
  });
}

/* ---------- кабинет ученика ---------- */
function linkFor(sid) { const r = Q.linkBySid.get(sid); return r ? r.token : null; }
function ensureLink(sid, regen) {
  const cur = linkFor(sid);
  if (cur && !regen) return cur;
  const t = token(18);
  Q.linkPut.run(sid, t, Date.now());
  return t;
}
function metricsFor(lessons, sid) {
  let y = 0, n = 0, hs = 0, hn = 0, ok = 0, on = 0;
  for (const l of lessons) {
    const m = (l.marks || {})[sid] || {};
    if (m.att === 'y') y++; else if (m.att === 'n') n++;
    if (!l.noHw && (m.hw === 'done' || m.hw === 'part' || m.hw === 'none')) { hn++; hs += m.hw === 'done' ? 1 : m.hw === 'part' ? 0.5 : 0; }
    const cnt = parseInt(l.count, 10);
    if (!l.noHw && cnt > 0 && typeof m.ok === 'number') { ok += Math.min(m.ok, cnt + 2); on += cnt; }
  }
  return { att: (y + n) ? y / (y + n) * 100 : null, hw: hn ? hs / hn * 100 : null, ok: on ? ok / on * 100 : null };
}
function subId(lessonId, sid) { return (lessonId + '_' + sid).slice(0, 64); }
function publicSub(d) {
  if (!d) return null;
  return { files: d.files || [], comment: d.comment || '', updated: d.updated || 0, seen: !!d.seenAt && d.seenAt >= (d.updated || 0) };
}
function studentCtx(tok) {
  const row = Q.linkByTok.get(tok);
  if (!row) return null;
  const sid = row.student_id;
  const groups = allDocs('groups').filter(g => (g.data.students || []).some(s => s.id === sid));
  if (!groups.length) return null;
  return { sid, gids: new Set(groups.map(g => g.id)) };
}
const STUDENT_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;
async function studentApi(req, res, tok, action) {
  const ctx = studentCtx(tok);
  if (!ctx) return json(res, 404, { error: 'Ссылка не найдена.' });
  const { sid } = ctx;
  if (action === 'upload') {
    if (Q.fileRecent.get(sid, Date.now() - 3600e3).n >= 60) return json(res, 429, { error: 'Слишком много файлов за час. Попробуйте позже.' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!STUDENT_TYPES.test(mime)) return json(res, 400, { error: 'Можно отправлять только фото и PDF.' });
    const buf = await readBody(req, 20 * 1024 * 1024);
    if (!buf.length) return json(res, 400, { error: 'Пустой файл.' });
    let name = 'решение';
    try { name = decodeURIComponent(String(req.headers['x-filename'] || 'решение')); } catch {}
    const f = storeFile(buf, name, mime, null, sid);
    return json(res, 200, { id: f.id, url: f.url, name: name.slice(0, 200), type: f.contentType, size: f.sizeBytes });
  }
  const body = await readJson(req);
  const lessonId = String(body.lessonId || '');
  const lesson = ID_RE.test(lessonId) ? getDoc('lessons', lessonId) : null;
  if (!lesson || !ctx.gids.has(lesson.groupId)) return json(res, 404, { error: 'Занятие не найдено.' });
  const id = subId(lessonId, sid);
  const cur = getDoc('submissions', id) || { lessonId, studentId: sid, groupId: lesson.groupId, files: [], comment: '', created: Date.now() };
  if (action === 'submit') {
    const add = [];
    for (const fid of Array.isArray(body.files) ? body.files.slice(0, 30) : []) {
      const f = typeof fid === 'string' && Q.fileGet.get(fid);
      if (!f || f.owner !== sid || cur.files.some(x => x.id === fid)) continue;
      add.push({ id: f.id, name: f.name, type: f.mime, size: f.size, url: '/_blob/' + f.id });
    }
    if (!add.length && typeof body.comment !== 'string') return json(res, 400, { error: 'Нечего отправлять.' });
    cur.files = cur.files.concat(add).slice(0, 40);
    if (typeof body.comment === 'string') cur.comment = body.comment.slice(0, 2000);
    cur.updated = Date.now();
    putDoc('submissions', id, cur);
    return json(res, 200, { sub: publicSub(cur) });
  }
  if (action === 'remove') {
    const fid = String(body.fileId || '');
    const f = Q.fileGet.get(fid);
    if (!f || f.owner !== sid) return json(res, 404, { error: 'Файл не найден.' });
    cur.files = cur.files.filter(x => x.id !== fid);
    cur.updated = Date.now();
    if (cur.files.length || cur.comment) putDoc('submissions', id, cur); else Q.del.run('submissions', id);
    Q.fileDel.run(fid); fs.rm(path.join(FILES_DIR, fid), { force: true }, () => {});
    return json(res, 200, { sub: cur.files.length || cur.comment ? publicSub(cur) : null });
  }
  return json(res, 404, { error: 'Не найдено.' });
}
function studentPayload(tok) {
  const row = Q.linkByTok.get(tok);
  if (!row) return null;
  const sid = row.student_id;
  const groups = allDocs('groups').filter(g => (g.data.students || []).some(s => s.id === sid));
  if (!groups.length) return null;
  const me = groups[0].data.students.find(s => s.id === sid);
  const gids = new Set(groups.map(g => g.id));
  const raw = allDocs('lessons').map(l => Object.assign({ id: l.id }, l.data)).filter(l => gids.has(l.groupId));
  // среднее по группе: среднее из процентов всех учеников этих групп
  const mates = new Set();
  groups.forEach(g => (g.data.students || []).forEach(s => mates.add(s.id)));
  function avgOf(ls) {
    const out = {};
    ['att', 'hw', 'ok'].forEach(k => {
      const vals = [...mates].map(id => metricsFor(ls, id)[k]).filter(v => v != null);
      out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    });
    return out;
  }
  const avg = avgOf(raw);
  // среднее по группе за каждый месяц, чтобы ученик мог смотреть статистику по месяцам
  const avgByMonth = {};
  [...new Set(raw.map(l => String(l.date || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))]
    .forEach(m => { avgByMonth[m] = avgOf(raw.filter(l => String(l.date).slice(0, 7) === m)); });
  const lessons = raw.map(l => ({
    id: l.id, groupId: l.groupId, date: l.date, topic: l.topic || '',
    noHw: !!l.noHw, hw: l.noHw ? '' : (l.hw || ''), count: parseInt(l.count, 10) || null,
    video: l.video || '', files: l.noHw ? [] : (l.files || []), board: l.board || [],
    mark: (l.marks || {})[sid] || {},
    sub: publicSub(getDoc('submissions', subId(l.id, sid))),
  }));
  return {
    student: { id: sid, name: me.name },
    groups: groups.map(g => ({ id: g.id, name: g.data.name })),
    lessons, groupAvg: avg, groupAvgByMonth: avgByMonth,
  };
}

/* ---------- импорт архива из журнала на Claude ---------- */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('Это не zip-архив.'), { status: 400 });
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('Архив повреждён.'), { status: 400 });
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const loff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(loff + 26), lxlen = buf.readUInt16LE(loff + 28);
    const start = loff + 30 + lnlen + lxlen;
    entries.set(name, { method, start, csize });
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name); if (!e) return null;
      const data = buf.subarray(e.start, e.start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw Object.assign(new Error('Неподдерживаемое сжатие в архиве.'), { status: 400 });
    },
  };
}
function importArchive(buf) {
  const z = readZip(buf);
  const dataBuf = z.read('data.json');
  if (!dataBuf) throw Object.assign(new Error('В архиве нет data.json.'), { status: 400 });
  const data = JSON.parse(dataBuf.toString('utf8'));
  const meta = data.files || {};
  let nf = 0;
  for (const id of Object.keys(meta)) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) continue;
    const b = z.read('files/' + id);
    if (!b) continue;
    storeFile(b, meta[id].name, meta[id].type, id); nf++;
  }
  db.exec('BEGIN');
  try {
    for (const coll of ['groups', 'lessons']) {
      Q.delColl.run(coll);
      for (const d of data[coll] || []) if (ID_RE.test(d.id)) putDoc(coll, d.id, d.data);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { groups: (data.groups || []).length, lessons: (data.lessons || []).length, files: nf };
}

/* ---------- маршруты ---------- */
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;

  if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  if (p.startsWith('/static/') && (m === 'GET' || m === 'HEAD')) {
    const f = path.normalize(path.join(PUBLIC, p));
    if (!f.startsWith(path.join(PUBLIC, 'static'))) return send(res, 404, '');
    return sendStatic(res, f);
  }
  if (p === '/' && m === 'GET') return redirect(res, isTeacher(req) ? '/t/' : '/login');
  if (p === '/login' && m === 'GET') return isTeacher(req) ? redirect(res, '/t/') : page(res, 'login.html');
  if (p === '/login' && m === 'POST') {
    if (tooManyAttempts(ip)) return json(res, 429, { error: 'Слишком много попыток. Подождите 15 минут.' });
    const body = await readJson(req);
    if (!checkPassword(body.password)) {
      attempts.get(ip).n++;
      return json(res, 401, { error: 'Неверный пароль.' });
    }
    const t = token(32);
    Q.sesAdd.run(t, Date.now());
    Q.sesOld.run(Date.now() - SESSION_DAYS * 864e5);
    res.setHeader('Set-Cookie', `sid=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }
  if (p === '/logout' && m === 'POST') {
    const t = cookies(req).sid; if (t) Q.sesDel.run(t);
    res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if ((p === '/t' || p === '/t/') && m === 'GET') return isTeacher(req) ? page(res, 'teacher.html') : redirect(res, '/login');

  let mm;
  if ((mm = /^\/s\/([A-Za-z0-9_-]{10,64})\/?$/.exec(p)) && m === 'GET') {
    return Q.linkByTok.get(mm[1]) ? page(res, 'student.html') : page(res, 'notfound.html');
  }
  if ((mm = /^\/_blob\/([A-Za-z0-9_-]{6,64})$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
    return serveFile(req, res, mm[1], url.searchParams.has('download'));
  }
  if ((mm = /^\/api\/s\/([A-Za-z0-9_-]{10,64})\/(upload|submit|remove)$/.exec(p)) && m === 'POST') {
    return studentApi(req, res, mm[1], mm[2]);
  }
  if ((mm = /^\/api\/s\/([A-Za-z0-9_-]{10,64})$/.exec(p)) && m === 'GET') {
    const data = studentPayload(mm[1]);
    return data ? json(res, 200, data) : json(res, 404, { error: 'Ссылка не найдена.' });
  }

  /* --- дальше только для учителя --- */
  if (p.startsWith('/api/')) {
    if (!isTeacher(req)) return json(res, 401, { error: 'Нужно войти.' });
    if (m !== 'GET' && !String(req.headers['x-journal'] || '')) return json(res, 403, { error: 'Запрос отклонён.' });

    if ((mm = /^\/api\/docs\/([a-z]+)$/.exec(p)) && m === 'GET') {
      if (!COLLS.has(mm[1])) return json(res, 404, { error: 'Нет такой коллекции.' });
      return json(res, 200, { docs: allDocs(mm[1]) });
    }
    if ((mm = /^\/api\/docs\/([a-z]+)\/([A-Za-z0-9_-]{1,64})$/.exec(p))) {
      const [, coll, id] = mm;
      if (!COLLS.has(coll)) return json(res, 404, { error: 'Нет такой коллекции.' });
      if (m === 'PUT') {
        const body = await readJson(req);
        if (!isPlain(body)) return json(res, 400, { error: 'Нужен объект.' });
        putDoc(coll, id, body); return json(res, 200, { ok: true });
      }
      if (m === 'PATCH') {
        const body = await readJson(req);
        const cur = getDoc(coll, id);
        if (!cur) return json(res, 404, { error: 'Документ не найден.' });
        putDoc(coll, id, merge(cur, body)); return json(res, 200, { ok: true });
      }
      if (m === 'DELETE') { Q.del.run(coll, id); return json(res, 200, { ok: true }); }
    }
    if (p === '/api/files' && m === 'POST') {
      const buf = await readBody(req, 25 * 1024 * 1024);
      if (!buf.length) return json(res, 400, { error: 'Пустой файл.' });
      let name = 'файл';
      try { name = decodeURIComponent(String(req.headers['x-filename'] || 'файл')); } catch {}
      return json(res, 200, storeFile(buf, name, req.headers['content-type']));
    }
    if ((mm = /^\/api\/files\/([A-Za-z0-9_-]{6,64})$/.exec(p)) && m === 'DELETE') {
      Q.fileDel.run(mm[1]);
      fs.rm(path.join(FILES_DIR, mm[1]), { force: true }, () => {});
      return json(res, 200, { ok: true });
    }
    if (p === '/api/links' && m === 'GET') {
      const out = {}; Q.linkAll.all().forEach(r => { out[r.student_id] = r.token; });
      return json(res, 200, { links: out });
    }
    if ((mm = /^\/api\/links\/([A-Za-z0-9_-]{1,64})$/.exec(p)) && m === 'POST') {
      return json(res, 200, { token: ensureLink(mm[1], url.searchParams.has('new')) });
    }
    if (p === '/api/import' && m === 'POST') {
      const buf = await readBody(req, 1024 * 1024 * 1024);
      return json(res, 200, importArchive(buf));
    }
    return json(res, 404, { error: 'Не найдено.' });
  }
  return page(res, 'notfound.html');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, req.url, err);
    if (!res.headersSent) json(res, status, { error: status === 413 ? 'Файл слишком большой.' : (err.status ? err.message : 'Ошибка на сервере.') });
    else res.end();
  });
});
server.requestTimeout = 15 * 60e3;
server.listen(PORT, HOST, () => console.log(`Журнал запущен: http://${HOST}:${PORT}  (данные: ${DATA_DIR})`));
