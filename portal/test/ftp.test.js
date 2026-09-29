'use strict';
// FTP-Zugänge im Kundenportal: nur innerhalb der eigenen Website, Paket-Limits,
// Shell-sichere Eingaben (aaPanel reicht sie an pure-pw weiter).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ftp-test-'));
process.env.CM_DATA_DIR = tmpDir;

const { Store } = require('../lib/store');
const { SiteService } = require('../lib/sites');
const { FtpService, generatePassword, checkUsername, checkPassword } = require('../lib/ftp');
const { ValidationError } = require('../lib/validate');

// aaPanel-Stub mit FTP-Tabelle im v2-Format (inkl. Klartext-Passwort wie das echte Panel)
function fakePanel() {
  const ftps = [];
  let nextId = 10;
  const calls = [];
  const api = {
    calls,
    ftps,
    async raw(p, params) {
      calls.push({ path: p, params });
      const action = p.split('action=')[1];
      const ok = (message) => ({ status: 0, timestamp: 1, message });
      if (p.startsWith('/v2/data') && params.table === 'ftps') {
        const rows = ftps.filter((f) => !params.search || f.name.includes(params.search));
        return ok({ where: '', page: '', data: rows.map((f) => Object.assign({}, f)) });
      }
      if (action === 'AddUser') {
        ftps.unshift({ id: nextId++, pid: 0, name: params.ftp_username, password: params.ftp_password, status: '1', ps: params.ps, path: params.path });
        return ok({ result: 'Setup successfully!' });
      }
      const f = ftps.find((x) => String(x.id) === String(params.id));
      if (action === 'SetUserPassword') {
        f.password = params.new_password;
        return ok({ result: 'ok' });
      }
      if (action === 'SetStatus') {
        f.status = String(params.status);
        return ok({ result: 'ok' });
      }
      if (action === 'DeleteUser') {
        ftps.splice(ftps.indexOf(f), 1);
        return ok({ result: 'ok' });
      }
      return ok({});
    },
  };
  return api;
}

function customer(store, no, packageId) {
  const now = Math.floor(Date.now() / 1000);
  const info = store.db
    .prepare('INSERT INTO customers (customer_no, company, status, package_id, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(no, 'Test', 'active', packageId || null, now, now);
  return store.db.prepare('SELECT * FROM customers WHERE id=?').get(info.lastInsertRowid);
}

function pkg(store, fields) {
  const f = Object.assign({ name: 'P' + Math.random(), max_ftp: 0, ftp_allowed: 1 }, fields);
  const info = store.db.prepare('INSERT INTO packages (name, max_ftp, ftp_allowed) VALUES (?,?,?)').run(f.name, f.max_ftp, f.ftp_allowed);
  return info.lastInsertRowid;
}

function setup(packageFields) {
  const store = new Store();
  const pid = packageFields ? pkg(store, packageFields) : null;
  const c = customer(store, 'K-' + Math.random().toString(36).slice(2, 8), pid);
  const api = fakePanel();
  const svc = new SiteService({ cfg: { site_api_prefixes: '/v2,', ftp_host: 'ftp.example.at' }, store, customer: c, api });
  const root = fs.mkdtempSync(path.join(tmpDir, 'site-'));
  const site = { id: 1, name: 'kunde.at', path: root };
  return { store, c, api, svc, ftp: new FtpService(svc), site, root };
}

test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('Eingaben: Benutzername/Passwort ohne Shell-Sonderzeichen', () => {
  assert.equal(checkUsername(' Kunde_FTP '), 'kunde_ftp');
  for (const bad of ['ab', 'a b', 'x;rm', 'x$y', '-abc', 'a'.repeat(33), 'äbc']) {
    assert.throws(() => checkUsername(bad), ValidationError, bad);
  }
  assert.equal(checkPassword('Geheim123!'), 'Geheim123!');
  for (const bad of ['kurz1', 'nurbuchstaben', '12345678', 'abc12345$(id)', 'abc 12345', 'abc12345`x`', 'abc"12345', 'ab\n12345']) {
    assert.throws(() => checkPassword(bad), ValidationError, bad);
  }
  const pw = generatePassword(16);
  assert.match(pw, /^[A-Za-z0-9]{16}$/);
  assert.notEqual(pw, generatePassword(16));
});

test('Anlegen: Verzeichnis in der Website, Zuordnung, erzeugtes Passwort', async () => {
  const { api, ftp, site, root, store, c } = setup();
  const r = await ftp.create(site, { username: 'kunde_ftp', password: '', dir: '/public/uploads' });
  assert.equal(r.user, 'kunde_ftp');
  assert.match(r.password, /^[A-Za-z0-9]{16}$/);
  assert.equal(r.path, path.join(fs.realpathSync(root), 'public', 'uploads'));
  assert.ok(fs.statSync(r.path).isDirectory());
  const add = api.calls.find((x) => x.path === '/v2/ftp?action=AddUser');
  assert.deepEqual(Object.keys(add.params).sort(), ['ftp_password', 'ftp_username', 'path', 'ps']);
  const asg = store.assignments(c.id).filter((a) => a.type === 'ftp');
  assert.equal(asg.length, 1);
  assert.equal(asg[0].ref_id, '10');

  const list = await ftp.forSite(site);
  assert.equal(list.length, 1);
  assert.equal(list[0].rel, '/public/uploads');
  assert.equal(list[0].password, undefined, 'Panel-Passwort darf nicht durchgereicht werden');
  assert.equal(ftp.host(), 'ftp.example.at');
});

test('Anlegen: kein Ausbruch aus dem Website-Verzeichnis', async () => {
  const { api, ftp, site, root } = setup();
  await assert.rejects(ftp.create(site, { username: 'aaa', password: 'Geheim123', dir: '/../../etc' }), ValidationError);
  await assert.rejects(ftp.create(site, { username: 'aaa', password: 'Geheim123', dir: '/a b' }), ValidationError);
  fs.symlinkSync('/etc', path.join(root, 'raus'));
  await assert.rejects(ftp.create(site, { username: 'aaa', password: 'Geheim123', dir: '/raus' }), ValidationError);
  assert.equal(api.calls.filter((x) => x.path.includes('AddUser')).length, 0);
});

test('Anlegen: Namen vergeben, Paket-Limit und FTP-Sperre', async () => {
  const a = setup({ max_ftp: 1 });
  a.api.ftps.push({ id: 3, name: 'fremd', status: '1', path: '/anderswo' });
  await assert.rejects(a.ftp.create(a.site, { username: 'fremd', password: 'Geheim123', dir: '/' }), /vergeben/);
  await a.ftp.create(a.site, { username: 'eins', password: 'Geheim123', dir: '/' });
  await assert.rejects(a.ftp.create(a.site, { username: 'zwei', password: 'Geheim123', dir: '/' }), /Limit/);

  const b = setup({ ftp_allowed: 0 });
  assert.equal(b.ftp.allowed(), false);
  await assert.rejects(b.ftp.create(b.site, { username: 'drei', password: 'Geheim123', dir: '/' }), /nicht enthalten/);
});

test('Verwalten: Passwort, Sperren, Löschen nur für Konten der Website', async () => {
  const { api, ftp, site, store, c } = setup();
  await ftp.create(site, { username: 'mein_ftp', password: 'Geheim123', dir: '/' });
  const asg = store.assignments(c.id).find((x) => x.type === 'ftp');
  const acc = await ftp.resolve(asg, site);

  assert.equal(await ftp.setPassword(acc, 'Neu12345'), null);
  assert.equal(api.ftps[0].password, 'Neu12345');
  await ftp.setActive(acc, false);
  assert.equal((await ftp.resolve(asg, site)).active, false);

  // Konto einer anderen Website ist über diese Website nicht erreichbar
  const other = { id: 2, name: 'andere.at', path: fs.mkdtempSync(path.join(tmpDir, 'site-')) };
  await assert.rejects(ftp.resolve(asg, other), ValidationError);

  await ftp.remove(acc);
  assert.equal(api.ftps.length, 0);
  assert.equal(store.assignments(c.id).filter((x) => x.type === 'ftp').length, 0);
});
