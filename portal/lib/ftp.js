'use strict';
// FTP-Zugänge für das Kundenportal.
//
// Ein Kunde darf FTP-Konten nur für seine eigenen Websites anlegen; das
// Verzeichnis des Kontos liegt immer innerhalb des Website-Verzeichnisses
// (realpath-geprüft, auch gegen Symlinks nach draußen). Pure-FTPd sperrt das
// Konto in aaPanel anschließend in genau dieses Verzeichnis ein.
//
// aaPanel-Endpunkte (aus dem Panel-UI mitgeschnitten):
//   POST /v2/ftp?action=AddUser       ftp_username, ftp_password, path, ps
//   POST /v2/data?action=getData      table=ftps (Liste inkl. Klartext-Passwort!)
//   POST /v2/ftp?action=SetUserPassword  id, ftp_username, new_password
//   POST /v2/ftp?action=SetStatus     id, username, status (0/1)
//   POST /v2/ftp?action=DeleteUser    id, username
// aaPanel reicht Name, Passwort und Pfad an pure-pw in der Shell weiter -
// deshalb sind hier nur unkritische Zeichen erlaubt.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FileManager } = require('./files');
const { ValidationError } = require('./validate');

// wie aaPanel (re.search(r"\W+", name) lehnt ab): nur Buchstaben, Ziffern, Unterstrich
const USER_RE = /^[a-z0-9][a-z0-9_]{2,31}$/;
const PASS_RE = /^[A-Za-z0-9!#%+,./:=?@^_~*-]{8,64}$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]*$/;
const PASS_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generatePassword(len) {
  const n = len || 16;
  const limit = 256 - (256 % PASS_CHARS.length); // ohne Modulo-Verzerrung
  let out = '';
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b < limit && out.length < n) out += PASS_CHARS[b % PASS_CHARS.length];
    }
  }
  return out;
}

function checkUsername(name) {
  const u = String(name || '').trim().toLowerCase();
  if (!USER_RE.test(u)) {
    throw new ValidationError('Benutzername: 3–32 Zeichen, nur Kleinbuchstaben, Ziffern und Unterstrich (Beginn mit Buchstabe oder Ziffer).');
  }
  return u;
}

function checkPassword(pw) {
  const p = String(pw || '');
  if (!PASS_RE.test(p)) {
    throw new ValidationError('Passwort: 8–64 Zeichen aus Buchstaben, Ziffern und ! # % + , . / : = ? @ ^ _ ~ * - (keine Leerzeichen, Anführungszeichen oder $).');
  }
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) throw new ValidationError('Passwort muss Buchstaben und Ziffern enthalten.');
  return p;
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return path.posix.normalize(String(p || ''));
  }
}

function within(p, root) {
  return p === root || p.startsWith(root + '/');
}

class FtpService {
  // svc: SiteService des angemeldeten Kunden (API-Aufrufe, Limits, Journal)
  constructor(svc) {
    this.svc = svc;
  }

  get store() {
    return this.svc.store;
  }

  get customer() {
    return this.svc.customer;
  }

  allowed() {
    return this.svc.limits().ftp_allowed;
  }

  requireAllowed() {
    if (!this.allowed()) throw new ValidationError('FTP-Zugänge sind in Ihrem Paket nicht enthalten.');
  }

  quota() {
    const used = this.store.assignments(this.customer.id).filter((a) => a.type === 'ftp').length;
    return { used, max: this.svc.limits().ftp };
  }

  host(fallback) {
    const cfg = this.svc.cfg;
    return String(cfg.ftp_host || '').trim() || String(cfg.server_ipv4 || '').trim() || fallback || '';
  }

  // Alle FTP-Konten aus aaPanel - Passwörter werden bewusst verworfen.
  // Immer die komplette Liste: aaPanels Suche findet Namen mit "_" nicht
  // (es maskiert "_" als "/_", ESCAPE gilt aber nur für "ps LIKE ?").
  async panelAccounts() {
    const res = await this.svc.call('data', 'getData', { table: 'ftps', p: 1, limit: 10000, search: '' });
    const list = Array.isArray(res) ? res : (res && (res.data || res.list)) || [];
    return list
      .filter((r) => r && r.name)
      .map((r) => ({ id: r.id, name: String(r.name).toLowerCase(), path: String(r.path || ''), status: String(r.status), ps: r.ps || '' }));
  }

  // FTP-Zuordnungen des Kunden mit Live-Daten. state: ok | missing
  async accounts() {
    const asg = this.store.assignments(this.customer.id).filter((a) => a.type === 'ftp');
    if (!asg.length) return [];
    const live = new Map((await this.panelAccounts()).map((r) => [r.name, r]));
    return asg.map((a) => {
      const r = live.get(a.ref_name);
      if (!r || (a.ref_id && String(r.id) !== String(a.ref_id))) return { asg: a, name: a.ref_name, state: 'missing' };
      return { asg: a, name: a.ref_name, state: 'ok', id: r.id, path: r.path, real: realOr(r.path), active: r.status !== '0' };
    });
  }

  // Konten, die im Verzeichnis dieser Website liegen (mit Pfad relativ zur Website)
  async forSite(site) {
    const root = this.svc.siteRoot(site);
    return (await this.accounts())
      .filter((a) => a.state === 'ok' && within(a.real, root))
      .map((a) => Object.assign(a, { rel: '/' + path.posix.relative(root, a.real) }));
  }

  // Zuordnung (bereits auf Besitz geprüft) + Live-Konto, das in der Website liegt
  async resolve(assignment, site) {
    const acc = (await this.forSite(site)).find((a) => a.asg.id === assignment.id);
    if (!acc) throw new ValidationError('Dieser FTP-Zugang gehört nicht zu dieser Website oder existiert nicht mehr.');
    return acc;
  }

  // Zielverzeichnis innerhalb der Website; fehlende Ordner werden angelegt
  directory(site, rel) {
    const root = this.svc.siteRoot(site);
    if (!PATH_RE.test(root)) throw new ValidationError('Das Website-Verzeichnis enthält Zeichen, die für FTP nicht erlaubt sind.');
    const parts = FileManager.cleanParts(rel);
    for (const p of parts) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(p)) throw new ValidationError('Ordnername: nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.');
    }
    const fm = new FileManager(root);
    for (let i = 0; i < parts.length; i++) {
      const parent = '/' + parts.slice(0, i).join('/');
      const full = path.join(root, ...parts.slice(0, i + 1));
      if (!fs.existsSync(full)) fm.mkdir(parent, parts[i]);
    }
    const dir = fm.resolveDir('/' + parts.join('/'));
    if (!PATH_RE.test(dir)) throw new ValidationError('Ungültiges Verzeichnis.');
    return dir;
  }

  async create(site, { username, password, dir }) {
    this.requireAllowed();
    const q = this.quota();
    if (q.max && q.used >= q.max) throw new ValidationError(`FTP-Limit Ihres Pakets erreicht (${q.used} von ${q.max}).`);
    const user = checkUsername(username);
    const generated = !String(password || '');
    const pw = generated ? generatePassword(16) : checkPassword(password);
    if (this.store.db.prepare("SELECT 1 FROM assignments WHERE type='ftp' AND ref_name=?").get(user)) {
      throw new ValidationError(`Der Benutzername „${user}“ ist bereits vergeben.`);
    }
    if ((await this.panelAccounts()).some((r) => r.name === user)) {
      throw new ValidationError(`Der Benutzername „${user}“ ist bereits vergeben.`);
    }
    const target = this.directory(site, dir);
    await this.svc.call('ftp', 'AddUser', { ftp_username: user, ftp_password: pw, path: target, ps: site.name });
    const row = (await this.panelAccounts()).find((r) => r.name === user);
    if (!row) throw new ValidationError(`aaPanel hat das Anlegen bestätigt, das Konto „${user}“ taucht aber nicht in der FTP-Liste auf. Bitte den Administrator prüfen lassen.`);
    this.store.assign(this.customer.id, [{ type: 'ftp', ref_name: user, ref_id: String(row.id) }]);
    this.svc.log('ftp_create', { site: site.name, user, path: target });
    return { user, path: target, password: generated ? pw : null };
  }

  async setPassword(acc, password) {
    this.requireAllowed();
    const generated = !String(password || '');
    const pw = generated ? generatePassword(16) : checkPassword(password);
    await this.svc.call('ftp', 'SetUserPassword', { id: acc.id, ftp_username: acc.name, new_password: pw });
    this.svc.log('ftp_password', { user: acc.name });
    return generated ? pw : null;
  }

  async setActive(acc, active) {
    await this.svc.call('ftp', 'SetStatus', { id: acc.id, username: acc.name, status: active ? 1 : 0 });
    this.svc.log(active ? 'ftp_enable' : 'ftp_disable', { user: acc.name });
  }

  async remove(acc) {
    await this.svc.call('ftp', 'DeleteUser', { id: acc.id, username: acc.name });
    this.store.unassign(acc.asg.id);
    this.svc.log('ftp_delete', { user: acc.name });
  }
}

module.exports = { FtpService, generatePassword, checkUsername, checkPassword };
