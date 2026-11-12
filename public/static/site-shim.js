/*
 * Прослойка для журнала учителя: даёт странице тот же интерфейс claude.use(...),
 * что был на Claude, но данные хранятся на нашем сервере (REST API).
 */
(function () {
  'use strict';
  var HDR = { 'X-Journal': '1' };

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }

  function api(method, url, body, headers) {
    var opts = { method: method, credentials: 'same-origin', headers: Object.assign({}, HDR, headers || {}) };
    if (body !== undefined) {
      if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
      else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    }
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) { location.href = '/login'; throw err('revoked', 'Нужно войти заново.'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw err(r.status === 413 ? 'quota_exceeded' : 'unavailable', j.error || ('Ошибка ' + r.status));
        return j;
      });
    }, function () { throw err('unavailable', 'Нет связи с сайтом.'); });
  }

  /* ---- база ---- */
  var listeners = {};   // коллекция -> [{next, error}]
  var pending = 0;
  function rid() {
    var a = new Uint8Array(15); crypto.getRandomValues(a);
    return Array.from(a, function (b) { return 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]; }).join('').slice(0, 20);
  }
  function snapOf(docs) {
    var list = docs.map(function (d) {
      var data = d.data;
      return { id: d.id, exists: true, data: function () { return data; }, metadata: { fromCache: false, hasPendingWrites: false } };
    });
    return { docs: list, size: list.length, empty: !list.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function refresh(coll, force) {
    var ls = listeners[coll]; if (!ls || !ls.length) return;
    if (pending && !force) return;
    api('GET', '/api/docs/' + coll).then(function (j) {
      if (pending && !force) return;
      var s = snapOf(j.docs || []);
      ls.forEach(function (l) { try { l.next(s); } catch (e) { console.error(e); } });
    }, function (e) {
      ls.forEach(function (l) { if (!l.ready && l.error) l.error(e); });
    });
  }
  function refreshAll() { Object.keys(listeners).forEach(function (c) { refresh(c); }); }
  setInterval(refreshAll, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshAll(); });

  function write(method, coll, id, data) {
    pending++;
    return api(method, '/api/docs/' + coll + '/' + id, data).then(function () { return undefined; }).finally(function () {
      pending--;
      if (!pending) setTimeout(function () { refresh(coll); }, 250);
    });
  }
  function docRef(coll, id) {
    return {
      id: id, path: coll + '/' + id,
      set: function (d) { return write('PUT', coll, id, d); },
      update: function (d) { return write('PATCH', coll, id, d); },
      delete: function () { return write('DELETE', coll, id); },
      get: function () {
        return api('GET', '/api/docs/' + coll).then(function (j) {
          var f = (j.docs || []).filter(function (d) { return d.id === id; })[0];
          return { id: id, exists: !!f, data: function () { return f ? f.data : undefined; }, metadata: { fromCache: false, hasPendingWrites: false } };
        });
      },
    };
  }
  var db = {
    collection: function (coll) {
      return {
        path: coll,
        doc: function (id) { return docRef(coll, id || rid()); },
        add: function (d) { var r = docRef(coll, rid()); return r.set(d).then(function () { return r; }); },
        onSnapshot: function (next, error) {
          var l = { next: function (s) { l.ready = true; next(s); }, error: error };
          (listeners[coll] = listeners[coll] || []).push(l);
          refresh(coll, true);
          return function () { listeners[coll] = (listeners[coll] || []).filter(function (x) { return x !== l; }); };
        },
      };
    },
    doc: function (p) { var a = String(p).split('/'); return docRef(a[0], a[1]); },
  };

  /* ---- файлы ---- */
  var assets = {
    upload: function (blob) {
      var name = blob.name || 'файл';
      return api('POST', '/api/files', blob, { 'X-Filename': encodeURIComponent(name), 'Content-Type': blob.type || 'application/octet-stream' });
    },
    delete: function (id) { return api('DELETE', '/api/files/' + encodeURIComponent(id)); },
  };

  /* ---- скачивание ---- */
  var downloads = {
    save: function (o) {
      return new Promise(function (resolve) {
        var blob = o.data instanceof Blob ? o.data : new Blob([o.data]);
        var url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = o.filename || 'file'; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        resolve({ status: 'saved' });
      });
    },
  };

  var user = {
    canEdit: function () { return true; }, isOwner: function () { return true; },
    can: function () { return true; }, id: function () { return Promise.resolve('teacher'); },
  };

  var caps = { db: db, assets: assets, downloads: downloads, user: user };
  window.claude = { use: function (n) { return Promise.resolve(caps[n] || null); } };
  window.SITE = { api: api };
})();
