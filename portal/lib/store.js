'use strict';
// SQLite-Zugriff für das Node-Portal. Schema MUSS mit cm_store.py's SCHEMA
// übereinstimmen, da beide Prozesse dieselbe .db-Datei teilen. Nur die vom
// Portal tatsächlich benötigten Store-Methoden sind hier portiert - Admin-
// only Logik (saveCustomer/listCustomers/ownerMap) bleibt reines Python.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.CM_DATA_DIR || '/www/server/panel/data/customer_mgr';
const DB_FILE = path.join(DATA_DIR, 'customer_mgr.db');
const CFG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULT_CFG = {
  api_key: '',
  base_url: '',
  data_path: '/v2/data',
  site_project_types: 'Node,Proxy,Python,Go,Java,WP2',
  mail_plugin_paths: '/v2/plugin,/plugin',
  mail_domains_method: 'get_domains',
  mail_boxes_method: 'get_mailboxs',
  mail_box_create_method: '',
  mail_box_setpw_method: '',
  mail_box_delete_method: '',
  mail_box_default_quota: '1024 MB',
  mail_db_fallback: true,
  customer_prefix: 'K-',
  portal_secret_key: '',
};

const PBKDF2_ITERATIONS = 600000; // muss mit cm_store.py übereinstimmen (Cross-Language-Hash-Kompatibilität)

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
    const iterations = parseInt(parts[1], 10);
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    const dk = crypto.pbkdf2Sync(password, salt, iterations, expected.length, 'sha256');
    if (dk.length !== expected.length) return false;
    return crypto.timingSafeEqual(dk, expected);
  } catch (e) {
    return false;
  }
}

// 1:1 aus cm_store.py's SCHEMA übernommen - nicht unabhängig voneinander ändern.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_no TEXT UNIQUE,
  company TEXT DEFAULT '', first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
  email TEXT DEFAULT '', phone TEXT DEFAULT '',
  street TEXT DEFAULT '', zip TEXT DEFAULT '', city TEXT DEFAULT '', country TEXT DEFAULT '',
  vat_id TEXT DEFAULT '', note TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  portal_enabled INTEGER NOT NULL DEFAULT 0,
  portal_password_hash TEXT NOT NULL DEFAULT '',
  portal_password_set_at INTEGER NOT NULL DEFAULT 0,
  portal_last_login INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  ref_id TEXT DEFAULT '',
  created_at INTEGER,
  UNIQUE(type, ref_name)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, action TEXT, customer_id INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS portal_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL, success INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_asg_customer ON assignments(customer_id);
CREATE INDEX IF NOT EXISTS idx_log_customer ON audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts_login ON portal_login_attempts(login, ts);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON portal_login_attempts(ip, ts);
`;

const MIGRATIONS = [
  ['customers', 'portal_enabled', "INTEGER NOT NULL DEFAULT 0"],
  ['customers', 'portal_password_hash', "TEXT NOT NULL DEFAULT ''"],
  ['customers', 'portal_password_set_at', "INTEGER NOT NULL DEFAULT 0"],
  ['customers', 'portal_last_login', "INTEGER NOT NULL DEFAULT 0"],
];

function columnExists(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
}

function migrate(db) {
  for (const [table, col, decl] of MIGRATIONS) {
    if (!columnExists(db, table, col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
}

function loadCfg() {
  ensureDir(DATA_DIR);
  const cfg = Object.assign({}, DEFAULT_CFG);
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')));
  } catch (e) {
    // Datei fehlt oder ist ungültig -> Defaults verwenden, wie in cm_store.py
  }
  return cfg;
}

function saveCfg(cfg) {
  ensureDir(DATA_DIR);
  const tmp = CFG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, CFG_FILE);
}

const SECRET_FIELDS = ['portal_password_hash'];
function stripSecrets(row) {
  if (!row) return row;
  const d = Object.assign({}, row);
  for (const k of SECRET_FIELDS) delete d[k];
  return d;
}

class Store {
  constructor(dbFile) {
    const file = dbFile || DB_FILE;
    if (file === DB_FILE) ensureDir(DATA_DIR);
    this.db = new Database(file);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    migrate(this.db);
    try {
      fs.chmodSync(file, 0o600);
    } catch (e) {
      // z. B. keine Rechte - wie in cm_store.py bewusst ignoriert
    }
  }

  close() {
    try {
      this.db.close();
    } catch (e) {
      // ignorieren, wie in cm_store.py
    }
  }

  getCustomer(cid) {
    const r = this.db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
    return r ? stripSecrets(r) : null;
  }

  getPortalCustomer(login) {
    const l = String(login || '').trim();
    if (!l) return null;
    const r = this.db
      .prepare("SELECT * FROM customers WHERE customer_no=? COLLATE NOCASE AND portal_enabled=1")
      .get(l);
    return r || null;
  }

  touchPortalLogin(cid) {
    this.db.prepare('UPDATE customers SET portal_last_login=? WHERE id=?').run(Math.floor(Date.now() / 1000), cid);
  }

  recordLoginAttempt(login, ip, success) {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare('INSERT INTO portal_login_attempts (login, ip, ts, success) VALUES (?,?,?,?)')
      .run(String(login || '').trim().toLowerCase(), String(ip || ''), now, success ? 1 : 0);
    this.db.prepare('DELETE FROM portal_login_attempts WHERE ts < ?').run(now - 86400);
  }

  loginAttemptsCount(login, ip, windowSeconds) {
    const since = Math.floor(Date.now() / 1000) - windowSeconds;
    const byLogin = this.db
      .prepare('SELECT COUNT(*) AS n FROM portal_login_attempts WHERE login=? AND success=0 AND ts>=?')
      .get(String(login || '').trim().toLowerCase(), since).n;
    const byIp = this.db
      .prepare('SELECT COUNT(*) AS n FROM portal_login_attempts WHERE ip=? AND success=0 AND ts>=?')
      .get(String(ip || ''), since).n;
    return [byLogin, byIp];
  }

  isAssigned(cid, type, refName) {
    const row = this.db
      .prepare('SELECT 1 FROM assignments WHERE customer_id=? AND type=? AND ref_name=?')
      .get(cid, type, String(refName || '').trim().toLowerCase());
    return !!row;
  }

  assignments(cid) {
    if (cid === undefined || cid === null) {
      return this.db.prepare('SELECT * FROM assignments').all();
    }
    return this.db.prepare('SELECT * FROM assignments WHERE customer_id=? ORDER BY type, ref_name').all(cid);
  }

  getAssignment(aid) {
    return this.db.prepare('SELECT * FROM assignments WHERE id=?').get(aid) || null;
  }

  assign(cid, items) {
    const TYPES = ['site', 'mail_domain', 'mailbox'];
    if (!this.getCustomer(cid)) throw new Error('Kunde nicht gefunden');
    const now = Math.floor(Date.now() / 1000);
    const added = [];
    const skipped = [];
    for (const it of items) {
      const t = it.type;
      const name = String(it.ref_name || '').trim().toLowerCase();
      if (!TYPES.includes(t) || !name) continue;
      const row = this.db.prepare('SELECT customer_id FROM assignments WHERE type=? AND ref_name=?').get(t, name);
      if (row) {
        skipped.push({ type: t, ref_name: name, owner: row.customer_id });
        continue;
      }
      this.db
        .prepare('INSERT INTO assignments (customer_id, type, ref_name, ref_id, created_at) VALUES (?,?,?,?,?)')
        .run(cid, t, name, String(it.ref_id || ''), now);
      added.push({ type: t, ref_name: name });
    }
    if (added.length) this.log('assign', cid, JSON.stringify(added));
    return [added, skipped];
  }

  unassign(aid) {
    const r = this.db.prepare('SELECT * FROM assignments WHERE id=?').get(aid);
    if (!r) throw new Error('Zuordnung nicht gefunden');
    this.db.prepare('DELETE FROM assignments WHERE id=?').run(aid);
    this.log('unassign', r.customer_id, `${r.type}: ${r.ref_name}`);
    return r;
  }

  log(action, cid, detail) {
    this.db
      .prepare('INSERT INTO audit_log (ts, action, customer_id, detail) VALUES (?,?,?,?)')
      .run(Math.floor(Date.now() / 1000), action, cid, detail || '');
  }
}

module.exports = { Store, loadCfg, saveCfg, hashPassword, verifyPassword, DB_FILE, CFG_FILE, DATA_DIR };
