'use strict';
// Übersicht (Startseite im Stil des Sub-aaPanels), Dateiverwaltung-Einstieg,
// SSL-Übersicht und Journal.
const store = require('../lib/store');
const resources = require('../lib/resources');
const stats = require('../lib/stats');
const { ApiError } = require('../lib/api');
const { SiteService } = require('../lib/sites');
const { FtpService } = require('../lib/ftp');

const DISK_WAIT_MS = 2500;

const ACTION_LABELS = {
  assign: 'Ressource zugeordnet',
  unassign: 'Zuordnung gelöst',
  portal_enable: 'Portal-Zugang aktiviert',
  portal_disable: 'Portal-Zugang deaktiviert',
  portal_password_set: 'Portal-Passwort gesetzt',
  customer_add: 'Kunde angelegt',
  customer_edit: 'Stammdaten geändert',
  portal_site_create: 'Website angelegt',
  portal_site_delete: 'Website gelöscht',
  portal_site_start: 'Website gestartet',
  portal_site_stop: 'Website gestoppt',
  portal_domain_add: 'Domain hinzugefügt',
  portal_domain_remove: 'Domain entfernt',
  portal_php: 'PHP-Version geändert',
  portal_index: 'Standard-Dokumente geändert',
  portal_run_path: 'Ausführungsverzeichnis geändert',
  portal_ssl_letsencrypt: 'SSL-Zertifikat ausgestellt',
  portal_ssl_force_https: 'HTTPS-Erzwingung geändert',
  portal_ssl_disable: 'SSL deaktiviert',
  portal_redirect_add: 'Weiterleitung angelegt',
  portal_redirect_delete: 'Weiterleitung gelöscht',
  portal_rewrite: 'Rewrite-Regeln geändert',
  portal_files_upload: 'Datei hochgeladen',
  portal_files_delete: 'Dateien gelöscht',
  portal_files_edit: 'Datei bearbeitet',
  portal_files_extract: 'Archiv entpackt',
  portal_ftp_create: 'FTP-Zugang angelegt',
  portal_ftp_password: 'FTP-Passwort geändert',
  portal_ftp_enable: 'FTP-Zugang aktiviert',
  portal_ftp_disable: 'FTP-Zugang gesperrt',
  portal_ftp_delete: 'FTP-Zugang gelöscht',
};

function journalDetail(raw) {
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j.map((x) => x.ref_name || JSON.stringify(x)).join(', ');
    if (j && typeof j === 'object') {
      return Object.entries(j)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join(' · ');
    }
  } catch (e) {
    // Klartext
  }
  return String(raw || '');
}

module.exports = function registerOverviewRoutes(app, { loginRequired, asyncHandler, cache }) {
  async function liveSites(req) {
    const cfg = store.loadCfg();
    const asg = req.store.assignments(req.customer.id).filter((a) => a.type === 'site');
    let idx = null;
    try {
      idx = resources.indexResources(await cache.get(cfg));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    resources.annotateAssignments(asg, idx);
    return { cfg, asg, live: idx !== null };
  }

  app.get(
    '/',
    loginRequired,
    asyncHandler(async (req, res) => {
      const { cfg, asg, live } = await liveSites(req);
      const all = req.store.assignments(req.customer.id);
      const count = (t) => all.filter((a) => a.type === t).length;
      const svc = new SiteService({ cfg, store: req.store, customer: req.customer });
      const quota = svc.quota();

      // Anfragen der letzten 30 Tage
      let traffic = null;
      const names = asg.filter((a) => a.state === 'ok').map((a) => a.ref_name);
      if (names.length && cfg.api_key) {
        try {
          traffic = await stats.requests30(resources.makeApi(cfg), cfg, names);
        } catch (e) {
          traffic = null;
        }
      }
      const today = traffic ? traffic[traffic.length - 1].requests : null;
      const trafficChart = traffic
        ? stats.areaChart(traffic.map((t) => ({ label: t.date.slice(5).split('-').reverse().join('.'), value: t.requests })))
        : null;

      // Speicherplatz pro Website (gecacht, max. kurz warten)
      const disk = [];
      const pending = [];
      for (const a of asg) {
        if (a.state !== 'ok' || !a.info.path) continue;
        const entry = { name: a.ref_name, id: a.id, bytes: null, partial: false };
        disk.push(entry);
        pending.push(stats.dirSize(a.info.path).then((r) => {
          entry.bytes = r.bytes;
          entry.partial = r.partial;
        }));
      }
      await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, DISK_WAIT_MS))]);
      const diskTotal = disk.reduce((s, d) => s + (d.bytes || 0), 0);
      const diskMax = Math.max(1, ...disk.map((d) => d.bytes || 0));

      res.render('dashboard', {
        title: 'Übersicht',
        live,
        sites: asg,
        cards: {
          today,
          sites: count('site'),
          maxSites: quota.max,
          mailDomains: count('mail_domain'),
          mailboxes: count('mailbox'),
          domains: req.store.domains(req.customer.id).map((d) => d.ref_name),
        },
        trafficChart,
        trafficTotal: traffic ? traffic.reduce((s, t) => s + t.requests, 0) : null,
        disk,
        diskTotal,
        diskMax,
        fmtBytes: stats.fmtBytes,
      });
    })
  );

  // Dateiverwaltung: Website wählen (bei nur einer Website direkt dorthin)
  app.get(
    '/files',
    loginRequired,
    asyncHandler(async (req, res) => {
      const { asg } = await liveSites(req);
      const usable = asg.filter((a) => a.state !== 'missing');
      if (usable.length === 1) return res.redirect(`/sites/${usable[0].id}/files`);
      res.render('files-index', { title: 'Dateiverwaltung', sites: usable });
    })
  );

  // FTP: alle Zugänge des Kunden, angelegt wird pro Website
  app.get(
    '/ftp',
    loginRequired,
    asyncHandler(async (req, res) => {
      const { cfg, asg } = await liveSites(req);
      const usable = asg.filter((a) => a.state !== 'missing');
      const ftp = new FtpService(new SiteService({ cfg, store: req.store, customer: req.customer }));
      let accounts = [];
      let error = null;
      try {
        accounts = await ftp.accounts();
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        error = e.message;
      }
      // Zugang -> Website (tiefstes Website-Verzeichnis, das den FTP-Pfad enthält)
      for (const a of accounts) {
        if (a.state !== 'ok') continue;
        let best = null;
        for (const s of usable) {
          const root = String((s.info && s.info.path) || '').replace(/\/+$/, '');
          if (root && (a.path === root || a.path.startsWith(root + '/')) && (!best || root.length > best.root.length)) {
            best = { root, site: s };
          }
        }
        if (best) {
          a.site = best.site;
          a.rel = '/' + a.path.slice(best.root.length).replace(/^\/+/, '');
        }
      }
      res.render('ftp-index', {
        title: 'FTP', sites: usable, accounts, error,
        allowed: ftp.allowed(), quota: ftp.quota(), host: ftp.host(req.hostname),
      });
    })
  );

  app.get(
    '/ssl',
    loginRequired,
    asyncHandler(async (req, res) => {
      const { asg, live } = await liveSites(req);
      res.render('ssl-index', { title: 'SSL', sites: asg, live });
    })
  );

  app.get('/journal', loginRequired, (req, res) => {
    const entries = req.store.getLog(req.customer.id, 300).map((e) => ({
      ts: e.ts,
      action: ACTION_LABELS[e.action] || e.action,
      detail: journalDetail(e.detail),
    }));
    res.render('journal', { title: 'Journal', entries });
  });
};
