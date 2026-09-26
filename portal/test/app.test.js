'use strict';
// Express-App-Tests über echtes HTTP (Node-eigenes fetch, kein extra Paket).
// Node's fetch hat keinen eingebauten Cookie-Jar wie ein Browser - die kleine
// Session-Helferklasse unten übernimmt das manuell (Set-Cookie einsammeln,
// bei Folge-Requests als Cookie-Header mitschicken).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-portal-app-test-'));
process.env.CM_DATA_DIR = tmpDir;
process.env.PORTAL_DEBUG = '1';

const { Store, hashPassword } = require('../lib/store');
const app = require('../server');

let server;
let baseUrl;

function newCustomer(customerNo, password, company) {
  const store = new Store();
  const now = Math.floor(Date.now() / 1000);
  const info = store.db
    .prepare('INSERT INTO customers (customer_no, company, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(customerNo, company || 'Test GmbH', 'active', now, now);
  const cid = info.lastInsertRowid;
  if (password) {
    store.db
      .prepare('UPDATE customers SET portal_enabled=1, portal_password_hash=? WHERE id=?')
      .run(hashPassword(password), cid);
  }
  return { store, cid };
}

test.before(async () => {
  const { store, cid } = newCustomer('K-00001', 'sicheresPasswort123', 'Testkunde');
  store.assign(cid, [{ type: 'site', ref_name: 'example.com', ref_id: '7' }]);
  store.close();

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function getSetCookie(res) {
  return typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
}

function extractCsrf(html) {
  const m = html.match(/name="csrf_token" value="([^"]+)"/);
  return m ? m[1] : null;
}

class Session {
  constructor() {
    this.cookies = new Map();
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res) {
    for (const c of getSetCookie(res)) {
      const kv = c.split(';')[0];
      const idx = kv.indexOf('=');
      this.cookies.set(kv.slice(0, idx), kv.slice(idx + 1));
    }
  }
  async get(p) {
    const res = await fetch(baseUrl + p, { headers: { Cookie: this.header() }, redirect: 'manual' });
    this.absorb(res);
    return res;
  }
  async post(p, body) {
    const res = await fetch(baseUrl + p, {
      method: 'POST',
      headers: { Cookie: this.header(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    });
    this.absorb(res);
    return res;
  }
  async loginCsrf() {
    const res = await this.get('/login');
    return extractCsrf(await res.text());
  }
}

test('Login-Seite lädt', async () => {
  const res = await new Session().get('/login');
  assert.equal(res.status, 200);
});

test('Dashboard ohne Login leitet auf /login um', async () => {
  const res = await new Session().get('/');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/login/);
});

test('POST ohne CSRF-Token wird mit 400 abgelehnt', async () => {
  const s = new Session();
  await s.get('/login');
  const res = await s.post('/login', { login: 'K-00001', password: 'sicheresPasswort123' });
  assert.equal(res.status, 400);
});

test('Login mit falschem Passwort schlägt mit 401 fehl', async () => {
  const s = new Session();
  const csrf = await s.loginCsrf();
  const res = await s.post('/login', { login: 'K-00001', password: 'falsch', csrf_token: csrf });
  assert.equal(res.status, 401);
});

test('Login mit korrektem Passwort, Dashboard zeigt Kundennamen', async () => {
  const s = new Session();
  const csrf = await s.loginCsrf();
  const loginRes = await s.post('/login', { login: 'K-00001', password: 'sicheresPasswort123', csrf_token: csrf });
  assert.equal(loginRes.status, 302);
  const dash = await s.get('/');
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), /Testkunde/);
});

test('Login wird nach 5 Fehlversuchen für 6. Versuch gedrosselt (429)', async () => {
  // eigener Kunde, damit der Drossel-Zähler nicht von anderen Tests beeinflusst wird
  const { store } = newCustomer('K-55501', 'einAnderesPasswort1', 'Drossel-Test');
  store.close();
  const s = new Session();
  for (let i = 0; i < 5; i++) {
    const csrf = await s.loginCsrf();
    await s.post('/login', { login: 'K-55501', password: 'falsch', csrf_token: csrf });
  }
  const csrf = await s.loginCsrf();
  const res = await s.post('/login', { login: 'K-55501', password: 'einAnderesPasswort1', csrf_token: csrf });
  assert.equal(res.status, 429);
});

test('Ownership-Check blockiert Zugriff auf fremde Zuordnung (404)', async () => {
  const { store, cid } = newCustomer('K-00002', null, 'Anderer Kunde');
  store.assign(cid, [{ type: 'site', ref_name: 'other.com', ref_id: '9' }]);
  const otherAssignmentId = store.assignments(cid)[0].id;
  store.close();

  const s = new Session();
  const csrf1 = await s.loginCsrf();
  await s.post('/login', { login: 'K-00001', password: 'sicheresPasswort123', csrf_token: csrf1 });
  const sitesHtml = await (await s.get('/sites')).text();
  const csrf2 = extractCsrf(sitesHtml);
  const res = await s.post(`/sites/${otherAssignmentId}/stop`, { csrf_token: csrf2 });
  assert.equal(res.status, 404);
});

test('Deaktivierter Portal-Zugang greift sofort, auch mit gültiger Session', async () => {
  const { store, cid } = newCustomer('K-00003', 'nochEinPasswort1', 'Wird deaktiviert');
  store.close();
  const s = new Session();
  const csrf = await s.loginCsrf();
  await s.post('/login', { login: 'K-00003', password: 'nochEinPasswort1', csrf_token: csrf });
  assert.equal((await s.get('/')).status, 200);

  const s2 = new Store();
  s2.db.prepare('UPDATE customers SET portal_enabled=0 WHERE id=?').run(cid);
  s2.close();

  const res = await s.get('/');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/login/);
});
