'use strict';
// Website-Verwaltung für das Kundenportal.
//
// Jede Aktion prüft zuerst, ob die Website dem Kunden zugeordnet ist
// (assignments.type='site'), bzw. ob neue Hostnamen innerhalb eines seiner
// Domain-Bereiche (assignments.type='domain') liegen. Ausgeführt wird alles
// über die aaPanel-API (dieselben Aktionen, die das Panel-UI nutzt:
// AddSite, DeleteSite, AddDomain, SetPHPVersion, GetSSL, CreateRedirect, ...).
const fs = require('fs');
const path = require('path');
const { ApiError, PanelApi } = require('./api');
const cloudflare = require('./cloudflare');
const v = require('./validate');

const { ValidationError } = v;
const PANEL = '/www/server/panel';
const FORBIDDEN_ROOTS = ['/', '/www', '/www/wwwroot', '/root', '/etc', '/home', '/usr', '/var', '/boot', '/mnt', '/opt', '/srv', '/tmp'];

// Merkt sich pro Modul (site, data, acme, ...), welches API-Präfix funktioniert.
const workingPrefix = new Map();

function prefixes(cfg) {
  const list = String(cfg.site_api_prefixes == null ? '/v2,' : cfg.site_api_prefixes)
    .split(',')
    .map((x) => x.trim().replace(/\/+$/, ''));
  return list.length ? list : ['/v2', ''];
}

function msgOf(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') {
    for (const k of ['msg', 'result', 'message', 'error_msg']) {
      if (x[k]) return typeof x[k] === 'string' ? x[k] : JSON.stringify(x[k]);
    }
  }
  return JSON.stringify(x);
}

// v2: {status:0, timestamp, message:X} -> X ; {status:-1, message:{result:'..'}} -> Fehler
// v1: X direkt, Fehler als {status:false, msg:'..'}
function unwrapResult(data) {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'message' in data &&
      typeof data.status === 'number') {
    if (data.status !== 0) throw new ApiError(msgOf(data.message) || 'Aktion fehlgeschlagen');
    return data.message;
  }
  if (data && typeof data === 'object' && data.status === false) {
    throw new ApiError(msgOf(data) || 'Aktion fehlgeschlagen');
  }
  return data;
}

function rows(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['data', 'list', 'rows']) if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

async function panelCall(api, cfg, module, action, params) {
  const list = prefixes(cfg);
  const known = workingPrefix.get(module);
  const order = known !== undefined ? [known, ...list.filter((p) => p !== known)] : list;
  let last = null;
  for (const pre of order) {
    let data;
    try {
      data = await api.raw(`${pre}/${module}?action=${action}`, params || {});
    } catch (e) {
      // Nur "Endpunkt existiert nicht" (HTML-Antwort) führt zum nächsten Präfix
      if (e instanceof ApiError && /HTML statt JSON/.test(e.message)) {
        last = e;
        continue;
      }
      throw e;
    }
    if (typeof data === 'string') {
      last = new ApiError(`Unerwartete Antwort von ${pre}/${module}: ${data.slice(0, 120)}`);
      continue;
    }
    workingPrefix.set(module, pre);
    return unwrapResult(data);
  }
  throw last || new ApiError('Kein API-Präfix konfiguriert');
}

function webserver() {
  if (fs.existsSync('/www/server/nginx/sbin/nginx')) return 'nginx';
  if (fs.existsSync('/www/server/apache/bin/httpd')) return 'apache';
  if (fs.existsSync('/usr/local/lsws/bin/lswsctrl')) return 'openlitespeed';
  return 'nginx';
}

function sitePathFor(cfg, host, domain, customerNo) {
  const tpl = String(cfg.site_path_template || '/www/wwwroot/{host}');
  const no = String(customerNo || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!tpl.includes('{host}') || !tpl.startsWith('/')) throw new ValidationError('Pfad-Vorlage für Websites ist ungültig (Admin-Einstellungen).');
  const p = path.posix.normalize(tpl.split('{host}').join(host).split('{domain}').join(domain).split('{customer_no}').join(no));
  if (!p.startsWith('/') || p.includes('{') || FORBIDDEN_ROOTS.includes(p) || p.startsWith('/www/server/') || p.split('/').includes('..')) {
    throw new ValidationError(`Ungültiger Website-Pfad: ${p}`);
  }
  return p;
}

class SiteService {
  constructor({ cfg, store, customer, api, ip }) {
    this.cfg = cfg;
    this.store = store;
    this.customer = customer;
    this._api = api || null;
    this.ip = ip || '';
  }

  // erst bei Bedarf erzeugen: PanelApi wirft ohne API-Key, Seiten sollen trotzdem rendern
  get api() {
    if (!this._api) this._api = new PanelApi(this.cfg.api_key || '', this.cfg.base_url || null, 120000);
    return this._api;
  }

  call(module, action, params) {
    return panelCall(this.api, this.cfg, module, action, params);
  }

  log(action, detail) {
    this.store.log('portal_' + action, this.customer.id, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  domainAreas() {
    return this.store.domains(this.customer.id).map((d) => d.ref_name);
  }

  checkHost(host) {
    const h = v.normalizeHostname(host);
    if (!v.domainOwner(h, this.domainAreas())) throw new ValidationError(`${h} liegt nicht in Ihrem Domain-Bereich.`);
    return h;
  }

  limits() {
    if (!this._limits) {
      const { effectiveLimits } = require('./packages');
      this._limits = effectiveLimits(this.customer, this.store.getPackage(this.customer.package_id), this.cfg);
    }
    return this._limits;
  }

  maxSites() {
    return this.limits().site;
  }

  requireSsl() {
    if (!this.limits().ssl) throw new ValidationError('SSL-Zertifikate werden in Ihrem Paket vom Administrator verwaltet.');
  }

  quota() {
    const count = this.store.assignments(this.customer.id).filter((a) => a.type === 'site').length;
    return { sites: count, max: this.maxSites() };
  }

  // ------------------------------------------------------------ Panel-Daten
  async findSite(name) {
    const res = await this.call('data', 'getData', { table: 'sites', p: 1, limit: 100, search: name, type: -1, order: '' });
    return rows(res).find((s) => String(s.name).toLowerCase() === String(name).toLowerCase()) || null;
  }

  // Website zu einer (bereits auf Besitz geprüften) Zuordnung laden
  async resolve(assignment) {
    const s = await this.findSite(assignment.ref_name);
    if (!s) throw new ValidationError('Die Website existiert in aaPanel nicht mehr.');
    if (assignment.ref_id && String(s.id) !== String(assignment.ref_id)) {
      throw new ValidationError('Die Website wurde in aaPanel neu angelegt – bitte den Administrator die Zuordnung prüfen lassen.');
    }
    return { id: s.id, name: String(s.name), path: String(s.path || ''), status: String(s.status), php_version: s.php_version || '', ssl: s.ssl };
  }

  siteRoot(site) {
    let real;
    try {
      real = fs.realpathSync(site.path);
    } catch (e) {
      throw new ValidationError('Das Website-Verzeichnis existiert nicht.');
    }
    if (FORBIDDEN_ROOTS.includes(real) || real.startsWith('/www/server/') || real === PANEL) {
      throw new ValidationError('Das Website-Verzeichnis ist für den Dateimanager gesperrt.');
    }
    return real;
  }

  async siteDomains(site) {
    const res = await this.call('data', 'getData', { table: 'domain', list: 'True', search: site.id });
    return rows(res).map((d) => ({ id: d.id, name: String(d.name), port: d.port || 80 }));
  }

  async phpVersions() {
    const res = await this.call('site', 'GetPHPVersion', {});
    return rows(res).map((x) => ({ version: String(x.version), name: x.title || x.name || String(x.version) }));
  }

  async overview(site) {
    const [php, index, userini, versions] = await Promise.all([
      this.call('site', 'GetSitePHPVersion', { siteName: site.name }).catch(() => ({})),
      this.call('site', 'GetIndex', { id: site.id }).catch(() => ''),
      this.call('site', 'GetDirUserINI', { id: site.id, path: site.path }).catch(() => ({})),
      this.phpVersions().catch(() => []),
    ]);
    const runPath = (userini && userini.runPath) || {};
    return {
      php_version: (php && php.phpversion) || '',
      php_versions: versions,
      index: typeof index === 'string' ? index : (index && (index.result || index.msg)) || '',
      run_path: runPath.runPath || '/',
      run_dirs: runPath.dirs || [],
      webserver: webserver(),
    };
  }

  // ------------------------------------------------------ Anlegen/Löschen
  async create({ domain, subdomain, php_version: phpVersion, www, ssl }) {
    const q = this.quota();
    if (q.max && q.sites >= q.max) throw new ValidationError(`Website-Limit erreicht (${q.sites} von ${q.max}).`);
    const area = v.normalizeHostname(domain);
    if (!this.domainAreas().includes(area)) throw new ValidationError('Diese Domain ist Ihnen nicht zugeordnet.');
    const sub = v.normalizeSubdomain(subdomain);
    const host = this.checkHost(sub ? `${sub}.${area}` : area);
    const aliases = [];
    if (www && !host.startsWith('www.') && v.domainOwner('www.' + host, this.domainAreas())) aliases.push('www.' + host);
    const versions = await this.phpVersions();
    let version = String(phpVersion || '');
    if (version) {
      if (!versions.some((x) => x.version === version)) throw new ValidationError('Diese PHP-Version ist nicht installiert.');
    } else {
      const php = versions.map((x) => x.version).filter((x) => x !== '00').sort();
      version = php.length ? php[php.length - 1] : '00';
    }
    const sitePath = sitePathFor(this.cfg, host, area, this.customer.customer_no);
    if (fs.existsSync(sitePath)) {
      const st = fs.lstatSync(sitePath);
      if (st.isSymbolicLink() || !st.isDirectory() || fs.readdirSync(sitePath).length) {
        throw new ValidationError(`Das Verzeichnis ${sitePath} existiert bereits.`);
      }
    }
    if (await this.findSite(host)) throw new ValidationError(`Die Website ${host} existiert bereits.`);

    const res = await this.call('site', 'AddSite', {
      webname: JSON.stringify({ domain: host, domainlist: aliases, count: aliases.length }),
      path: sitePath, type_id: 0, type: 'PHP', version, port: 80, ps: host.replace(/\./g, '_'),
      ftp: 'false', sql: 'false', codeing: 'utf8',
    });
    let siteId = res && typeof res === 'object' ? res.siteId || res.site_id || res.id : null;
    if (!siteId) {
      const s = await this.findSite(host);
      if (!s) throw new ApiError(`Website konnte nicht angelegt werden: ${msgOf(res)}`);
      siteId = s.id;
    }
    this.store.assign(this.customer.id, [{ type: 'site', ref_name: host, ref_id: String(siteId) }]);
    this.log('site_create', { site: host, id: siteId, path: sitePath });

    const notes = [];
    for (const h of [host, ...aliases]) {
      try {
        notes.push(await cloudflare.ensureHostRecords(this.cfg, h));
      } catch (e) {
        notes.push(String(e.message || e));
      }
    }
    if (ssl && !this.limits().ssl) {
      notes.push('SSL-Zertifikate werden in Ihrem Paket vom Administrator ausgestellt.');
    } else if (ssl) {
      try {
        await this.sslLetsEncrypt({ id: siteId, name: host });
        notes.push("Let's-Encrypt-Zertifikat wurde ausgestellt.");
      } catch (e) {
        notes.push(`SSL konnte noch nicht ausgestellt werden (DNS evtl. noch nicht aktiv) – später unter „SSL“ erneut versuchen. (${e.message})`);
      }
    }
    return { id: siteId, name: host, path: sitePath, notes };
  }

  async remove(assignment, site, deleteFiles) {
    const domains = await this.siteDomains(site).catch(() => []);
    const params = { id: site.id, webname: site.name };
    if (deleteFiles) params.path = 1;
    await this.call('site', 'DeleteSite', params);
    this.store.unassign(assignment.id);
    this.log('site_delete', { site: site.name, files: !!deleteFiles });
    for (const d of domains) {
      try {
        await cloudflare.removeHostRecords(this.cfg, d.name);
      } catch (e) {
        // DNS-Aufräumen ist best effort
      }
    }
  }

  async setRunning(site, running) {
    await this.call('site', running ? 'SiteStart' : 'SiteStop', { id: site.id, name: site.name });
    this.log(running ? 'site_start' : 'site_stop', site.name);
  }

  // --------------------------------------------------------------- Domains
  async addDomain(site, host) {
    const h = this.checkHost(host);
    const other = await this.findSite(h);
    if (other) throw new ValidationError(`${h} ist bereits eine eigene Website.`);
    await this.call('site', 'AddDomain', { id: site.id, webname: site.name, domain: `${h}:80` });
    this.log('domain_add', { site: site.name, domain: h });
    try {
      return await cloudflare.ensureHostRecords(this.cfg, h);
    } catch (e) {
      return String(e.message || e);
    }
  }

  async removeDomain(site, host) {
    const h = v.normalizeHostname(host);
    const domains = await this.siteDomains(site);
    const match = domains.find((d) => d.name === h);
    if (!match) throw new ValidationError('Diese Domain gehört nicht zur Website.');
    if (domains.length <= 1) throw new ValidationError('Die letzte Domain einer Website kann nicht entfernt werden.');
    if (h === site.name) throw new ValidationError('Die Hauptdomain der Website kann nicht entfernt werden.');
    await this.call('site', 'DelDomain', { id: site.id, webname: site.name, domain: h, port: match.port });
    this.log('domain_remove', { site: site.name, domain: h });
    try {
      await cloudflare.removeHostRecords(this.cfg, h);
    } catch (e) {
      // best effort
    }
  }

  // ------------------------------------------------------ PHP/Index/RunPath
  async setPhp(site, version) {
    const versions = await this.phpVersions();
    if (!versions.some((x) => x.version === String(version))) throw new ValidationError('Diese PHP-Version ist nicht installiert.');
    await this.call('site', 'SetPHPVersion', { siteName: site.name, version: String(version) });
    this.log('php', { site: site.name, version });
  }

  async setIndex(site, index) {
    const idx = v.indexList(index);
    await this.call('site', 'SetIndex', { id: site.id, Index: idx });
    this.log('index', { site: site.name, index: idx });
  }

  async setRunPath(site, runPath) {
    const info = await this.call('site', 'GetDirUserINI', { id: site.id, path: site.path });
    const dirs = (info && info.runPath && info.runPath.dirs) || [];
    if (!dirs.includes(runPath)) throw new ValidationError('Ungültiges Ausführungsverzeichnis.');
    await this.call('site', 'SetSiteRunPath', { id: site.id, runPath });
    this.log('run_path', { site: site.name, run_path: runPath });
  }

  // -------------------------------------------------------------------- SSL
  async sslInfo(site) {
    const res = await this.call('site', 'GetSSL', { siteName: site.name });
    const cert = (res && res.cert_data) || {};
    // Private Key/Zertifikat werden bewusst NICHT an die Oberfläche gegeben.
    return {
      enabled: !!(res && res.status),
      force_https: !!(res && res.httpTohttps),
      issuer: cert.issuer_O || cert.issuer || '',
      not_after: cert.notAfter || '',
      days_left: cert.endtime,
      dns: cert.dns || [],
      auto_renew: res ? res.auto_renew : undefined,
    };
  }

  async sslLetsEncrypt(site) {
    this.requireSsl();
    const domains = (await this.siteDomains(site)).map((d) => d.name);
    if (!domains.length) throw new ValidationError('Keine Domains für das Zertifikat.');
    const res = await this.call('acme', 'apply_cert_api', {
      domains: JSON.stringify(domains), auth_type: 'http', auth_to: site.id, auto_wildcard: 0, id: site.id,
    });
    if (res && typeof res === 'object' && res.private_key && res.cert) {
      await this.call('site', 'SetSSL', { type: 1, siteName: site.name, key: res.private_key, csr: res.cert + (res.root || '') });
    }
    this.log('ssl_letsencrypt', { site: site.name, domains });
    return domains;
  }

  async sslForceHttps(site, enabled) {
    this.requireSsl();
    await this.call('site', enabled ? 'HttpToHttps' : 'CloseToHttps', { siteName: site.name });
    this.log('ssl_force_https', { site: site.name, enabled: !!enabled });
  }

  async sslDisable(site) {
    this.requireSsl();
    await this.call('site', 'CloseSSLConf', { updateOf: 1, siteName: site.name });
    this.log('ssl_disable', site.name);
  }

  // -------------------------------------------------------- Weiterleitungen
  async redirects(site) {
    const res = await this.call('site', 'GetRedirectList', { sitename: site.name });
    return rows(res).map((r) => ({
      name: String(r.redirectname),
      path: r.redirectpath,
      to: r.tourl,
      code: String(r.redirecttype),
      holdpath: !!Number(r.holdpath || 0),
      kind: r.domainorpath,
      domains: r.redirectdomain || [],
      active: !!Number(r.type || 0),
    }));
  }

  async addRedirect(site, { path: from, to, code, holdpath }) {
    const p = v.urlPath(from);
    const target = v.redirectTarget(to);
    await this.call('site', 'CreateRedirect', {
      sitename: site.name, redirectname: String(Date.now()), tourl: target, redirectdomain: '[]', redirectpath: p,
      redirecttype: String(code) === '302' ? '302' : '301', type: 1, domainorpath: 'path', holdpath: holdpath ? 1 : 0,
    });
    this.log('redirect_add', { site: site.name, path: p, to: target });
  }

  async deleteRedirect(site, name) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(name || ''))) throw new ValidationError('Ungültige Weiterleitung.');
    await this.call('site', 'DeleteRedirect', { sitename: site.name, redirectname: name });
    this.log('redirect_delete', { site: site.name, name });
  }

  // ------------------------------------------------------ Rewrite-Vorlagen
  // Nur vorgefertigte Vorlagen - freie Nginx-Konfiguration würde Zugriff
  // außerhalb des eigenen Website-Verzeichnisses ermöglichen.
  rewriteTemplates() {
    try {
      return fs.readdirSync(path.join(PANEL, 'rewrite', 'nginx'))
        .filter((f) => f.endsWith('.conf') && !f.startsWith('0.'))
        .map((f) => f.slice(0, -5))
        .sort();
    } catch (e) {
      return [];
    }
  }

  rewriteFile(site) {
    return path.join(PANEL, 'vhost', 'rewrite', `${site.name}.conf`);
  }

  rewriteGet(site) {
    let current = '';
    try {
      current = fs.readFileSync(this.rewriteFile(site), 'utf8');
    } catch (e) {
      current = '';
    }
    return { templates: this.rewriteTemplates(), current, supported: webserver() === 'nginx' };
  }

  async rewriteSet(site, template) {
    if (webserver() !== 'nginx') throw new ValidationError('Rewrite-Vorlagen gibt es nur mit Nginx – bei Apache bitte die .htaccess bearbeiten.');
    let body = '';
    if (template) {
      if (!this.rewriteTemplates().includes(template)) throw new ValidationError('Unbekannte Vorlage.');
      body = fs.readFileSync(path.join(PANEL, 'rewrite', 'nginx', `${template}.conf`), 'utf8');
    }
    await this.call('files', 'SaveFileBody', { path: this.rewriteFile(site), data: body, encoding: 'utf-8' });
    try {
      await this.call('system', 'ServiceAdmin', { name: 'nginx', type: 'reload' });
    } catch (e) {
      // aaPanel lädt Nginx beim Speichern i. d. R. selbst neu
    }
    this.log('rewrite', { site: site.name, template: template || '-' });
  }

  // ------------------------------------------------------------------- Logs
  async logs(site) {
    const res = await this.call('site', 'GetSiteLogs', { siteName: site.name, lines: 200, ip_area: 0 });
    if (typeof res === 'string') return res;
    return (res && (res.msg || res.result || res.data)) || '';
  }
}

module.exports = { SiteService, panelCall, unwrapResult, sitePathFor, webserver, workingPrefix, msgOf };
