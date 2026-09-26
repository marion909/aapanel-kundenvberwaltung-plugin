'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const fs = require('fs');
const resources = require('../lib/resources');

class FakeApi {
  constructor({ sites, mailDomains, mailboxesByDomain, sitesError } = {}) {
    this.sites = sites || [];
    this.mailDomains = mailDomains || [];
    this.mailboxesByDomain = mailboxesByDomain || {};
    this.sitesError = sitesError || null;
  }
  async listSites() {
    if (this.sitesError) throw this.sitesError;
    return [this.sites.slice(), []];
  }
  async listMailDomains(paths) {
    return [this.mailDomains.slice(), paths[0]];
  }
  async listMailboxes(paths, method, domain) {
    return [(this.mailboxesByDomain[domain] || []).slice(), paths[0]];
  }
}

test('mailPluginPaths: Default und benutzerdefiniert', () => {
  assert.deepEqual(resources.mailPluginPaths({}), ['/v2/plugin', '/plugin']);
  assert.deepEqual(resources.mailPluginPaths({ mail_plugin_paths: '/a, /b' }), ['/a', '/b']);
});

test('loadResources normalisiert Groß-/Kleinschreibung und indexResources findet alles', async () => {
  const api = new FakeApi({
    sites: [{ id: 1, name: 'Example.COM', status: '1', project_type: 'PHP', ssl: null }],
    mailDomains: [{ domain: 'Example.com', active: 1, created: '' }],
    mailboxesByDomain: { 'Example.com': [{ username: 'Info@Example.com', domain: 'Example.com' }] },
  });
  const existsMock = mock.method(fs, 'existsSync', () => true);
  try {
    const res = await resources.loadResources({ data_path: '/v2/data', site_project_types: '' }, api);
    assert.equal(res.sites[0].name, 'example.com');
    assert.equal(res.mail_domains[0].domain, 'example.com');
    assert.equal(res.mailboxes[0].username, 'info@example.com');
    assert.equal(res.mailboxes[0].domain, 'example.com');

    const idx = resources.indexResources(res);
    assert.ok(idx.has('site\u0000example.com'));
    assert.ok(idx.has('mail_domain\u0000example.com'));
    assert.ok(idx.has('mailbox\u0000info@example.com'));
  } finally {
    existsMock.mock.restore();
  }
});

test('fetchMail meldet "nicht installiert", wenn weder Plugin noch DB existieren', async () => {
  const existsMock = mock.method(fs, 'existsSync', () => false);
  try {
    const [domains, boxes, src] = await resources.fetchMail(new FakeApi(), {}, []);
    assert.deepEqual(domains, []);
    assert.deepEqual(boxes, []);
    assert.equal(src, 'nicht installiert');
  } finally {
    existsMock.mock.restore();
  }
});

test('annotateAssignments markiert ok/missing/unknown korrekt', () => {
  const idx = new Map([['site\u0000example.com', { status: '1' }]]);
  const rows = [
    { type: 'site', ref_name: 'example.com' },
    { type: 'site', ref_name: 'gone.com' },
  ];
  resources.annotateAssignments(rows, idx);
  assert.equal(rows[0].state, 'ok');
  assert.deepEqual(rows[0].info, { status: '1' });
  assert.equal(rows[1].state, 'missing');
  assert.deepEqual(rows[1].info, {});

  const rows2 = [{ type: 'site', ref_name: 'example.com' }];
  resources.annotateAssignments(rows2, null);
  assert.equal(rows2[0].state, 'unknown');
  assert.deepEqual(rows2[0].info, {});
});

test('annotateAssignments: Domain-Bereiche gelten nie als fehlend', () => {
  for (const idx of [new Map(), null]) {
    const rows = [{ type: 'domain', ref_name: 'kunde.at' }];
    resources.annotateAssignments(rows, idx);
    assert.equal(rows[0].state, 'ok');
  }
});

test('ResourceCache respektiert TTL und refresh/invalidate', async () => {
  let calls = 0;
  const fakeLoad = async () => {
    calls += 1;
    return { n: calls };
  };
  const cache = new resources.ResourceCache(100000, fakeLoad);

  const first = await cache.get({});
  const second = await cache.get({});
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  const third = await cache.get({}, true);
  assert.equal(calls, 2);
  assert.notDeepEqual(first, third);
  cache.invalidate();
  await cache.get({});
  assert.equal(calls, 3);
});
