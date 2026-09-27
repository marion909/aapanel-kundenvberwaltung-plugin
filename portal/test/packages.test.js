'use strict';
// Hosting-Pakete: Limit-Berechnung (muss zu cm_store.effective_limits passen)
// und Durchsetzung im Portal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-packages-test-'));
process.env.CM_DATA_DIR = tmpDir;
process.env.PORTAL_DEBUG = '1';

const { Store, hashPassword } = require('../lib/store');
const { effectiveLimits } = require('../lib/packages');
const { SiteService } = require('../lib/sites');
const app = require('../server');

let server;
let baseUrl;

function mkPackage(store, fields) {
  const f = Object.assign({ name: 'P' + Math.random(), max_sites: 0, max_domains: 0, max_mail_domains: 0,
    max_mailboxes: 0, mailbox_quota_mb: 0, max_upload_mb: 0, ssl_allowed: 1 }, fields);
  return store.db.prepare(`INSERT INTO packages (name, max_sites, max_domains, max_mail_domains, max_mailboxes,
    mailbox_quota_mb, max_upload_mb, ssl_allowed) VALUES (?,?,?,?,?,?,?,?)`)
    .run(f.name, f.max_sites, f.max_domains, f.max_mail_domains, f.max_mailboxes, f.mailbox_quota_mb, f.max_upload_mb, f.ssl_allowed)
    .lastInsertRowid;
}

function mkCustomer(store, no, packageId, password) {
  const now = Math.floor(Date.now() / 1000);
  return store.db.prepare(`INSERT INTO customers (customer_no, company, status, package_id, portal_enabled, portal_password_hash, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(no, 'Firma ' + no, 'active', packageId || null, password ? 1 : 0, password ? hashPassword(password) : '', now, now).lastInsertRowid;
}

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('effectiveLimits: Reihenfolge Kunde > Paket > Standard', () => {
  const cfg = { site_default_max_sites: 3, portal_max_upload_mb: 256 };
  const pkg = { max_sites: 5, max_domains: 2, max_mail_domains: 1, max_mailboxes: 10, mailbox_quota_mb: 2048, max_upload_mb: 0, ssl_allowed: 0 };
  assert.equal(effectiveLimits({ max_sites: -1 }, null, cfg).site, 3);
  const l = effectiveLimits({ max_sites: -1 }, pkg, cfg);
  assert.deepEqual([l.site, l.domain, l.mailbox, l.mailbox_quota_mb, l.upload_mb, l.ssl], [5, 2, 10, 2048, 256, false]);
  assert.equal(effectiveLimits({ max_sites: 0 }, pkg, cfg).site, 0);
  assert.equal(effectiveLimits({ max_sites: 8 }, pkg, cfg).site, 8);
  assert.equal(effectiveLimits({ max_sites: -1 }, null, cfg).ssl, true);
});

test('Website-Limit und SSL-Sperre aus dem Paket', async () => {
  const store = new Store();
  const pid = mkPackage(store, { max_sites: 1, ssl_allowed: 0 });
  const cid = mkCustomer(store, 'K-30001', pid);
  store.assign(cid, [{ type: 'domain', ref_name: 'paket.at' }, { type: 'site', ref_name: 'paket.at', ref_id: '1' }]);
  const customer = store.db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
  const calls = [];
  const api = { async raw(p) { calls.push(p); return { status: 0, timestamp: 1, message: [] }; } };
  const svc = new SiteService({ cfg: {}, store, customer, api });
  assert.deepEqual(svc.quota(), { sites: 1, max: 1 });
  await assert.rejects(svc.create({ domain: 'paket.at', subdomain: 'neu' }), /Limit erreicht/);
  await assert.rejects(svc.sslLetsEncrypt({ id: 1, name: 'paket.at' }), /Administrator/);
  await assert.rejects(svc.sslDisable({ id: 1, name: 'paket.at' }), /Administrator/);
  assert.equal(calls.length, 0, 'keine API-Aufrufe bei gesperrten Aktionen');
  store.close();
});

test('Portal: Postfach-Limit blockiert Anlegen, Übersicht zeigt Paket', async () => {
  const store = new Store();
  const pid = mkPackage(store, { name: 'Starter', max_mailboxes: 1 });
  const cid = mkCustomer(store, 'K-30002', pid, 'sicheresPasswort123');
  store.assign(cid, [{ type: 'mail_domain', ref_name: 'post.at' }, { type: 'mailbox', ref_name: 'a@post.at' }]);
  store.close();

  const cookies = new Map();
  const req = async (p, opts) => {
    const o = Object.assign({ redirect: 'manual' }, opts || {});
    o.headers = Object.assign({ Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, o.headers || {});
    const res = await fetch(baseUrl + p, o);
    for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  const form = (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const csrf = (await (await req('/login')).text()).match(/name="csrf_token" value="([^"]+)"/)[1];
  assert.equal((await form('/login', { login: 'K-30002', password: 'sicheresPasswort123', csrf_token: csrf })).status, 302);

  const dash = await (await req('/')).text();
  assert.match(dash, /Paket <strong>Starter<\/strong>/);

  const mail = await (await req('/mail')).text();
  assert.match(mail, /Postfach-Limit Ihres Pakets erreicht/);
  const res = await form('/mail/boxes', { csrf_token: csrf, domain: 'post.at', local: 'b', password: 'einPasswort123' });
  assert.equal(res.status, 302);
  const after = await (await req('/mail')).text();
  assert.match(after, /Postfach-Limit Ihres Pakets erreicht \(1 von 1\)/);
  const s2 = new Store();
  assert.equal(s2.isAssigned(cid, 'mailbox', 'b@post.at'), false);
  s2.close();
});
