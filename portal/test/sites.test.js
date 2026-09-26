'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sites-test-'));
process.env.CM_DATA_DIR = tmpDir;

const { Store } = require('../lib/store');
const { ApiError } = require('../lib/api');
const { SiteService, unwrapResult, sitePathFor, workingPrefix } = require('../lib/sites');
const { ValidationError, normalizeHostname, normalizeSubdomain, domainOwner } = require('../lib/validate');

// Stub der aaPanel-API: protokolliert Aufrufe, antwortet im v2-Format
function stubApi(handlers) {
  const calls = [];
  return {
    calls,
    async raw(p, params) {
      calls.push({ path: p, params });
      const action = p.split('action=')[1];
      const h = handlers[action];
      if (!h) return { status: 0, timestamp: 1, message: {} };
      return { status: 0, timestamp: 1, message: h(params, p) };
    },
  };
}

function customer(store, no, maxSites) {
  const now = Math.floor(Date.now() / 1000);
  const info = store.db
    .prepare('INSERT INTO customers (customer_no, company, status, max_sites, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(no, 'Test', 'active', maxSites === undefined ? -1 : maxSites, now, now);
  return store.db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid);
}

const baseCfg = { site_api_prefixes: '/v2,', site_path_template: path.join(tmpDir, 'www', '{customer_no}', '{host}'), site_default_max_sites: 0 };

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('Hostnamen: Normalisierung, IDN, Subdomains, Bereichszuordnung', () => {
  assert.equal(normalizeHostname(' Shop.Kunde.AT. '), 'shop.kunde.at');
  assert.equal(normalizeHostname('müller.at'), 'xn--mller-kva.at');
  assert.throws(() => normalizeHostname('http://x.at'), ValidationError);
  assert.throws(() => normalizeHostname('a..at'), ValidationError);
  assert.throws(() => normalizeHostname('1.2.3.4'), ValidationError);
  assert.equal(normalizeSubdomain('Dev.Shop'), 'dev.shop');
  assert.throws(() => normalizeSubdomain('-x'), ValidationError);
  assert.equal(domainOwner('a.b.kunde.at', ['kunde.at']), 'kunde.at');
  assert.equal(domainOwner('kunde.at', ['kunde.at']), 'kunde.at');
  assert.equal(domainOwner('evilkunde.at', ['kunde.at']), null);
  assert.equal(domainOwner('kunde.at.evil.com', ['kunde.at']), null);
});

test('unwrapResult: v1/v2-Erfolg und -Fehler', () => {
  assert.deepEqual(unwrapResult({ status: 0, timestamp: 1, message: { a: 1 } }), { a: 1 });
  assert.throws(() => unwrapResult({ status: -1, timestamp: 1, message: { result: 'kaputt' } }), /kaputt/);
  assert.throws(() => unwrapResult({ status: false, msg: 'nein' }), /nein/);
  assert.deepEqual(unwrapResult({ status: true, msg: 'ok' }), { status: true, msg: 'ok' });
});

test('Pfad-Vorlage: Platzhalter und gesperrte Pfade', () => {
  assert.equal(sitePathFor({ site_path_template: '/www/wwwroot/{customer_no}/{host}' }, 'a.at', 'a.at', 'K-001'), '/www/wwwroot/K-001/a.at');
  assert.equal(sitePathFor({ site_path_template: '/home/{customer_no}/wwwroot/{host}' }, 'x.a.at', 'a.at', 'K/../1'), '/home/K1/wwwroot/x.a.at');
  assert.throws(() => sitePathFor({ site_path_template: '/www/server/{host}' }, 'a.at', 'a.at', ''), ValidationError);
  assert.throws(() => sitePathFor({ site_path_template: '/www/wwwroot' }, 'a.at', 'a.at', ''), ValidationError);
});

test('Website anlegen: Subdomain im eigenen Bereich, Zuordnung + AddSite-Parameter', async () => {
  workingPrefix.clear();
  const store = new Store();
  const c = customer(store, 'K-10001');
  store.assign(c.id, [{ type: 'domain', ref_name: 'kunde.at' }]);
  const sites = [];
  const api = stubApi({
    GetPHPVersion: () => [{ version: '00', name: 'Static' }, { version: '83', name: 'PHP-83' }, { version: '84', name: 'PHP-84' }],
    getData: (p) => ({ data: sites.filter((s) => s.name === p.search) }),
    AddSite: (p) => {
      const web = JSON.parse(p.webname);
      sites.push({ id: 55, name: web.domain, path: p.path, status: '1' });
      return { siteStatus: true, siteId: 55 };
    },
  });
  const svc = new SiteService({ cfg: baseCfg, store, customer: c, api });
  const r = await svc.create({ domain: 'kunde.at', subdomain: 'Shop', www: true });
  assert.equal(r.name, 'shop.kunde.at');
  assert.equal(r.path, path.join(tmpDir, 'www', 'K-10001', 'shop.kunde.at'));
  const add = api.calls.find((x) => x.path === '/v2/site?action=AddSite');
  assert.ok(add, 'AddSite über /v2/site');
  assert.equal(add.params.version, '84');
  assert.deepEqual(JSON.parse(add.params.webname), { domain: 'shop.kunde.at', domainlist: ['www.shop.kunde.at'], count: 1 });
  assert.ok(store.isAssigned(c.id, 'site', 'shop.kunde.at'));
  assert.equal(store.siteAssignmentByName(c.id, 'shop.kunde.at').ref_id, '55');
  store.close();
});

test('Website anlegen: fremde Domain, nicht zugeordneter Bereich und Limit werden abgelehnt', async () => {
  const store = new Store();
  const c = customer(store, 'K-10002', 1);
  store.assign(c.id, [{ type: 'domain', ref_name: 'meins.at' }]);
  const api = stubApi({ GetPHPVersion: () => [{ version: '83' }], getData: () => ({ data: [] }), AddSite: () => ({ siteId: 1 }) });
  const svc = new SiteService({ cfg: baseCfg, store, customer: c, api });
  await assert.rejects(svc.create({ domain: 'fremd.at' }), /nicht zugeordnet/);
  await assert.rejects(svc.create({ domain: 'meins.at', subdomain: 'a_b' }), ValidationError);
  store.assign(c.id, [{ type: 'site', ref_name: 'meins.at', ref_id: '1' }]);
  await assert.rejects(svc.create({ domain: 'meins.at', subdomain: 'neu' }), /Limit erreicht/);
  assert.ok(!api.calls.some((x) => x.path.includes('AddSite')));
  store.close();
});

test('Domain hinzufügen nur im eigenen Bereich; Hauptdomain nicht entfernbar', async () => {
  const store = new Store();
  const c = customer(store, 'K-10003');
  store.assign(c.id, [{ type: 'domain', ref_name: 'bereich.at' }]);
  const api = stubApi({
    getData: (p) => (p.table === 'domain'
      ? [{ id: 1, name: 'bereich.at', port: 80 }, { id: 2, name: 'www.bereich.at', port: 80 }]
      : { data: [] }),
  });
  const svc = new SiteService({ cfg: baseCfg, store, customer: c, api });
  const site = { id: 9, name: 'bereich.at', path: '/tmp' };
  await assert.rejects(svc.addDomain(site, 'andere.at'), /nicht in Ihrem Domain-Bereich/);
  await svc.addDomain(site, 'blog.bereich.at');
  const call = api.calls.find((x) => x.path.endsWith('AddDomain'));
  assert.equal(call.params.domain, 'blog.bereich.at:80');
  await assert.rejects(svc.removeDomain(site, 'bereich.at'), /Hauptdomain/);
  await svc.removeDomain(site, 'www.bereich.at');
  assert.ok(api.calls.some((x) => x.path.endsWith('DelDomain') && x.params.domain === 'www.bereich.at'));
  store.close();
});

test('SSL-Info gibt keinen privaten Schlüssel heraus', async () => {
  const store = new Store();
  const c = customer(store, 'K-10004');
  const api = stubApi({
    GetSSL: () => ({ status: true, key: 'PRIVATE', csr: 'CERT', httpTohttps: true,
      cert_data: { issuer_O: "Let's Encrypt", notAfter: '2026-12-01', dns: ['a.at'], endtime: 60 } }),
  });
  const info = await new SiteService({ cfg: baseCfg, store, customer: c, api }).sslInfo({ id: 1, name: 'a.at' });
  assert.equal(info.enabled, true);
  assert.equal(info.force_https, true);
  assert.ok(!JSON.stringify(info).includes('PRIVATE'));
  store.close();
});

test('API-Präfix-Fallback: /v2 liefert HTML -> klassischer Pfad', async () => {
  workingPrefix.clear();
  const store = new Store();
  const c = customer(store, 'K-10005');
  const calls = [];
  const api = {
    async raw(p) {
      calls.push(p);
      if (p.startsWith('/v2/')) throw new ApiError('Panel lieferte HTML statt JSON (HTTP 404). API aktiv? Pfad korrekt?');
      return [{ version: '83', name: 'PHP-83' }];
    },
  };
  const v = await new SiteService({ cfg: baseCfg, store, customer: c, api }).phpVersions();
  assert.equal(v[0].version, '83');
  assert.deepEqual(calls, ['/v2/site?action=GetPHPVersion', '/site?action=GetPHPVersion']);
  workingPrefix.clear();
  store.close();
});

test('Rewrite: nur bekannte Vorlagen, Redirect-Eingaben werden geprüft', async () => {
  const store = new Store();
  const c = customer(store, 'K-10006');
  const api = stubApi({});
  const svc = new SiteService({ cfg: baseCfg, store, customer: c, api });
  const site = { id: 1, name: 'a.at' };
  svc.rewriteTemplates = () => ['wordpress'];
  await assert.rejects(svc.rewriteSet(site, '../../../etc/passwd'), /Unbekannte Vorlage|Nginx/);
  await assert.rejects(svc.addRedirect(site, { path: 'kein-slash', to: 'https://x.at' }), ValidationError);
  await assert.rejects(svc.addRedirect(site, { path: '/a', to: 'javascript:alert(1)' }), ValidationError);
  await assert.rejects(svc.addRedirect(site, { path: '/a', to: 'https://x.at/;return 200' }), ValidationError);
  await svc.addRedirect(site, { path: '/alt', to: 'https://x.at/neu', code: '302' });
  const call = api.calls.find((x) => x.path.endsWith('CreateRedirect'));
  assert.equal(call.params.redirecttype, '302');
  assert.equal(call.params.redirectpath, '/alt');
  store.close();
});
