'use strict';
// Postfach-Sicherungen: Sicherung (tar.gz mit .eml), Wiederherstellung über doveadm
// (hier ein Stub-Skript), Zeitplan, Aufbewahrung und Portal-Routen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mailbackup-test-'));
process.env.CM_DATA_DIR = path.join(tmpDir, 'data');
process.env.CM_VMAIL_ROOT = path.join(tmpDir, 'vmail');
process.env.PORTAL_DEBUG = '1';
fs.mkdirSync(process.env.CM_DATA_DIR, { recursive: true });

const store = require('../lib/store');
const maildir = require('../lib/maildir');
const { MailBackups } = require('../lib/mailbackup');

const BACKUP_DIR = path.join(tmpDir, 'backups');
store.saveCfg(Object.assign(store.loadCfg(), { mail_backup_dir: BACKUP_DIR, mail_backup_hour: 3 }));

// Fake-doveadm: protokolliert Argumente und Dateien der Quelle
const DOVE_LOG = path.join(tmpDir, 'doveadm.log');
const DOVEADM = path.join(tmpDir, 'doveadm');
// "import": Argumente + Quelldateien protokollieren; "search": so viele Treffer wie importiert
fs.writeFileSync(DOVEADM, `#!/bin/sh
if [ "$1" = search ]; then [ -f "${DOVE_LOG}.n" ] && cat "${DOVE_LOG}.n"; exit 0; fi
echo "$@" > "${DOVE_LOG}"
find "\${5#maildir:}" -type f | sort >> "${DOVE_LOG}"
[ -n "$DOVE_DROP" ] || find "\${5#maildir:}" -type f | sed 's/.*/x 1/' > "${DOVE_LOG}.n"
`, { mode: 0o755 });

function makeMailbox(address, extra) {
  const [local, domain] = address.split('@');
  const md = path.join(process.env.CM_VMAIL_ROOT, domain, local);
  const mk = (d) => ['cur', 'new', 'tmp'].forEach((s) => fs.mkdirSync(path.join(d, s), { recursive: true }));
  mk(md);
  mk(path.join(md, '.Sent'));
  fs.writeFileSync(path.join(md, 'cur', '1700000000.M1.h:2,S'), 'Subject: eins\n\nHallo');
  fs.writeFileSync(path.join(md, 'new', '1700000001.M2.h'), 'Subject: zwei\n\nWelt');
  fs.writeFileSync(path.join(md, '.Sent', 'cur', '1700000002.M3.h:2,RS'), 'Subject: gesendet\n\nx');
  if (extra) extra(md);
  return md;
}

function customer(s, no, pkgFields) {
  const now = Math.floor(Date.now() / 1000);
  let pid = null;
  if (pkgFields) {
    pid = s.db.prepare('INSERT INTO packages (name, mail_backup_allowed, mail_backup_days) VALUES (?,?,?)')
      .run('P-' + no, pkgFields.allowed === undefined ? 1 : pkgFields.allowed, pkgFields.days || 0).lastInsertRowid;
  }
  const id = s.db
    .prepare('INSERT INTO customers (customer_no, company, status, package_id, portal_enabled, portal_password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(no, 'Firma ' + no, 'active', pid, 1, store.hashPassword('sicheresPasswort123'), now, now).lastInsertRowid;
  return s.getCustomer(id);
}

function service() {
  return new MailBackups({ doveadm: DOVEADM, log: () => {} });
}

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('Sicherung: tar.gz mit .eml pro Nachricht, Ordner und Flags', async () => {
  const svc = service();
  const c = customer(svc.store, 'K-30001', { days: 7 });
  makeMailbox('office@kunde.at');
  svc.store.assign(c.id, [{ type: 'mailbox', ref_name: 'office@kunde.at' }]);

  const id = svc.request(c, 'office@kunde.at', 'manual');
  assert.throws(() => svc.request(c, 'office@kunde.at', 'manual'), /läuft bereits/);
  await svc.kick();
  const row = svc.get(c.id, id);
  assert.equal(row.status, 'done', row.error);
  assert.equal(row.messages, 3);
  const file = svc.filePath(row);
  assert.ok(file.startsWith(path.join(BACKUP_DIR, String(c.id)) + path.sep));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const names = execFileSync('tar', ['-tzf', file]).toString().trim().split('\n');
  assert.deepEqual(names, ['backup.json', 'Posteingang/000001_S.eml', 'Posteingang/000002.eml', 'Sent/000001_RS.eml']);
  assert.equal(execFileSync('tar', ['-xzOf', file, 'Posteingang/000002.eml']).toString(), 'Subject: zwei\n\nWelt');
});

test('Sicherung: Paket ohne Mail-Backup und fremde Postfächer', async () => {
  const svc = service();
  const c = customer(svc.store, 'K-30002', { allowed: 0 });
  assert.throws(() => svc.request(c, 'x@kunde.at', 'manual'), /nicht enthalten/);

  // nicht (mehr) zugeordnet: Auftrag schlägt fehl, ohne Datei
  const d = customer(svc.store, 'K-30003', { days: 1 });
  const id = svc.request(d, 'office@kunde.at', 'manual');
  await svc.kick();
  const row = svc.get(d.id, id);
  assert.equal(row.status, 'error');
  assert.match(row.error, /nicht mehr zugeordnet/);
  assert.equal(svc.get(c.id, id), null, 'fremde Sicherung nicht abrufbar');
});

test('Wiederherstellen: doveadm import in eigenen Ordner, nur einmal', async () => {
  const svc = service();
  const c = customer(svc.store, 'K-30004', { days: 7 });
  makeMailbox('info@wieder.at');
  svc.store.assign(c.id, [{ type: 'mailbox', ref_name: 'info@wieder.at' }]);
  const id = svc.request(c, 'info@wieder.at', 'manual');
  await svc.kick();

  svc.requestRestore(c, id);
  await svc.kick();
  const row = svc.get(c.id, id);
  assert.equal(row.restore_status, 'done', row.restore_error);
  assert.match(row.restore_folder, /^Wiederhergestellt-\d{4}-\d{2}-\d{2}-\d{4}$/);
  const log = fs.readFileSync(DOVE_LOG, 'utf8').trim().split('\n');
  assert.match(log[0], new RegExp(`^import -s -u info@wieder\\.at maildir:${process.env.CM_VMAIL_ROOT}/wieder\\.at/\\.cm-restore-${id}/Maildir ${row.restore_folder} all$`));
  assert.equal(log.length - 1, 3, 'drei Nachrichten in der Quelle');
  assert.ok(log.some((l) => /\/\.Sent\/cur\/\d+\.R000001\.restore:2,RS$/.test(l)), 'Ordner und Flags bleiben erhalten');
  assert.ok(!fs.existsSync(path.join(process.env.CM_VMAIL_ROOT, 'wieder.at', `.cm-restore-${id}`)), 'Temp-Verzeichnis aufgeräumt');
  assert.throws(() => svc.requestRestore(c, id), /bereits/);
});

test('Wiederherstellen: doveadm übernimmt nichts -> Fehler statt „fertig“', async () => {
  const svc = service();
  const c = customer(svc.store, 'K-30009', { days: 7 });
  makeMailbox('leer@wieder.at');
  svc.store.assign(c.id, [{ type: 'mailbox', ref_name: 'leer@wieder.at' }]);
  const id = svc.request(c, 'leer@wieder.at', 'manual');
  await svc.kick();
  fs.rmSync(DOVE_LOG + '.n', { force: true });
  process.env.DOVE_DROP = '1';
  try {
    svc.requestRestore(c, id);
    await svc.kick();
  } finally {
    delete process.env.DOVE_DROP;
  }
  const row = svc.get(c.id, id);
  assert.equal(row.restore_status, 'error');
  assert.match(row.restore_error, /nur 0 von 3/);
});

test('Wiederherstellen ohne doveadm: verständlicher Fehler', async () => {
  const svc = new MailBackups({ doveadm: null, log: () => {} });
  svc.findDoveadm = () => { throw new (require('../lib/validate').ValidationError)('doveadm wurde nicht gefunden'); };
  const c = customer(svc.store, 'K-30005', { days: 7 });
  makeMailbox('a@ohne.at');
  svc.store.assign(c.id, [{ type: 'mailbox', ref_name: 'a@ohne.at' }]);
  const id = svc.request(c, 'a@ohne.at', 'manual');
  await svc.kick();
  svc.requestRestore(c, id);
  await svc.kick();
  const row = svc.get(c.id, id);
  assert.equal(row.restore_status, 'error');
  assert.match(row.restore_error, /doveadm/);
});

test('Zeitplan: automatische Sicherung einmal täglich ab der eingestellten Stunde', async () => {
  const svc = service();
  const c = customer(svc.store, 'K-30006', { days: 3 });
  const off = customer(svc.store, 'K-30007', { days: 0 });
  makeMailbox('auto@plan.at');
  makeMailbox('manuell@plan.at');
  svc.store.assign(c.id, [{ type: 'mailbox', ref_name: 'auto@plan.at' }]);
  svc.store.assign(off.id, [{ type: 'mailbox', ref_name: 'manuell@plan.at' }]);
  const at = (h) => {
    const d = new Date();
    d.setHours(h, 5, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };
  // andere Kunden aus früheren Tests stören nicht: nur K-30006 hat eine Aufbewahrung > 0 mit Postfach ohne Auto-Sicherung
  const before = svc.db.prepare("SELECT COUNT(*) AS n FROM mail_backups WHERE kind='auto'").get().n;
  assert.equal(svc.schedule(at(2)), 0, 'vor 3 Uhr nichts');
  const n = svc.schedule(at(4));
  assert.ok(n >= 1);
  assert.equal(svc.schedule(at(5)), 0, 'nicht doppelt am selben Tag');
  await svc.kick();
  const rows = svc.list(c.id, 'auto@plan.at');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'auto');
  assert.equal(rows[0].status, 'done');
  assert.equal(svc.list(off.id, 'manuell@plan.at').length, 0);
  assert.ok(svc.db.prepare("SELECT COUNT(*) AS n FROM mail_backups WHERE kind='auto'").get().n > before);
});

test('Aufbewahrung: 3 manuelle, Auto nach N Tagen, verwaiste sofort', async () => {
  const svc = service();
  const c = customer(svc.store, 'K-30008', { days: 2 });
  makeMailbox('keep@alt.at');
  svc.store.assign(c.id, [{ type: 'mailbox', ref_name: 'keep@alt.at' }]);
  const now = Math.floor(Date.now() / 1000);
  const ins = svc.db.prepare("INSERT INTO mail_backups (customer_id, mailbox, kind, status, file, created_at) VALUES (?,?,?,'done',?,?)");
  const dir = path.join(BACKUP_DIR, String(c.id));
  fs.mkdirSync(dir, { recursive: true });
  const mk = (kind, age, name) => {
    fs.writeFileSync(path.join(dir, name), 'x');
    return ins.run(c.id, 'keep@alt.at', kind, name, now - age).lastInsertRowid;
  };
  const m = [0, 1, 2, 3].map((i) => mk('manual', i * 3600, `m${i}.tar.gz`));
  const aNew = mk('auto', 86400, 'a1.tar.gz');
  const aOld = mk('auto', 3 * 86400, 'a3.tar.gz');
  svc.prune(now);
  const ids = svc.list(c.id, 'keep@alt.at').map((r) => r.id);
  assert.deepEqual(ids.sort(), [m[0], m[1], m[2], aNew].sort());
  assert.ok(!fs.existsSync(path.join(dir, 'm3.tar.gz')));
  assert.ok(!fs.existsSync(path.join(dir, 'a3.tar.gz')));
  assert.ok(!ids.includes(aOld));

  // Postfach nicht mehr zugeordnet: alle Sicherungen weg
  const asg = svc.store.assignments(c.id).find((a) => a.type === 'mailbox');
  svc.store.unassign(asg.id);
  svc.prune(now);
  assert.equal(svc.list(c.id, 'keep@alt.at').length, 0);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('Maildir: Ordnernamen (modified UTF-7) und Pfad-Prüfung', () => {
  assert.equal(maildir.decodeMutf7('Entw&APw-rfe'), 'Entwürfe');
  assert.equal(maildir.encodeMutf7('Entwürfe & Co'), 'Entw&APw-rfe &- Co');
  assert.equal(maildir.decodeMutf7(maildir.encodeMutf7('日本語 Ordner')), '日本語 Ordner');
  for (const bad of ['../x@kunde.at', 'a@../../etc', 'a@b/c', '.x@kunde.at', 'ohneat']) {
    assert.throws(() => maildir.mailboxDir(bad), /Ungültige/, bad);
  }
});

test('Portal: Sicherungsseite, Download und fremde Sicherungen', async () => {
  const s = new store.Store();
  const c = customer(s, 'K-30100', { days: 7 });
  const other = customer(s, 'K-30101', { days: 7 });
  makeMailbox('web@portal.at');
  makeMailbox('fremd@portal.at');
  s.assign(c.id, [{ type: 'mailbox', ref_name: 'web@portal.at' }]);
  s.assign(other.id, [{ type: 'mailbox', ref_name: 'fremd@portal.at' }]);
  const boxId = s.assignments(c.id).find((a) => a.type === 'mailbox').id;
  const foreignBox = s.assignments(other.id).find((a) => a.type === 'mailbox').id;
  s.close();

  const app = require('../server');
  const svc = app.mailBackups;
  svc.doveadm = DOVEADM;
  const foreignId = svc.request(other, 'fremd@portal.at', 'manual');
  await svc.kick();

  const server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const req = async (p, opts) => {
    const o = Object.assign({ redirect: 'manual' }, opts || {});
    o.headers = Object.assign({ Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, o.headers || {});
    const res = await fetch(base + p, o);
    for (const ck of res.headers.getSetCookie()) {
      const kv = ck.split(';')[0];
      jar.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1));
    }
    return res;
  };
  const post = (p, body) => req(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  try {
    const csrf = (await (await req('/login')).text()).match(/name="csrf_token" value="([^"]+)"/)[1];
    assert.equal((await post('/login', { login: 'K-30100', password: 'sicheresPasswort123', csrf_token: csrf })).status, 302);

    assert.match(await (await req('/mail')).text(), new RegExp(`/mail/boxes/${boxId}/backups`));
    let html = await (await req(`/mail/boxes/${boxId}/backups`)).text();
    assert.match(html, /Jetzt sichern/);
    assert.match(html, /täglich gesichert, Aufbewahrung 7 Tage/);

    let res = await post(`/mail/boxes/${boxId}/backups`, { csrf_token: csrf });
    assert.equal(res.status, 302);
    await svc.kick();
    const row = svc.list(c.id, 'web@portal.at')[0];
    assert.equal(row.status, 'done', row.error);
    html = await (await req(`/mail/boxes/${boxId}/backups`)).text();
    assert.match(html, /Herunterladen/);

    res = await req(`/mail/boxes/${boxId}/backups/${row.id}/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/gzip');
    assert.equal(Buffer.from(await res.arrayBuffer()).length, row.size);

    // fremdes Postfach und fremde Sicherung: 404
    assert.equal((await req(`/mail/boxes/${foreignBox}/backups`)).status, 404);
    assert.equal((await req(`/mail/boxes/${boxId}/backups/${foreignId}/download`)).status, 404);
    assert.equal((await post(`/mail/boxes/${boxId}/backups/${foreignId}/delete`, { csrf_token: csrf })).status, 404);
    // ohne CSRF-Token keine Sicherung
    assert.notEqual((await post(`/mail/boxes/${boxId}/backups`, {})).status, 302);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
