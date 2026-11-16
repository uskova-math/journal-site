'use strict';
// Web Push без сторонних библиотек: VAPID (ES256) + шифрование aes128gcm (RFC 8291).
// Подписки и ключи лежат в DATA_DIR/push.json, на GitHub не попадают.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let FILE = null, state = null;

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64u(s) { return Buffer.from(String(s || ''), 'base64url'); }

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { state = {}; }
  if (!state.vapid) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    state.vapid = { pub: b64u(ecdh.getPublicKey()), priv: b64u(ecdh.getPrivateKey()) };
  }
  state.subs = Array.isArray(state.subs) ? state.subs : [];
  save();
  return state;
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function init(dataDir) { FILE = path.join(dataDir, 'push.json'); load(); }

function privateKeyObject() {
  const { pub, priv } = load().vapid;
  const p = fromB64u(pub);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: priv, x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) }, format: 'jwk' });
}

function vapidHeader(endpoint, contact) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privateKeyObject(), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${load().vapid.pub}`;
}

function encrypt(sub, payload) {
  const uaPublic = fromB64u(sub.keys.p256dh), authSecret = fromB64u(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

async function sendOne(sub, msg) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidHeader(sub.endpoint, sub.contact || 'mailto:noreply@example.com'),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal',
    },
    body: encrypt(sub, JSON.stringify(msg)),
    signal: AbortSignal.timeout(15000),
  });
  return res.status;
}

// msg: { title, body, url, tag }
async function notify(msg) {
  const subs = load().subs.slice();
  if (!subs.length) return { sent: 0, total: 0 };
  let sent = 0, dead = [];
  await Promise.all(subs.map(async s => {
    try {
      const st = await sendOne(s, msg);
      if (st >= 200 && st < 300) sent++;
      else if (st === 404 || st === 410) dead.push(s.endpoint);
      else console.error(new Date().toISOString(), 'push', st, new URL(s.endpoint).host);
    } catch (e) { console.error(new Date().toISOString(), 'push error', new URL(s.endpoint).host, e.message); }
  }));
  if (dead.length) { state.subs = state.subs.filter(s => !dead.includes(s.endpoint)); save(); }
  return { sent, total: subs.length };
}
function notifySoon(msg) { notify(msg).catch(e => console.error('push', e.message)); }

function subscribe(sub, contact, device) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
    throw Object.assign(new Error('Неверная подписка.'), { status: 400 });
  const st = load();
  st.subs = st.subs.filter(s => s.endpoint !== sub.endpoint);
  st.subs.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, contact, device: String(device || '').slice(0, 120), at: Date.now() });
  if (st.subs.length > 20) st.subs = st.subs.slice(-20);
  save();
  return st.subs.length;
}
function unsubscribe(endpoint) {
  const st = load();
  st.subs = st.subs.filter(s => s.endpoint !== endpoint);
  save();
}
function publicKey() { return load().vapid.pub; }
function count() { return load().subs.length; }
function has(endpoint) { return load().subs.some(s => s.endpoint === endpoint); }

module.exports = { init, notify, notifySoon, subscribe, unsubscribe, publicKey, count, has, _encrypt: encrypt };
