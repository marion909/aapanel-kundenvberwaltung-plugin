'use strict';
// Logo + Portal-Name aus der Kundenverwaltung im Portal
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-branding-test-'));
process.env.CM_DATA_DIR = tmpDir;
process.env.PORTAL_DEBUG = '1';

const store = require('../lib/store');
const app = require('../server');

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ohne Logo: Standardname, /branding/logo liefert 404', async () => {
  const html = await (await fetch(baseUrl + '/login')).text();
  assert.match(html, /<h1>KundenPortal<\/h1>/);
  assert.doesNotMatch(html, /login-logo/);
  assert.equal((await fetch(baseUrl + '/branding/logo')).status, 404);
});

test('mit Logo und eigenem Namen: Login zeigt beides, Logo wird mit strikter CSP ausgeliefert', async () => {
  const cfg = store.loadCfg();
  cfg.portal_name = 'Neuhauser <Cloud>';
  store.saveCfg(cfg);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  fs.writeFileSync(path.join(tmpDir, 'logo.svg'), svg);

  const html = await (await fetch(baseUrl + '/login')).text();
  assert.match(html, /<div class="login-logo"><img src="\/branding\/logo\?v=\d+"/);
  assert.match(html, /Neuhauser &lt;Cloud&gt;/); // Name wird escaped
  assert.match(html, /<title>Anmelden – Neuhauser &lt;Cloud&gt;<\/title>/);

  const res = await fetch(baseUrl + '/branding/logo');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await res.text(), svg);
});
