'use strict';
// aaPanel-API-Client (Node-Port von cm_api.py).
// Signatur: request_token = md5(request_time + md5(api_key)).
// Alle HTTP-Aufrufe sind hier zwangsläufig async (anders als im synchronen
// Python-Original mit requests) - zieht sich bis in die Express-Routen durch.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const PANEL = '/www/server/panel';

function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function detectBaseUrl() {
  let port = '7800';
  try {
    port = fs.readFileSync(PANEL + '/data/port.pl', 'utf8').trim();
  } catch (e) {
    // Default beibehalten, wie in cm_api.py
  }
  const proto = fs.existsSync(PANEL + '/data/ssl.pl') ? 'https' : 'http';
  return `${proto}://127.0.0.1:${port}`;
}

function panelApiStatus() {
  const info = { exists: false, open: false, localhost_allowed: false, limit_addr: [] };
  try {
    const cfg = JSON.parse(fs.readFileSync(PANEL + '/config/api.json', 'utf8'));
    info.exists = true;
    info.open = !!cfg.open;
    const addrs = cfg.limit_addr || [];
    info.limit_addr = addrs;
    const wild = ['*', 'all', '0.0.0.0', '0.0.0.0/0'];
    info.localhost_allowed = addrs.some((a) => wild.includes(a) || String(a).startsWith('127.'));
  } catch (e) {
    // Datei fehlt/ungültig -> Defaults, wie in cm_api.py
  }
  return info;
}

class ApiError extends Error {}

class PanelApi {
  constructor(apiKey, baseUrl, timeout) {
    if (!apiKey) throw new ApiError('Kein API-Key hinterlegt (Einstellungen)');
    this.keyMd5 = md5(String(apiKey).trim());
    this.base = (baseUrl || detectBaseUrl()).replace(/\/+$/, '');
    this.timeout = timeout || 30000;
  }

  raw(path, params) {
    return new Promise((resolve, reject) => {
      const now = String(Math.floor(Date.now() / 1000));
      const body = new URLSearchParams(Object.assign({}, params || {}));
      body.set('request_time', now);
      body.set('request_token', md5(now + this.keyMd5));
      const bodyStr = body.toString();

      let url;
      try {
        url = new URL(this.base + (path.startsWith('/') ? path : '/' + path));
      } catch (e) {
        return reject(new ApiError(`Ungültige URL: ${e.message}`));
      }
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(bodyStr),
          },
          timeout: this.timeout,
          rejectUnauthorized: false, // selbstsigniertes 127.0.0.1-Zertifikat, wie s.verify=False in cm_api.py
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            let data;
            try {
              data = JSON.parse(text);
            } catch (e) {
              if (text.slice(0, 500).toLowerCase().includes('<html')) {
                return reject(new ApiError(`Panel lieferte HTML statt JSON (HTTP ${res.statusCode}). API aktiv? Pfad korrekt?`));
              }
              return resolve(text);
            }
            if (data && typeof data === 'object' && data.status === false) {
              const msg = String(data.msg || '');
              if (msg.includes('verification') || msg.includes('IP validation') || msg.includes('prohibited')) {
                return reject(new ApiError('API-Authentifizierung: ' + msg));
              }
            }
            resolve(data);
          });
        }
      );
      req.on('timeout', () => req.destroy(new ApiError(`Verbindung zu ${this.base} fehlgeschlagen: Timeout`)));
      req.on('error', (e) => reject(new ApiError(`Verbindung zu ${this.base} fehlgeschlagen: ${e.message}`)));
      req.write(bodyStr);
      req.end();
    });
  }

  _expectOk(data) {
    if (data && typeof data === 'object' && data.status === false) {
      throw new ApiError(String(data.msg || 'Aktion fehlgeschlagen'));
    }
    return data;
  }

  static unwrap(data) {
    if (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      'message' in data &&
      [0, -1, 1].includes(data.status) &&
      typeof data.message !== 'string'
    ) {
      return data.message;
    }
    if (data && typeof data === 'object' && data.status === -1) {
      throw new ApiError(String(data.message));
    }
    return data;
  }

  static findRows(data) {
    data = PanelApi.unwrap(data);
    if (Array.isArray(data)) {
      return data.filter((x) => x && typeof x === 'object');
    }
    if (data && typeof data === 'object') {
      for (const k of ['data', 'list', 'rows', 'items']) {
        const v = data[k];
        if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object');
        if (v && typeof v === 'object') {
          const sub = PanelApi.findRows(v);
          if (sub.length) return sub;
        }
      }
      for (const v of Object.values(data)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
      }
      if (data.status === false) throw new ApiError(String(data.msg || 'Unbekannter Fehler'));
    }
    return [];
  }

  async listSites(dataPath, projectTypes) {
    const seen = new Set();
    const out = [];
    const errors = [];
    const queries = [null, ...(projectTypes || []).filter(Boolean)];
    for (const pt of queries) {
      const p = { table: 'sites', p: 1, limit: 1000, search: '', type: -1, order: '' };
      if (pt) p.project_type = pt;
      let rows;
      try {
        rows = PanelApi.findRows(await this.raw(dataPath + '?action=getData', p));
      } catch (e) {
        if (pt === null) throw e;
        errors.push(`${pt}: ${e.message}`);
        continue;
      }
      for (const r of rows) {
        const sid = r.id;
        if (seen.has(sid)) continue;
        seen.add(sid);
        out.push({
          id: sid,
          name: r.name || '',
          path: r.path || '',
          status: String(r.status || ''),
          project_type: r.project_type || pt || 'PHP',
          ps: r.ps || '',
          edate: r.edate || '',
          ssl: r.ssl,
        });
      }
    }
    return [out, errors];
  }

  async siteStart(siteId, name) {
    return this._expectOk(await this.raw('/site?action=SiteStart', { id: siteId, name }));
  }

  async siteStop(siteId, name) {
    return this._expectOk(await this.raw('/site?action=SiteStop', { id: siteId, name }));
  }

  async _mailCall(pluginPaths, method, params) {
    let last = null;
    for (const pp of pluginPaths) {
      const p = Object.assign({ name: 'mail_sys', s: method }, params || {});
      try {
        return [PanelApi.findRows(await this.raw(pp + '?action=a', p)), pp];
      } catch (e) {
        last = e;
      }
    }
    throw last || new ApiError('Kein Plugin-Pfad konfiguriert');
  }

  async _mailWriteCall(pluginPaths, method, params) {
    let last = null;
    for (const pp of pluginPaths) {
      const p = Object.assign({ name: 'mail_sys', s: method }, params || {});
      try {
        return [this._expectOk(await this.raw(pp + '?action=a', p)), pp];
      } catch (e) {
        last = e;
      }
    }
    throw last || new ApiError('Kein Plugin-Pfad konfiguriert');
  }

  // quota im Format "Zahl Einheit" (z. B. "1024 MB") - add_mailbox_v2/update_mailbox_v2
  // parsen das serverseitig per str.split(), ein reiner Byte-Wert schlägt fehl.
  async mailBoxCreate(pluginPaths, method, domain, username, password, quota, fullName) {
    if (!method) throw new ApiError('Mailbox-Erstellung ist nicht konfiguriert (Einstellungen → Mailserver)');
    const [res] = await this._mailWriteCall(pluginPaths, method,
      { domain, username, password, quota, full_name: fullName });
    return res;
  }

  // update_mailbox_v2 überschreibt offenbar den kompletten Datensatz - active/is_admin
  // müssen deshalb mitgeschickt werden, sonst würden sie zurückgesetzt.
  async mailBoxSetPassword(pluginPaths, method, domain, username, password, quota, fullName, active, isAdmin) {
    if (!method) throw new ApiError('Postfach-Passwortänderung ist nicht konfiguriert (Einstellungen → Mailserver)');
    const [res] = await this._mailWriteCall(pluginPaths, method, {
      domain, username, password, quota, full_name: fullName,
      active: active === undefined ? 1 : active,
      is_admin: isAdmin === undefined ? 0 : isAdmin,
    });
    return res;
  }

  async mailBoxDelete(pluginPaths, method, domain, username) {
    if (!method) throw new ApiError('Postfach-Löschung ist nicht konfiguriert (Einstellungen → Mailserver)');
    const [res] = await this._mailWriteCall(pluginPaths, method, { domain, username });
    return res;
  }

  async listMailDomains(pluginPaths, method) {
    const [rows, used] = await this._mailCall(pluginPaths, method, { p: 1, size: 1000, limit: 1000 });
    const out = [];
    for (const r of rows) {
      const d = r.domain || r.name;
      if (d) out.push({ domain: d, active: r.active === undefined ? 1 : r.active, created: r.created || '' });
    }
    return [out, used];
  }

  async listMailboxes(pluginPaths, method, domain) {
    const [rows, used] = await this._mailCall(pluginPaths, method, { domain, p: 1, size: 1000, limit: 1000 });
    const out = [];
    for (const r of rows) {
      const u = r.username || r.email || r.mailbox;
      if (u) {
        out.push({
          username: u,
          domain: r.domain || domain,
          full_name: r.full_name || '',
          quota: r.quota || '',
          active: r.active === undefined ? 1 : r.active,
        });
      }
    }
    return [out, used];
  }
}

module.exports = { PanelApi, ApiError, detectBaseUrl, panelApiStatus, md5 };
