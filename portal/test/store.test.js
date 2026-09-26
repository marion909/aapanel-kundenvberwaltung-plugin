'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { Store, hashPassword, verifyPassword } = require('../lib/store');

function tmpDbPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-portal-test-')), 'test.db');
}

function makeCustomer(store, overrides) {
  const db = store.db;
  const now = Math.floor(Date.now() / 1000);
  const no = (overrides && overrides.customer_no) || 'K-' + Math.floor(Math.random() * 1e6);
  const info = db
    .prepare(
      'INSERT INTO customers (customer_no, company, status, created_at, updated_at) VALUES (?,?,?,?,?)'
    )
    .run(no, (overrides && overrides.company) || 'Test GmbH', 'active', now, now);
  return info.lastInsertRowid;
}

test('migration: ALTER TABLE fügt fehlende Portal-Spalten hinzu, ohne Daten zu verlieren', () => {
  const dbPath = tmpDbPath();
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_no TEXT UNIQUE,
    company TEXT DEFAULT '', first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
    email TEXT DEFAULT '', phone TEXT DEFAULT '', street TEXT DEFAULT '',
    zip TEXT DEFAULT '', city TEXT DEFAULT '', country TEXT DEFAULT '',
    vat_id TEXT DEFAULT '', note TEXT DEFAULT '', status TEXT DEFAULT 'active',
    created_at INTEGER, updated_at INTEGER)`);
  raw.prepare("INSERT INTO customers (customer_no, company, status, created_at, updated_at) VALUES (?,?,?,?,?)").run(
    'K-00001', 'Bestandskunde', 'active', 1, 1
  );
  raw.close();

  const store = new Store(dbPath);
  const row = store.db.prepare('SELECT * FROM customers WHERE customer_no=?').get('K-00001');
  assert.equal(row.company, 'Bestandskunde');
  assert.equal(row.portal_enabled, 0);
  assert.equal(row.portal_password_hash, '');
  store.close();
});

test('getCustomer entfernt niemals portal_password_hash', () => {
  const store = new Store(tmpDbPath());
  const cid = makeCustomer(store);
  store.db.prepare('UPDATE customers SET portal_password_hash=? WHERE id=?').run(hashPassword('geheim'), cid);
  const c = store.getCustomer(cid);
  assert.equal('portal_password_hash' in c, false);
  store.close();
});

test('getPortalCustomer: case-insensitive, nur bei portal_enabled=1', () => {
  const store = new Store(tmpDbPath());
  const cid = makeCustomer(store, { customer_no: 'K-00042' });
  assert.equal(store.getPortalCustomer('K-00042'), null); // noch nicht aktiviert
  store.db.prepare('UPDATE customers SET portal_enabled=1, portal_password_hash=? WHERE id=?').run(
    hashPassword('pw12345678'), cid
  );
  const c = store.getPortalCustomer('k-00042');
  assert.ok(c);
  assert.equal(verifyPassword('pw12345678', c.portal_password_hash), true);
  store.close();
});

test('isAssigned / assign / unassign / getAssignment', () => {
  const store = new Store(tmpDbPath());
  const cid = makeCustomer(store);
  assert.equal(store.isAssigned(cid, 'site', 'example.com'), false);

  const [added] = store.assign(cid, [{ type: 'site', ref_name: 'Example.com', ref_id: '5' }]);
  assert.equal(added.length, 1);
  assert.equal(store.isAssigned(cid, 'site', 'example.com'), true); // Kleinschreibung normalisiert

  const row = store.assignments(cid).find((a) => a.ref_name === 'example.com');
  const got = store.getAssignment(row.id);
  assert.equal(got.customer_id, cid);

  store.unassign(row.id);
  assert.equal(store.isAssigned(cid, 'site', 'example.com'), false);
  assert.equal(store.getAssignment(row.id), null);
  store.close();
});

test('assign überspringt bereits vergebene Ressourcen (UNIQUE type+ref_name)', () => {
  const store = new Store(tmpDbPath());
  const cid1 = makeCustomer(store);
  const cid2 = makeCustomer(store);
  store.assign(cid1, [{ type: 'mailbox', ref_name: 'info@example.com' }]);
  const [added, skipped] = store.assign(cid2, [{ type: 'mailbox', ref_name: 'info@example.com' }]);
  assert.equal(added.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].owner, cid1);
  store.close();
});

test('Login-Drossel zählt Fehlversuche nach login und ip getrennt', () => {
  const store = new Store(tmpDbPath());
  for (let i = 0; i < 3; i++) store.recordLoginAttempt('K-00001', '127.0.0.1', false);
  store.recordLoginAttempt('K-00001', '127.0.0.1', true);
  const [byLogin, byIp] = store.loginAttemptsCount('K-00001', '127.0.0.1', 3600);
  assert.equal(byLogin, 3);
  assert.equal(byIp, 3);
  store.close();
});
