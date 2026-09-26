'use strict';
// Eigenständiger Node-Prozess: Kundenportal für customer_mgr.
//
// Läuft UNABHÄNGIG vom aaPanel-Admin-Plugin (Python). Grund: aaPanels eigenes
// Routing verlangt für JEDE Anfrage an /<plugin_name>/... zwingend eine
// eingeloggte Admin-Session (panel_other() -> comm.local() -> check_login(),
// ohne Ausnahme für Drittanbieter-Plugins). Ein Kunde ohne Admin-Login kann
// diese Routen also nie erreichen - deshalb ein zweiter, eigener Prozess mit
// eigenem Login.
//
// Teilt sich die SQLite-Datenbank mit dem (weiterhin Python-basierten)
// Admin-Plugin, hat aber eine eigene, in JavaScript neu implementierte
// Zugriffsschicht (lib/store.js, lib/api.js, lib/resources.js), da Node kein
// Python-Modul importieren kann. Siehe README.md für Deployment.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const store = require('./lib/store');
const { ApiError } = require('./lib/api');
const resources = require('./lib/resources');

const cfgAtBoot = store.loadCfg();
if (!cfgAtBoot.portal_secret_key) {
  cfgAtBoot.portal_secret_key = crypto.randomBytes(32).toString('hex');
  store.saveCfg(cfgAtBoot);
}
const SECRET_KEY = cfgAtBoot.portal_secret_key;

const LOGIN_WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS_PER_LOGIN = 5;
const MAX_ATTEMPTS_PER_IP = 20;

const cache = new resources.ResourceCache();

class HttpError extends Error {
  constructor(status, message) {
    super(message || '');
    this.status = status;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function flash(req, message, type) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ type: type || 'message', message });
}

// add_mailbox_v2/update_mailbox_v2 parsen quota serverseitig per str.split() in
// (Zahl, Einheit) - ein Wert, der nicht zu "<Zahl> <Einheit>" passt (z. B. eine
// rohe Byte-Zahl aus einer Auflistung), würde den Aufruf zum Absturz bringen.
function normalizeQuota(value, fallback) {
  const s = String(value || '').trim();
  return /^\d+\s+\S+$/.test(s) ? s : fallback;
}

function fmttime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const app = express();
// Deployment sieht immer einen Reverse-Proxy (aaPanel-Website) auf demselben
// Host vor - 'loopback' vertraut X-Forwarded-For nur, wenn der unmittelbare
// Peer 127.0.0.1/::1 ist. Ohne das würde req.ip immer die Proxy-Adresse
// zeigen und die IP-basierte Login-Drossel wäre wirkungslos.
app.set('trust proxy', 'loopback');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.fmttime = fmttime;

app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.urlencoded({ extended: false }));
app.use(
  cookieSession({
    name: 'cm_portal_session',
    keys: [SECRET_KEY],
    maxAge: 12 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: !process.env.PORTAL_DEBUG,
  })
);

// Jede Anfrage bekommt eine eigene Store-Instanz (analog zum Python-Portal:
// dort öffnet ein before_request-Hook pro Request eine frische Verbindung).
app.use((req, res, next) => {
  req.store = new store.Store();
  res.on('finish', () => req.store.close());
  next();
});

app.use((req, res, next) => {
  if (!req.session) req.session = {};
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  const flashes = req.session.flash || [];
  req.session.flash = [];
  res.locals.flashes = flashes;
  next();
});

app.use((req, res, next) => {
  if (req.method === 'POST') {
    const token = req.session.csrf;
    const sent = req.body.csrf_token || '';
    const tokenBuf = Buffer.from(String(token || ''));
    const sentBuf = Buffer.from(String(sent || ''));
    if (!token || !sent || tokenBuf.length !== sentBuf.length || !crypto.timingSafeEqual(tokenBuf, sentBuf)) {
      return next(new HttpError(400, 'CSRF-Prüfung fehlgeschlagen'));
    }
  }
  next();
});

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

function loginRequired(req, res, next) {
  const cid = req.session.customerId;
  const customer = cid ? req.store.getCustomer(cid) : null;
  if (!customer || !customer.portal_enabled) {
    req.session = null;
    return res.redirect('/login');
  }
  req.customer = customer;
  res.locals.customer = customer;
  next();
}

function ownedAssignment(req, aid, expectedType) {
  const row = req.store.getAssignment(aid);
  if (!row || row.customer_id !== req.customer.id) throw new HttpError(404);
  if (expectedType && row.type !== expectedType) throw new HttpError(404);
  return row;
}

async function liveIndex(cfg) {
  try {
    return resources.indexResources(await cache.get(cfg));
  } catch (e) {
    if (e instanceof ApiError) return null;
    throw e;
  }
}

// ---------- Login/Logout ----------
app.get('/login', (req, res) => {
  if (req.session.customerId) return res.redirect('/');
  res.render('login', { title: 'Anmelden' });
});

app.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (req.session.customerId) return res.redirect('/');
    const loginId = String(req.body.login || '').trim();
    const password = String(req.body.password || '');
    const ip = req.ip || '';

    const [byLogin, byIp] = req.store.loginAttemptsCount(loginId, ip, LOGIN_WINDOW_SECONDS);
    if (byLogin >= MAX_ATTEMPTS_PER_LOGIN || byIp >= MAX_ATTEMPTS_PER_IP) {
      flash(req, 'Zu viele Fehlversuche. Bitte später erneut versuchen.', 'error');
      return res.status(429).render('login', { title: 'Anmelden' });
    }

    const customer = req.store.getPortalCustomer(loginId);
    const ok = !!customer && store.verifyPassword(password, customer.portal_password_hash || '');
    req.store.recordLoginAttempt(loginId, ip, ok);
    if (!ok) {
      // Bewusst dieselbe Meldung für "unbekannt" und "falsches Passwort" (kein Enumeration-Leak).
      flash(req, 'Kundennummer oder Passwort ist falsch.', 'error');
      return res.status(401).render('login', { title: 'Anmelden' });
    }

    req.store.touchPortalLogin(customer.id);
    const csrf = req.session.csrf;
    req.session = { customerId: customer.id, csrf };
    res.redirect('/');
  })
);

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ---------- Dashboard ----------
app.get(
  '/',
  loginRequired,
  asyncHandler(async (req, res) => {
    const asg = req.store.assignments(req.customer.id);
    const counts = { site: 0, mail_domain: 0, mailbox: 0 };
    for (const a of asg) counts[a.type] = (counts[a.type] || 0) + 1;
    res.render('dashboard', { title: 'Übersicht', counts });
  })
);

// ---------- Websites ----------
app.get(
  '/sites',
  loginRequired,
  asyncHandler(async (req, res) => {
    const cfg = store.loadCfg();
    const asg = req.store.assignments(req.customer.id).filter((a) => a.type === 'site');
    resources.annotateAssignments(asg, await liveIndex(cfg));
    res.render('sites', { title: 'Websites', sites: asg });
  })
);

app.post(
  '/sites/:id/start',
  loginRequired,
  asyncHandler(async (req, res) => {
    const row = ownedAssignment(req, Number(req.params.id), 'site');
    const cfg = store.loadCfg();
    const api = resources.makeApi(cfg);
    try {
      await api.siteStart(row.ref_id, row.ref_name);
      flash(req, `Website „${row.ref_name}“ wurde gestartet.`);
    } catch (e) {
      flash(req, e.message, 'error');
    }
    cache.invalidate();
    res.redirect('/sites');
  })
);

app.post(
  '/sites/:id/stop',
  loginRequired,
  asyncHandler(async (req, res) => {
    const row = ownedAssignment(req, Number(req.params.id), 'site');
    const cfg = store.loadCfg();
    const api = resources.makeApi(cfg);
    try {
      await api.siteStop(row.ref_id, row.ref_name);
      flash(req, `Website „${row.ref_name}“ wurde gestoppt.`);
    } catch (e) {
      flash(req, e.message, 'error');
    }
    cache.invalidate();
    res.redirect('/sites');
  })
);

// ---------- Mail ----------
app.get(
  '/mail',
  loginRequired,
  asyncHandler(async (req, res) => {
    const cfg = store.loadCfg();
    const asg = req.store.assignments(req.customer.id);
    const domains = asg.filter((a) => a.type === 'mail_domain');
    const boxes = asg.filter((a) => a.type === 'mailbox');
    const idx = await liveIndex(cfg);
    resources.annotateAssignments(domains, idx);
    resources.annotateAssignments(boxes, idx);
    res.render('mail', { title: 'E-Mail', domains, boxes });
  })
);

app.post(
  '/mail/boxes',
  loginRequired,
  asyncHandler(async (req, res) => {
    const domain = String(req.body.domain || '').trim().toLowerCase();
    const local = String(req.body.local || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!req.store.isAssigned(req.customer.id, 'mail_domain', domain)) throw new HttpError(404);
    if (!local || !password) {
      flash(req, 'Postfachname und Passwort sind erforderlich.', 'error');
      return res.redirect('/mail');
    }
    const full = `${local}@${domain}`;
    const cfg = store.loadCfg();
    const api = resources.makeApi(cfg);
    const quota = cfg.mail_box_default_quota || '1024 MB';
    const fullName = req.customer.company ||
      `${req.customer.first_name || ''} ${req.customer.last_name || ''}`.trim() || local;
    try {
      await api.mailBoxCreate(resources.mailPluginPaths(cfg), cfg.mail_box_create_method, domain, full, password, quota, fullName);
    } catch (e) {
      flash(req, e.message, 'error');
      return res.redirect('/mail');
    }
    // Sofort zuordnen, sonst würde der Kunde bei der eigenen Ownership-Prüfung
    // (z. B. beim nächsten Passwort ändern) durchfallen.
    req.store.assign(req.customer.id, [{ type: 'mailbox', ref_name: full }]);
    cache.invalidate();
    flash(req, `Postfach „${full}“ wurde angelegt.`);
    res.redirect('/mail');
  })
);

app.post(
  '/mail/boxes/:id/password',
  loginRequired,
  asyncHandler(async (req, res) => {
    const row = ownedAssignment(req, Number(req.params.id), 'mailbox');
    const password = String(req.body.password || '');
    if (!password) {
      flash(req, 'Bitte ein neues Passwort angeben.', 'error');
      return res.redirect('/mail');
    }
    const domain = row.ref_name.split('@').pop();
    const cfg = store.loadCfg();
    const api = resources.makeApi(cfg);
    // update_mailbox_v2 überschreibt offenbar den kompletten Datensatz - aktuelle
    // Werte übernehmen, damit Kontingent/Anzeigename/Status nicht zurückgesetzt werden.
    const idx = await liveIndex(cfg);
    const info = idx ? idx.get(`mailbox\u0000${row.ref_name}`) : null;
    const quota = normalizeQuota(info && info.quota, cfg.mail_box_default_quota || '1024 MB');
    const fullName = (info && info.full_name) || row.ref_name.split('@')[0];
    const active = info && info.active !== undefined ? info.active : 1;
    try {
      await api.mailBoxSetPassword(
        resources.mailPluginPaths(cfg), cfg.mail_box_setpw_method,
        domain, row.ref_name, password, quota, fullName, active, 0);
      flash(req, `Passwort für „${row.ref_name}“ wurde geändert.`);
    } catch (e) {
      flash(req, e.message, 'error');
    }
    res.redirect('/mail');
  })
);

app.post(
  '/mail/boxes/:id/delete',
  loginRequired,
  asyncHandler(async (req, res) => {
    const row = ownedAssignment(req, Number(req.params.id), 'mailbox');
    const domain = row.ref_name.split('@').pop();
    const cfg = store.loadCfg();
    const api = resources.makeApi(cfg);
    try {
      await api.mailBoxDelete(resources.mailPluginPaths(cfg), cfg.mail_box_delete_method, domain, row.ref_name);
    } catch (e) {
      flash(req, e.message, 'error');
      return res.redirect('/mail');
    }
    req.store.unassign(Number(req.params.id));
    cache.invalidate();
    flash(req, `Postfach „${row.ref_name}“ wurde gelöscht.`);
    res.redirect('/mail');
  })
);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err); // eslint-disable-line no-console
  res.status(status).send(err.message || 'Fehler');
});

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8901', 10);
  app.listen(port, '127.0.0.1', () => {
    console.log(`Kundenportal läuft auf http://127.0.0.1:${port}`); // eslint-disable-line no-console
  });
}

module.exports = app;
