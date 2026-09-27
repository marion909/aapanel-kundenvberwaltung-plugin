'use strict';
// Routen für Websites im Kundenportal: anlegen, konfigurieren, löschen und
// Dateimanager (inkl. Upload in Stücken). Wird von server.js registriert.
const fs = require('fs');
const express = require('express');
const store = require('../lib/store');
const { ApiError } = require('../lib/api');
const { CloudflareError } = require('../lib/cloudflare');
const { SiteService } = require('../lib/sites');
const { FileManager } = require('../lib/files');
const { ValidationError } = require('../lib/validate');

const TABS = ['overview', 'domains', 'ssl', 'redirects', 'rewrite', 'files', 'logs', 'delete'];
const MAX_CHUNK = 8 * 1024 * 1024;

function isUserError(e) {
  return e instanceof ValidationError || e instanceof ApiError || e instanceof CloudflareError;
}

function dirOf(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function list(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null || v === '') return [];
  return [String(v)];
}

module.exports = function registerSiteRoutes(app, { loginRequired, ownedAssignment, asyncHandler, flash, cache, HttpError }) {
  function service(req) {
    return new SiteService({ cfg: store.loadCfg(), store: req.store, customer: req.customer, ip: req.ip });
  }

  async function loadSite(req) {
    const row = ownedAssignment(req, Number(req.params.id), 'site');
    const svc = service(req);
    const site = await svc.resolve(row);
    return { row, svc, site };
  }

  function fileManager(svc, site) {
    const mb = svc.limits().upload_mb;
    return new FileManager(svc.siteRoot(site), mb * 1024 * 1024);
  }

  // Führt eine Aktion aus, zeigt Erfolg/Fehler als Flash und leitet weiter.
  function action(fn) {
    return [
      loginRequired,
      asyncHandler(async (req, res) => {
        let target = `/sites/${req.params.id}`;
        try {
          const out = await fn(req, res);
          if (out && out.redirect) target = out.redirect;
          if (out && out.message) flash(req, out.message);
          for (const n of (out && out.notes) || []) flash(req, n);
        } catch (e) {
          if (e instanceof HttpError) throw e;
          if (!isUserError(e)) throw e;
          flash(req, e.message, 'error');
          if (e.redirect) target = e.redirect;
          else if (req.body && req.body.back) target = String(req.body.back);
        }
        if (!target.startsWith('/sites')) target = '/sites';
        res.redirect(target);
      }),
    ];
  }

  // ------------------------------------------------------------ Übersicht
  app.get(
    '/sites',
    loginRequired,
    asyncHandler(async (req, res) => {
      const svc = service(req);
      const asg = req.store.assignments(req.customer.id).filter((a) => a.type === 'site');
      let idx = null;
      try {
        const { indexResources } = require('../lib/resources');
        idx = indexResources(await cache.get(svc.cfg));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
      }
      require('../lib/resources').annotateAssignments(asg, idx);
      const areas = svc.domainAreas();
      let phpVersions = [];
      if (areas.length) {
        try {
          phpVersions = await svc.phpVersions();
        } catch (e) {
          if (!isUserError(e)) throw e;
        }
      }
      res.render('sites', { title: 'Websites', sites: asg, areas, phpVersions, quota: svc.quota() });
    })
  );

  app.post(
    '/sites/new',
    ...action(async (req) => {
      const svc = service(req);
      try {
        const r = await svc.create({
          domain: req.body.domain,
          subdomain: req.body.subdomain,
          php_version: req.body.php_version,
          www: !!req.body.www,
          ssl: !!req.body.ssl,
        });
        cache.invalidate();
        const created = req.store.siteAssignmentByName(req.customer.id, r.name);
        return { message: `Website „${r.name}“ wurde angelegt.`, notes: r.notes, redirect: created ? `/sites/${created.id}` : '/sites' };
      } catch (e) {
        e.redirect = '/sites';
        throw e;
      }
    })
  );

  // Starten/Stoppen (bestehende URLs bleiben erhalten)
  for (const [verb, running] of [['start', true], ['stop', false]]) {
    app.post(
      `/sites/:id/${verb}`,
      ...action(async (req) => {
        const { svc, site } = await loadSite(req);
        await svc.setRunning(site, running);
        cache.invalidate();
        return {
          message: `Website „${site.name}“ wurde ${running ? 'gestartet' : 'gestoppt'}.`,
          redirect: req.body.back === 'list' ? '/sites' : `/sites/${req.params.id}`,
        };
      })
    );
  }

  // --------------------------------------------------------- Detailseite
  app.get('/sites/:id', loginRequired, (req, res) => res.redirect(`/sites/${Number(req.params.id)}/overview`));

  app.get(
    '/sites/:id/:tab',
    loginRequired,
    asyncHandler(async (req, res, next) => {
      const tab = req.params.tab;
      if (!TABS.includes(tab)) return next();
      const { row, svc, site } = await loadSite(req);
      const data = { title: site.name, row, site, tab, quota: svc.quota() };
      try {
        if (tab === 'overview') data.overview = await svc.overview(site);
        if (tab === 'domains') {
          data.domains = await svc.siteDomains(site);
          data.areas = svc.domainAreas();
        }
        if (tab === 'ssl') data.ssl = await svc.sslInfo(site);
        if (tab === 'redirects') data.redirects = await svc.redirects(site);
        if (tab === 'rewrite') data.rewrite = svc.rewriteGet(site);
        if (tab === 'logs') data.log = await svc.logs(site);
        if (tab === 'files') {
          const fm = fileManager(svc, site);
          data.listing = fm.list(req.query.path || '/');
          data.maxUploadMb = svc.limits().upload_mb;
        }
      } catch (e) {
        if (!isUserError(e)) throw e;
        data.error = e.message;
      }
      res.render('site', data);
    })
  );

  // ------------------------------------------------------ Einstellungen
  app.post('/sites/:id/php', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.setPhp(site, req.body.version);
    cache.invalidate();
    return { message: 'PHP-Version geändert.' };
  }));

  app.post('/sites/:id/index', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.setIndex(site, req.body.index);
    return { message: 'Standard-Dokumente gespeichert.' };
  }));

  app.post('/sites/:id/runpath', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.setRunPath(site, req.body.run_path);
    return { message: 'Ausführungsverzeichnis gespeichert.' };
  }));

  app.post('/sites/:id/domains/add', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    const sub = String(req.body.subdomain || '').trim().replace(/^\.+|\.+$/g, '');
    const area = String(req.body.domain || '').trim();
    const host = req.body.host ? String(req.body.host) : sub ? `${sub}.${area}` : area;
    const note = await svc.addDomain(site, host);
    return { message: `Domain „${host}“ hinzugefügt.`, notes: [note], redirect: `/sites/${req.params.id}/domains` };
  }));

  app.post('/sites/:id/domains/remove', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.removeDomain(site, req.body.host);
    return { message: `Domain „${req.body.host}“ entfernt.`, redirect: `/sites/${req.params.id}/domains` };
  }));

  app.post('/sites/:id/ssl/letsencrypt', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    const doms = await svc.sslLetsEncrypt(site);
    cache.invalidate();
    return { message: `Zertifikat ausgestellt für: ${doms.join(', ')}`, redirect: `/sites/${req.params.id}/ssl` };
  }));

  app.post('/sites/:id/ssl/force', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    const on = req.body.enabled === '1';
    await svc.sslForceHttps(site, on);
    return { message: on ? 'HTTPS wird jetzt erzwungen.' : 'HTTPS wird nicht mehr erzwungen.', redirect: `/sites/${req.params.id}/ssl` };
  }));

  app.post('/sites/:id/ssl/disable', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.sslDisable(site);
    cache.invalidate();
    return { message: 'SSL wurde deaktiviert.', redirect: `/sites/${req.params.id}/ssl` };
  }));

  app.post('/sites/:id/redirects/add', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.addRedirect(site, { path: req.body.path, to: req.body.to, code: req.body.code, holdpath: !!req.body.holdpath });
    return { message: 'Weiterleitung angelegt.', redirect: `/sites/${req.params.id}/redirects` };
  }));

  app.post('/sites/:id/redirects/delete', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.deleteRedirect(site, req.body.name);
    return { message: 'Weiterleitung gelöscht.', redirect: `/sites/${req.params.id}/redirects` };
  }));

  app.post('/sites/:id/rewrite', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    await svc.rewriteSet(site, String(req.body.template || ''));
    return { message: 'Rewrite-Regeln gespeichert.', redirect: `/sites/${req.params.id}/rewrite` };
  }));

  app.post('/sites/:id/delete', ...action(async (req) => {
    const { row, svc, site } = await loadSite(req);
    if (String(req.body.confirm || '').trim().toLowerCase() !== site.name) {
      throw Object.assign(new ValidationError('Zur Bestätigung bitte den Namen der Website exakt eingeben.'), {
        redirect: `/sites/${req.params.id}/delete`,
      });
    }
    await svc.remove(row, site, req.body.delete_files === '1');
    cache.invalidate();
    return { message: `Website „${site.name}“ wurde gelöscht.`, redirect: '/sites' };
  }));

  // -------------------------------------------------------- Dateimanager
  function filesUrl(id, dir) {
    return `/sites/${id}/files?path=${encodeURIComponent(dir || '/')}`;
  }

  app.post('/sites/:id/files/op', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    const fm = fileManager(svc, site);
    const dir = String(req.body.dir || '/');
    const op = String(req.body.op || '');
    const target = req.body.target ? [String(req.body.target)] : [];
    const selected = target.length ? target : list(req.body.paths);
    const arg = String(req.body.arg || '').trim();
    const back = filesUrl(req.params.id, dir);
    const need = () => {
      if (!selected.length) throw Object.assign(new ValidationError('Bitte zuerst Dateien oder Ordner auswählen.'), { redirect: back });
    };
    try {
      let message = 'Erledigt.';
      switch (op) {
        case 'mkdir':
          fm.mkdir(dir, arg);
          message = `Ordner „${arg}“ angelegt.`;
          break;
        case 'touch':
          fm.createFile(dir, arg);
          message = `Datei „${arg}“ angelegt.`;
          break;
        case 'rename':
          need();
          fm.rename(selected[0], arg);
          message = 'Umbenannt.';
          break;
        case 'delete':
          need();
          fm.delete(selected);
          svc.log('files_delete', { site: site.name, paths: selected });
          message = `${selected.length} Eintrag/Einträge gelöscht.`;
          break;
        case 'move':
        case 'copy':
          need();
          fm.move(selected, arg || '/', op === 'copy');
          message = op === 'copy' ? 'Kopiert.' : 'Verschoben.';
          break;
        case 'chmod':
          need();
          for (const p of selected) fm.chmod(p, arg);
          message = 'Rechte geändert.';
          break;
        case 'compress': {
          need();
          const out = fm.compress(selected, dir, arg || 'archiv.zip');
          message = `Archiv ${out} erstellt.`;
          break;
        }
        case 'extract': {
          need();
          const n = fm.extract(selected[0], arg || dirOf(selected[0]), req.body.overwrite === '1');
          svc.log('files_extract', { site: site.name, zip: selected[0] });
          message = `${n} Datei(en) entpackt.`;
          break;
        }
        default:
          throw new ValidationError('Unbekannte Aktion.');
      }
      return { message, redirect: back };
    } catch (e) {
      if (isUserError(e) && !e.redirect) e.redirect = back;
      if (!isUserError(e) && e.code && /^E[A-Z]+$/.test(e.code)) {
        throw Object.assign(new ValidationError(`Dateisystem-Fehler: ${e.code}`), { redirect: back });
      }
      throw e;
    }
  }));

  app.get(
    '/sites/:id/files/download',
    loginRequired,
    asyncHandler(async (req, res) => {
      const { svc, site } = await loadSite(req);
      let file;
      try {
        file = fileManager(svc, site).openDownload(req.query.path);
      } catch (e) {
        if (!isUserError(e)) throw e;
        flash(req, e.message, 'error');
        return res.redirect(filesUrl(req.params.id, dirOf(req.query.path)));
      }
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Length', String(file.size));
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
      fs.createReadStream(file.path).pipe(res);
    })
  );

  app.get(
    '/sites/:id/files/edit',
    loginRequired,
    asyncHandler(async (req, res) => {
      const { row, svc, site } = await loadSite(req);
      let file;
      try {
        file = fileManager(svc, site).readText(req.query.path);
      } catch (e) {
        if (!isUserError(e)) throw e;
        flash(req, e.message, 'error');
        return res.redirect(filesUrl(req.params.id, dirOf(req.query.path)));
      }
      res.render('editor', { title: file.path, row, site, file, dir: dirOf(file.path) });
    })
  );

  app.post('/sites/:id/files/save', ...action(async (req) => {
    const { svc, site } = await loadSite(req);
    const p = String(req.body.path || '');
    const back = `/sites/${req.params.id}/files/edit?path=${encodeURIComponent(p)}`;
    try {
      // Browser senden Zeilenumbrüche in Formularen als CRLF - Original-Stil beibehalten
      let content = String(req.body.content || '');
      if (req.body.eol === 'lf') content = content.replace(/\r\n/g, '\n');
      fileManager(svc, site).writeText(p, content, req.body.encoding);
    } catch (e) {
      if (isUserError(e)) e.redirect = back;
      throw e;
    }
    svc.log('files_edit', { site: site.name, path: p });
    return { message: 'Datei gespeichert.', redirect: back };
  }));

  // Upload in Stücken: Rohdaten im Body, Metadaten in der Query, CSRF im Header.
  app.post(
    '/sites/:id/files/upload',
    loginRequired,
    express.raw({ type: () => true, limit: MAX_CHUNK }),
    asyncHandler(async (req, res) => {
      const { svc, site } = await loadSite(req);
      const q = req.query;
      try {
        const out = fileManager(svc, site).uploadChunk(
          String(q.dir || '/'), String(q.name || ''), q.offset, q.total,
          Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), q.overwrite === '1'
        );
        if (out.done) svc.log('files_upload', { site: site.name, path: out.path });
        res.json(Object.assign({ ok: true }, out));
      } catch (e) {
        if (!isUserError(e)) throw e;
        res.status(e.exists ? 409 : 400).json({ ok: false, exists: !!e.exists, msg: e.message });
      }
    })
  );
};
