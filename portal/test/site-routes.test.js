'use strict';
// HTTP-Tests für Website-Seiten und Dateimanager. Die aaPanel-API wird über
// Stubs am SiteService ersetzt; Dateioperationen laufen gegen ein Temp-Verzeichnis.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-site-routes-'));
process.env.CM_DATA_DIR = tmpDir;
process.env.PORTAL_DEBUG = '1';

const { Store, hashPassword } = require('../lib/store');
const { SiteService } = require('../lib/sites');
const app = require('../server');

const siteRoot = path.join(tmpDir, 'www', 'kunde.at');
fs.mkdirSync(siteRoot, { recursive: true });
fs.writeFileSync(path.join(siteRoot, 'index.html'), 'Hallo');
fs.writeFileSync(path.join(tmpDir, 'secret.txt'), 'geheim');

let server;
let baseUrl;
let ownSiteId;
let foreignSiteId;

SiteService.prototype.resolve = async function (row) {
  return { id: Number(row.ref_id), name: row.ref_name, path: siteRoot, status: '1' };
};
SiteService.prototype.phpVersions = async () => [{ version: '83', name: 'PHP-83' }];

test.before(async () => {
  const store = new Store();
  const now = Math.floor(Date.now() / 1000);
  const mk = (no, pw) => {
    const id = store.db
      .prepare('INSERT INTO customers (customer_no, company, status, portal_enabled, portal_password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(no, 'Firma ' + no, 'active', pw ? 1 : 0, pw ? hashPassword(pw) : '', now, now).lastInsertRowid;
    return id;
  };
  const cid = mk('K-20001', 'sicheresPasswort123');
  const other = mk('K-20002', null);
  store.assign(cid, [{ type: 'site', ref_name: 'kunde.at', ref_id: '7' }, { type: 'domain', ref_name: 'kunde.at' }]);
  store.assign(other, [{ type: 'site', ref_name: 'fremd.at', ref_id: '8' }]);
  ownSiteId = store.siteAssignmentByName(cid, 'kunde.at').id;
  foreignSiteId = store.siteAssignmentByName(other, 'fremd.at').id;
  store.close();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

class Session {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  async req(p, opts) {
    const o = Object.assign({ redirect: 'manual' }, opts || {});
    o.headers = Object.assign({ Cookie: this.header() }, o.headers || {});
    const res = await fetch(baseUrl + p, o);
    this.absorb(res);
    return res;
  }
  async post(p, body) {
    return this.req(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  }
  async login() {
    const html = await (await this.req('/login')).text();
    this.csrf = html.match(/name="csrf_token" value="([^"]+)"/)[1];
    const res = await this.post('/login', { login: 'K-20001', password: 'sicheresPasswort123', csrf_token: this.csrf });
    assert.equal(res.status, 302);
    return this;
  }
  flash() { return this.req('/sites').then((r) => r.text()); }
}

test('Website-Liste zeigt eigene Website und Formular zum Anlegen', async () => {
  const s = await new Session().login();
  const html = await (await s.req('/sites')).text();
  assert.match(html, /kunde\.at/);
  assert.doesNotMatch(html, /fremd\.at/);
  assert.match(html, /action="\/sites\/new"/);
});

test('Dateimanager listet Dateien der eigenen Website', async () => {
  const s = await new Session().login();
  const res = await s.req(`/sites/${ownSiteId}/files`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /index\.html/);
});

test('Fremde Website: Dateimanager, Upload und Download liefern 404', async () => {
  const s = await new Session().login();
  assert.equal((await s.req(`/sites/${foreignSiteId}/files`)).status, 404);
  assert.equal((await s.req(`/sites/${foreignSiteId}/files/download?path=/index.html`)).status, 404);
  const up = await s.req(`/sites/${foreignSiteId}/files/upload?dir=/&name=x.txt&offset=0&total=1`, {
    method: 'POST', headers: { 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/octet-stream' }, body: 'x',
  });
  assert.equal(up.status, 404);
});

test('Upload in Stücken mit CSRF-Header; ohne Token abgelehnt', async () => {
  const s = await new Session().login();
  const noCsrf = await s.req(`/sites/${ownSiteId}/files/upload?dir=/&name=a.txt&offset=0&total=4`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'test',
  });
  assert.equal(noCsrf.status, 400);
  const send = (offset, body, extra) => s.req(`/sites/${ownSiteId}/files/upload?dir=/&name=a.txt&offset=${offset}&total=8${extra || ''}`, {
    method: 'POST', headers: { 'X-CSRF-Token': s.csrf, 'Content-Type': 'application/octet-stream' }, body,
  });
  let r = await (await send(0, 'test')).json();
  assert.deepEqual(r, { ok: true, done: false, received: 4 });
  r = await (await send(4, 'ende')).json();
  assert.equal(r.done, true);
  assert.equal(fs.readFileSync(path.join(siteRoot, 'a.txt'), 'utf8'), 'testende');
  const again = await send(0, 'neu!');
  assert.equal(again.status, 409);
  assert.equal((await again.json()).exists, true);
});

test('Download liefert Datei, Pfad-Ausbruch wird abgewiesen', async () => {
  const s = await new Session().login();
  const res = await s.req(`/sites/${ownSiteId}/files/download?path=/index.html`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'Hallo');
  const bad = await s.req(`/sites/${ownSiteId}/files/download?path=${encodeURIComponent('/../../secret.txt')}`);
  assert.equal(bad.status, 302);
});

test('Datei-Aktionen per Formular: Ordner anlegen, bearbeiten, löschen', async () => {
  const s = await new Session().login();
  let res = await s.post(`/sites/${ownSiteId}/files/op`, { csrf_token: s.csrf, dir: '/', op: 'mkdir', arg: 'assets' });
  assert.equal(res.status, 302);
  assert.ok(fs.statSync(path.join(siteRoot, 'assets')).isDirectory());
  res = await s.post(`/sites/${ownSiteId}/files/save`, { csrf_token: s.csrf, path: '/index.html', content: 'Neu\r\nZeile', eol: 'lf', encoding: 'utf8' });
  assert.equal(res.status, 302);
  assert.equal(fs.readFileSync(path.join(siteRoot, 'index.html'), 'utf8'), 'Neu\nZeile');
  const edit = await s.req(`/sites/${ownSiteId}/files/edit?path=/index.html`);
  assert.match(await edit.text(), /Neu\nZeile/);
  res = await s.post(`/sites/${ownSiteId}/files/op`, { csrf_token: s.csrf, dir: '/', op: 'delete', paths: '/assets' });
  assert.equal(res.status, 302);
  assert.ok(!fs.existsSync(path.join(siteRoot, 'assets')));
  // Ausbruchsversuch über Löschen
  await s.post(`/sites/${ownSiteId}/files/op`, { csrf_token: s.csrf, dir: '/', op: 'delete', paths: '/../../secret.txt' });
  assert.ok(fs.existsSync(path.join(tmpDir, 'secret.txt')));
});

test('Website löschen verlangt exakten Namen zur Bestätigung', async () => {
  const s = await new Session().login();
  let deleted = false;
  const orig = SiteService.prototype.remove;
  SiteService.prototype.remove = async () => { deleted = true; };
  try {
    const res = await s.post(`/sites/${ownSiteId}/delete`, { csrf_token: s.csrf, confirm: 'falsch.at' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /\/delete$/);
    assert.equal(deleted, false);
  } finally {
    SiteService.prototype.remove = orig;
  }
});

test('Alle Tabs der Website-Seite rendern', async () => {
  const P = SiteService.prototype;
  const saved = {};
  const stubs = {
    overview: async () => ({ php_version: '83', php_versions: [{ version: '83', name: 'PHP-83' }], index: 'index.php', run_path: '/', run_dirs: ['/', '/public'], webserver: 'nginx' }),
    siteDomains: async () => [{ id: 1, name: 'kunde.at', port: 80 }, { id: 2, name: 'www.kunde.at', port: 80 }],
    sslInfo: async () => ({ enabled: true, force_https: false, issuer: "Let's Encrypt", not_after: '2026-12-01', days_left: 60, dns: ['kunde.at'] }),
    redirects: async () => [{ name: '1', path: '/alt', to: 'https://kunde.at/neu', code: '301', holdpath: false, kind: 'path', active: true }],
    rewriteGet: () => ({ templates: ['wordpress'], current: 'location / {}', supported: true }),
    logs: async () => '1.2.3.4 - - "GET / HTTP/2.0" 200',
  };
  for (const k of Object.keys(stubs)) { saved[k] = P[k]; P[k] = stubs[k]; }
  try {
    const s = await new Session().login();
    const expect = { overview: /PHP-83/, domains: /www\.kunde\.at/, ssl: /Let&#39;s Encrypt/, redirects: /\/alt/, rewrite: /wordpress/, logs: /GET \//, delete: /Endgültig löschen/ };
    for (const [tab, re] of Object.entries(expect)) {
      const res = await s.req(`/sites/${ownSiteId}/${tab}`);
      assert.equal(res.status, 200, tab);
      assert.match(await res.text(), re, tab);
    }
  } finally {
    for (const k of Object.keys(saved)) P[k] = saved[k];
  }
});
