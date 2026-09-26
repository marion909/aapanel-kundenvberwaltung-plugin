'use strict';
// Async-Port von cm_resources.py. Nur vom Node-Portal genutzt - das Python-
// Admin-Plugin hat sein eigenes, unabhängiges cm_resources.py.
const fs = require('fs');
const Database = require('better-sqlite3');
const { PanelApi, ApiError } = require('./api');

const MAIL_DB = '/www/vmail/postfixadmin.db';
const DEFAULT_CACHE_TTL = 60000; // ms

function split(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function makeApi(cfg) {
  return new PanelApi(cfg.api_key || '', cfg.base_url || null);
}

function mailPluginPaths(cfg) {
  return split(cfg.mail_plugin_paths).length ? split(cfg.mail_plugin_paths) : ['/v2/plugin', '/plugin'];
}

async function fetchSites(api, cfg, warnings) {
  const paths = [cfg.data_path || '/v2/data'];
  for (const p of ['/v2/data', '/data']) if (!paths.includes(p)) paths.push(p);
  let last = null;
  for (const p of paths) {
    try {
      const [sites, errs] = await api.listSites(p, split(cfg.site_project_types));
      for (const e of errs) warnings.push('Projekttyp übersprungen – ' + e);
      return [sites, 'API ' + p];
    } catch (e) {
      last = e;
      if (String(e.message).includes('Authentifizierung')) break;
    }
  }
  throw new ApiError(`Websites konnten nicht geladen werden: ${last}`);
}

function mailDbRows(sql) {
  const db = new Database(MAIL_DB, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

async function fetchMail(api, cfg, warnings) {
  if (!fs.existsSync('/www/server/panel/plugin/mail_sys') && !fs.existsSync(MAIL_DB)) {
    return [[], [], 'nicht installiert'];
  }
  const paths = mailPluginPaths(cfg);
  try {
    const [domains, used] = await api.listMailDomains(paths, cfg.mail_domains_method || 'get_domains');
    const boxes = [];
    for (const d of domains) {
      const [rows] = await api.listMailboxes([used], cfg.mail_boxes_method || 'get_mailboxs', d.domain);
      boxes.push(...rows);
    }
    return [domains, boxes, 'API ' + used];
  } catch (e) {
    if (!(cfg.mail_db_fallback && fs.existsSync(MAIL_DB))) {
      throw new ApiError(`Mailserver-Daten konnten nicht geladen werden: ${e}`);
    }
    warnings.push(`Mail-API fehlgeschlagen (${e}), lese Mailserver-Datenbank (nur lesend).`);
  }
  const domains = mailDbRows('SELECT * FROM domain').map((r) => ({
    domain: r.domain,
    active: r.active === undefined ? 1 : r.active,
    created: r.created || '',
  }));
  const boxes = mailDbRows('SELECT * FROM mailbox').map((r) => ({
    username: r.username,
    domain: r.domain || '',
    full_name: r.full_name || '',
    quota: r.quota || '',
    active: r.active === undefined ? 1 : r.active,
  }));
  return [domains, boxes, 'Datenbank (Fallback)'];
}

async function loadResources(cfg, api) {
  api = api || makeApi(cfg);
  const warnings = [];
  const [sites, siteSrc] = await fetchSites(api, cfg, warnings);
  let domains = [];
  let boxes = [];
  let mailSrc = 'Fehler';
  try {
    [domains, boxes, mailSrc] = await fetchMail(api, cfg, warnings);
  } catch (e) {
    warnings.push(String(e.message || e));
  }
  for (const s of sites) s.name = String(s.name).toLowerCase();
  for (const d of domains) d.domain = String(d.domain).toLowerCase();
  for (const b of boxes) {
    b.username = String(b.username).toLowerCase();
    b.domain = String(b.domain || b.username.split('@').pop()).toLowerCase();
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fetchedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return {
    sites,
    mail_domains: domains,
    mailboxes: boxes,
    sources: { sites: siteSrc, mail: mailSrc },
    warnings,
    fetched_at: fetchedAt,
  };
}

function indexResources(res) {
  const idx = new Map();
  for (const s of res.sites) idx.set(`site\u0000${s.name}`, s);
  for (const d of res.mail_domains) idx.set(`mail_domain\u0000${d.domain}`, d);
  for (const b of res.mailboxes) idx.set(`mailbox\u0000${b.username}`, b);
  return idx;
}

function annotateAssignments(assignments, idx) {
  for (const a of assignments) {
    if (a.type === 'domain') {
      // Domain-Bereiche sind keine Panel-Ressource - es gibt nichts abzugleichen
      a.state = 'ok';
      a.info = {};
      continue;
    }
    if (idx === null || idx === undefined) {
      a.state = 'unknown';
      a.info = {};
      continue;
    }
    const info = idx.get(`${a.type}\u0000${a.ref_name}`);
    a.state = info ? 'ok' : 'missing';
    a.info = info || {};
  }
  return assignments;
}

class ResourceCache {
  // loadFn ist injizierbar (statt fest an loadResources gebunden), damit sich
  // das TTL-/Invalidierungsverhalten ohne echten Netzwerkzugriff testen lässt.
  constructor(ttl, loadFn) {
    this.ttl = ttl || DEFAULT_CACHE_TTL;
    this.loadFn = loadFn || loadResources;
    this.ts = 0;
    this.data = null;
  }

  async get(cfg, refresh) {
    const now = Date.now();
    if (!refresh && this.data && now - this.ts < this.ttl) return this.data;
    this.data = await this.loadFn(cfg);
    this.ts = now;
    return this.data;
  }

  invalidate() {
    this.ts = 0;
    this.data = null;
  }
}

module.exports = {
  MAIL_DB,
  split,
  makeApi,
  mailPluginPaths,
  fetchSites,
  fetchMail,
  loadResources,
  indexResources,
  annotateAssignments,
  ResourceCache,
};
