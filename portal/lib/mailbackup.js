'use strict';
// Postfach-Sicherungen für das Kundenportal.
//
// Stufe 1: Sicherung auf Knopfdruck, danach Download (.tar.gz mit .eml-Dateien)
// Stufe 2: automatische tägliche Sicherung laut Hosting-Paket (Aufbewahrung in Tagen)
// Stufe 3: Wiederherstellen einer Sicherung in einen eigenen Ordner des Postfachs
//          ("Wiederhergestellt-<Datum>") über "doveadm import" - nichts wird überschrieben.
//
// Aufträge stehen in der Tabelle mail_backups und werden im Portal-Prozess
// nacheinander abgearbeitet (ein Auftrag gleichzeitig, schont Platte und CPU).
// Sicherungen liegen außerhalb der Websites unter cfg.mail_backup_dir/<Kunden-ID>/.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const maildir = require('./maildir');
const { effectiveLimits } = require('./packages');
const { ValidationError } = require('./validate');

const MANUAL_KEEP = 3; // manuelle Sicherungen pro Postfach
const MANUAL_MAX_DAYS = 30;
const AUTO_GRACE_DAYS = 7; // Paket ohne automatische Sicherung: alte Auto-Sicherungen noch so lange behalten
const ERROR_KEEP_DAYS = 7;
const DAY = 86400;
const DOVEADM = ['/usr/bin/doveadm', '/usr/local/bin/doveadm', '/usr/sbin/doveadm', '/usr/local/sbin/doveadm'];

function now() {
  return Math.floor(Date.now() / 1000);
}

function stamp(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function startOfDay(ts) {
  const d = new Date(ts * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function backupRoot(cfg) {
  const dir = path.resolve(String(cfg.mail_backup_dir || '/www/backup/customer_mgr_mail'));
  if (dir.split('/').length < 3 || dir.startsWith('/www/wwwroot') || dir.startsWith(maildir.VMAIL_ROOT)) {
    throw new ValidationError('Die Ablage für Mail-Sicherungen ist ungültig (Admin-Einstellungen).');
  }
  return dir;
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs || 6 * 3600 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ');
        return reject(new Error(msg || err.message));
      }
      resolve(stdout);
    });
  });
}

function chownTree(p, uid, gid) {
  fs.lchownSync(p, uid, gid);
  if (fs.lstatSync(p).isDirectory()) for (const n of fs.readdirSync(p)) chownTree(path.join(p, n), uid, gid);
}

class MailBackups {
  // opts.store: eigene Store-Instanz (Standard: neue Verbindung), opts.loadCfg, opts.vmailRoot, opts.doveadm
  constructor(opts) {
    const o = opts || {};
    this.store = o.store || new store.Store();
    this.loadCfg = o.loadCfg || store.loadCfg;
    this.vmailRoot = o.vmailRoot || maildir.VMAIL_ROOT;
    this.doveadm = o.doveadm || null;
    this.running = null;
    this.timer = null;
    this.log = o.log || ((...a) => console.error('[mail-backup]', ...a)); // eslint-disable-line no-console
  }

  get db() {
    return this.store.db;
  }

  // ------------------------------------------------------------ Abfragen
  limitsFor(customer) {
    return effectiveLimits(customer, this.store.getPackage(customer.package_id), this.loadCfg());
  }

  list(cid, mailbox) {
    return this.db
      .prepare('SELECT * FROM mail_backups WHERE customer_id=? AND mailbox=? ORDER BY created_at DESC, id DESC')
      .all(cid, String(mailbox).toLowerCase());
  }

  get(cid, id) {
    const row = this.db.prepare('SELECT * FROM mail_backups WHERE id=?').get(Number(id));
    if (!row || row.customer_id !== cid) return null;
    return row;
  }

  filePath(row) {
    const base = path.basename(String(row.file || ''));
    if (!base || base !== row.file) throw new ValidationError('Sicherung nicht gefunden.');
    return path.join(backupRoot(this.loadCfg()), String(row.customer_id), base);
  }

  // ------------------------------------------------------------ Aufträge
  request(customer, mailbox, kind) {
    const lim = this.limitsFor(customer);
    if (!lim.mail_backup) throw new ValidationError('Mail-Sicherungen sind in Ihrem Paket nicht enthalten.');
    const mb = String(mailbox).toLowerCase();
    const busy = this.db
      .prepare("SELECT 1 FROM mail_backups WHERE customer_id=? AND mailbox=? AND status IN ('queued','running')")
      .get(customer.id, mb);
    if (busy) throw new ValidationError('Für dieses Postfach läuft bereits eine Sicherung.');
    const info = this.db
      .prepare("INSERT INTO mail_backups (customer_id, mailbox, kind, status, created_at) VALUES (?,?,?,'queued',?)")
      .run(customer.id, mb, kind === 'auto' ? 'auto' : 'manual', now());
    this.kick();
    return info.lastInsertRowid;
  }

  requestRestore(customer, id) {
    const lim = this.limitsFor(customer);
    if (!lim.mail_backup) throw new ValidationError('Mail-Sicherungen sind in Ihrem Paket nicht enthalten.');
    const row = this.get(customer.id, id);
    if (!row || row.status !== 'done') throw new ValidationError('Diese Sicherung ist nicht (mehr) verfügbar.');
    if (row.restore_status === 'queued' || row.restore_status === 'running') throw new ValidationError('Die Wiederherstellung läuft bereits.');
    if (row.restore_status === 'done') {
      throw new ValidationError(`Diese Sicherung wurde bereits in den Ordner „${row.restore_folder}“ wiederhergestellt.`);
    }
    this.db.prepare("UPDATE mail_backups SET restore_status='queued', restore_error='' WHERE id=?").run(row.id);
    this.kick();
  }

  remove(cid, id) {
    const row = this.get(cid, id);
    if (!row) throw new ValidationError('Sicherung nicht gefunden.');
    if (row.status === 'running' || row.restore_status === 'running') throw new ValidationError('Die Sicherung wird gerade verarbeitet.');
    this.drop(row);
  }

  drop(row) {
    if (row.file) {
      try {
        fs.unlinkSync(this.filePath(row));
      } catch (e) {
        // Datei schon weg
      }
    }
    this.db.prepare('DELETE FROM mail_backups WHERE id=?').run(row.id);
  }

  // ------------------------------------------------------------ Abarbeitung
  // Startet die Abarbeitung im Hintergrund (idempotent); liefert das Promise.
  kick() {
    if (!this.running) {
      this.running = this.work()
        .catch((e) => this.log(e))
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  async work() {
    for (;;) {
      const b = this.db.prepare("SELECT * FROM mail_backups WHERE status='queued' ORDER BY id LIMIT 1").get();
      if (b) {
        await this.runBackup(b);
        continue;
      }
      const r = this.db.prepare("SELECT * FROM mail_backups WHERE restore_status='queued' ORDER BY id LIMIT 1").get();
      if (r) {
        await this.runRestore(r);
        continue;
      }
      return;
    }
  }

  async runBackup(row) {
    this.db.prepare("UPDATE mail_backups SET status='running', messages=0, error='' WHERE id=?").run(row.id);
    let part = null;
    try {
      if (!this.store.isAssigned(row.customer_id, 'mailbox', row.mailbox)) throw new ValidationError('Das Postfach ist nicht mehr zugeordnet.');
      const src = maildir.mailboxDir(row.mailbox, this.vmailRoot);
      const dir = path.join(backupRoot(this.loadCfg()), String(row.customer_id));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = `${row.mailbox.replace(/[^a-z0-9@._-]/g, '_')}_${stamp(row.created_at)}_${row.id}.tar.gz`;
      part = path.join(dir, file + '.part');
      const upd = this.db.prepare('UPDATE mail_backups SET messages=? WHERE id=?');
      const res = await maildir.writeBackup(src, row.mailbox, part, (done) => upd.run(done, row.id));
      fs.renameSync(part, path.join(dir, file));
      part = null;
      const size = fs.statSync(path.join(dir, file)).size;
      this.db
        .prepare("UPDATE mail_backups SET status='done', file=?, size=?, messages=?, finished_at=? WHERE id=?")
        .run(file, size, res.messages, now(), row.id);
      this.store.log(`portal_mail_backup${row.kind === 'auto' ? '_auto' : ''}`, row.customer_id,
        JSON.stringify({ mailbox: row.mailbox, messages: res.messages, size }));
    } catch (e) {
      if (part) fs.rmSync(part, { force: true });
      this.db.prepare("UPDATE mail_backups SET status='error', error=?, finished_at=? WHERE id=?")
        .run(String(e.message || e).slice(0, 500), now(), row.id);
      if (!(e instanceof ValidationError)) this.log(`Sicherung ${row.id} (${row.mailbox}) fehlgeschlagen:`, e);
    }
  }

  findDoveadm() {
    if (this.doveadm) return this.doveadm;
    const hit = DOVEADM.find((p) => fs.existsSync(p));
    if (!hit) throw new ValidationError('doveadm wurde nicht gefunden – Wiederherstellen ist nur mit dem Dovecot-Mailserver möglich.');
    return hit;
  }

  // Temporäre Quelle für doveadm: im Domain-Ordner unter /www/vmail, weil doveadm
  // mit den Rechten des Postfach-Benutzers (vmail) liest - die Sicherungs-Ablage
  // ist absichtlich nur für root lesbar. Dovecot beachtet Ordner auf Domain-Ebene nicht.
  restoreTmp(row) {
    const domain = String(row.mailbox).split('@').pop();
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.')) throw new ValidationError('Ungültige Postfach-Adresse.');
    return path.join(this.vmailRoot, domain, `.cm-restore-${row.id}`);
  }

  async runRestore(row) {
    this.db.prepare("UPDATE mail_backups SET restore_status='running', restore_error='' WHERE id=?").run(row.id);
    let tmp = null;
    try {
      if (!this.store.isAssigned(row.customer_id, 'mailbox', row.mailbox)) throw new ValidationError('Das Postfach ist nicht mehr zugeordnet.');
      const doveadm = this.findDoveadm();
      const target = maildir.mailboxDir(row.mailbox, this.vmailRoot);
      tmp = this.restoreTmp(row);
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const res = await maildir.extractToMaildir(this.filePath(row), path.join(tmp, 'Maildir'));
      // doveadm liest die Quelle mit den Rechten des Postfach-Benutzers (vmail)
      const st = fs.statSync(target);
      chownTree(tmp, st.uid, st.gid);
      const folder = `Wiederhergestellt-${stamp(row.created_at)}`;
      const out = await run(doveadm, ['import', '-s', '-u', row.mailbox, `maildir:${path.join(tmp, 'Maildir')}`, folder, 'all'])
        .catch((e) => { throw new Error(`doveadm import: ${e.message}`); });
      // doveadm meldet z. B. fehlende Leserechte nicht immer als Fehler - Ergebnis nachzählen
      const found = await run(doveadm, ['search', '-u', row.mailbox, 'mailbox', `${folder}*`, 'all']).catch(() => null);
      if (found !== null) {
        const n = String(found).split('\n').filter((l) => l.trim()).length;
        if (n < res.messages) throw new Error(`doveadm hat nur ${n} von ${res.messages} Nachrichten übernommen. ${String(out || '').trim()}`.trim());
      }
      this.db
        .prepare("UPDATE mail_backups SET restore_status='done', restore_folder=?, restored_at=? WHERE id=?")
        .run(folder, now(), row.id);
      this.store.log('portal_mail_restore', row.customer_id, JSON.stringify({ mailbox: row.mailbox, folder, messages: res.messages }));
    } catch (e) {
      this.db.prepare("UPDATE mail_backups SET restore_status='error', restore_error=? WHERE id=?")
        .run(String(e.message || e).slice(0, 500), row.id);
      if (!(e instanceof ValidationError)) this.log(`Wiederherstellung ${row.id} (${row.mailbox}) fehlgeschlagen:`, e);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------ Zeitplan/Aufräumen
  // Nach einem Neustart: abgebrochene Aufträge erneut einreihen, Reste löschen
  recover() {
    for (const r of this.db.prepare("SELECT * FROM mail_backups WHERE restore_status='running'").all()) {
      try {
        fs.rmSync(this.restoreTmp(r), { recursive: true, force: true });
      } catch (e) {
        // ungültige Adresse - nichts aufzuräumen
      }
    }
    this.db.prepare("UPDATE mail_backups SET status='queued' WHERE status='running'").run();
    this.db.prepare("UPDATE mail_backups SET restore_status='queued' WHERE restore_status='running'").run();
    let root;
    try {
      root = backupRoot(this.loadCfg());
    } catch (e) {
      return;
    }
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch (e) {
      return;
    }
    for (const d of dirs) {
      const full = path.join(root, d);
      let names = [];
      try {
        names = fs.readdirSync(full);
      } catch (e) {
        continue;
      }
      for (const n of names) {
        if (n.endsWith('.part')) fs.rmSync(path.join(full, n), { recursive: true, force: true });
      }
    }
  }

  // Automatische Sicherungen einreihen (einmal täglich ab der eingestellten Stunde)
  schedule(ts) {
    const t = ts || now();
    const cfg = this.loadCfg();
    const hour = Number.isInteger(Number(cfg.mail_backup_hour)) ? Number(cfg.mail_backup_hour) : 3;
    if (new Date(t * 1000).getHours() < hour) return 0;
    const today = startOfDay(t);
    let queued = 0;
    const customers = this.db.prepare("SELECT * FROM customers WHERE status='active'").all();
    for (const c of customers) {
      const lim = this.limitsFor(c);
      if (!lim.mail_backup || !lim.mail_backup_days) continue;
      for (const a of this.store.assignments(c.id).filter((x) => x.type === 'mailbox')) {
        const has = this.db
          .prepare("SELECT 1 FROM mail_backups WHERE customer_id=? AND mailbox=? AND kind='auto' AND created_at>=?")
          .get(c.id, a.ref_name, today);
        if (has) continue;
        this.db
          .prepare("INSERT INTO mail_backups (customer_id, mailbox, kind, status, created_at) VALUES (?,?, 'auto', 'queued', ?)")
          .run(c.id, a.ref_name, t);
        queued++;
      }
    }
    if (queued) this.kick();
    return queued;
  }

  // Aufbewahrung durchsetzen und verwaiste Sicherungen entfernen
  prune(ts) {
    const t = ts || now();
    const rows = this.db.prepare("SELECT * FROM mail_backups WHERE status IN ('done','error')").all();
    const customers = new Map();
    const manualSeen = new Map();
    const doomed = [];
    // neueste zuerst, damit "die letzten N behalten" einfach zu zählen ist
    rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    for (const r of rows) {
      if (r.restore_status === 'running' || r.restore_status === 'queued') continue;
      if (!customers.has(r.customer_id)) customers.set(r.customer_id, this.store.getCustomer(r.customer_id));
      const c = customers.get(r.customer_id);
      const age = t - r.created_at;
      // Kunde gelöscht oder Postfach nicht mehr zugeordnet: Daten nicht aufheben
      if (!c || !this.store.isAssigned(r.customer_id, 'mailbox', r.mailbox)) {
        doomed.push(r);
        continue;
      }
      if (r.status === 'error') {
        if (age > ERROR_KEEP_DAYS * DAY) doomed.push(r);
        continue;
      }
      if (r.kind === 'auto') {
        const days = this.limitsFor(c).mail_backup_days || AUTO_GRACE_DAYS;
        // +1 Stunde Spielraum, damit die Sicherung von vor genau N Tagen den Lauf überlebt
        if (age > days * DAY + 3600) doomed.push(r);
      } else {
        const key = `${r.customer_id}\u0000${r.mailbox}`;
        const n = (manualSeen.get(key) || 0) + 1;
        manualSeen.set(key, n);
        if (n > MANUAL_KEEP || age > MANUAL_MAX_DAYS * DAY) doomed.push(r);
      }
    }
    for (const r of doomed) this.drop(r);
    return doomed.length;
  }

  tick() {
    try {
      this.prune();
      this.schedule();
    } catch (e) {
      this.log(e);
    }
  }

  start(intervalMs) {
    this.recover();
    this.kick();
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs || 10 * 60 * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { MailBackups, backupRoot, stamp };
