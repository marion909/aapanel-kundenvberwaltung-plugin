# coding: utf-8
"""Gemeinsame Ressourcen-Fetch/Cache-Logik für Admin-Plugin und Kundenportal.

Beide Prozesse (customer_mgr_main.py im aaPanel-Kontext und portal/app.py als
eigenständiger Flask-Prozess) importieren dieses Modul, damit die Panel-API-
Abfrage- und Normalisierungslogik nicht doppelt gepflegt werden muss.
"""
import os, sqlite3, time

import cm_api

MAIL_DB = '/www/vmail/postfixadmin.db'
DEFAULT_CACHE_TTL = 60


def _split(s):
    return [x.strip() for x in str(s or '').split(',') if x.strip()]


def make_api(cfg):
    return cm_api.PanelApi(cfg.get('api_key', ''), cfg.get('base_url') or None)


def mail_plugin_paths(cfg):
    return _split(cfg.get('mail_plugin_paths')) or ['/v2/plugin', '/plugin']


def fetch_sites(api, cfg, warnings):
    """Alle Sites. Ohne project_type liefert aaPanel nur PHP/WP,
    daher zusätzlich die konfigurierten Projekttypen abfragen."""
    paths = [cfg.get('data_path') or '/v2/data']
    paths += [p for p in ('/v2/data', '/data') if p not in paths]
    last = None
    for p in paths:
        try:
            sites, errs = api.list_sites(p, _split(cfg.get('site_project_types')))
            for e in errs:
                warnings.append('Projekttyp übersprungen – ' + e)
            return sites, 'API ' + p
        except cm_api.ApiError as e:
            last = e
            if 'Authentifizierung' in str(e):
                break
    raise cm_api.ApiError('Websites konnten nicht geladen werden: {}'.format(last))


def _mail_db_rows(sql):
    con = sqlite3.connect('file:{}?mode=ro'.format(MAIL_DB), uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql)]
    finally:
        con.close()


def fetch_mail(api, cfg, warnings):
    """Mail-Domains + Mailboxen. Primär API, optional lesender DB-Fallback."""
    if not os.path.exists('/www/server/panel/plugin/mail_sys') and not os.path.exists(MAIL_DB):
        return [], [], 'nicht installiert'
    paths = mail_plugin_paths(cfg)
    try:
        domains, used = api.list_mail_domains(paths, cfg.get('mail_domains_method') or 'get_domains')
        boxes = []
        for d in domains:
            rows, _ = api.list_mailboxes([used], cfg.get('mail_boxes_method') or 'get_mailboxs', d['domain'])
            boxes.extend(rows)
        return domains, boxes, 'API ' + used
    except cm_api.ApiError as e:
        if not (cfg.get('mail_db_fallback') and os.path.exists(MAIL_DB)):
            raise cm_api.ApiError('Mailserver-Daten konnten nicht geladen werden: {}'.format(e))
        warnings.append('Mail-API fehlgeschlagen ({}), lese Mailserver-Datenbank (nur lesend).'.format(e))
    domains = [{'domain': r['domain'], 'active': r.get('active', 1), 'created': r.get('created', '')}
               for r in _mail_db_rows('SELECT * FROM domain')]
    boxes = [{'username': r['username'], 'domain': r.get('domain', ''), 'full_name': r.get('full_name', ''),
              'quota': r.get('quota', ''), 'active': r.get('active', 1)}
             for r in _mail_db_rows('SELECT * FROM mailbox')]
    return domains, boxes, 'Datenbank (Fallback)'


def load_resources(cfg, api=None):
    """Ungecachter Kern: fragt Sites + Mail live über die Panel-API ab und
    normalisiert die Ergebnisse (Kleinschreibung der Namen/Domains)."""
    api = api or make_api(cfg)
    warnings = []
    sites, site_src = fetch_sites(api, cfg, warnings)
    try:
        domains, boxes, mail_src = fetch_mail(api, cfg, warnings)
    except cm_api.ApiError as e:
        domains, boxes, mail_src = [], [], 'Fehler'
        warnings.append(str(e))
    for s in sites:
        s['name'] = str(s['name']).lower()
    for d in domains:
        d['domain'] = str(d['domain']).lower()
    for b in boxes:
        b['username'] = str(b['username']).lower()
        b['domain'] = str(b.get('domain') or b['username'].split('@')[-1]).lower()
    return {'sites': sites, 'mail_domains': domains, 'mailboxes': boxes,
            'sources': {'sites': site_src, 'mail': mail_src},
            'warnings': warnings, 'fetched_at': time.strftime('%Y-%m-%d %H:%M:%S')}


def index_resources(res):
    idx = {}
    for s in res['sites']:
        idx[('site', s['name'])] = s
    for d in res['mail_domains']:
        idx[('mail_domain', d['domain'])] = d
    for b in res['mailboxes']:
        idx[('mailbox', b['username'])] = b
    return idx


def annotate_assignments(assignments, idx):
    """Reichert Zuordnungen mit Live-Status ('ok'/'missing') und Panel-Infos an.
    idx=None bedeutet 'Live-Status nicht verfügbar' (z. B. API-Fehler)."""
    for a in assignments:
        if idx is None:
            a['state'] = 'unknown'
            a['info'] = {}
            continue
        info = idx.get((a['type'], a['ref_name']))
        a['state'] = 'ok' if info else 'missing'
        a['info'] = info or {}
    return assignments


class ResourceCache(object):
    """Pro-Prozess-Cache (jeder Gunicorn-Worker des Portals hat seinen eigenen).
    Bei dieser Traffic-Größe unkritisch - kein geteilter Cache nötig."""

    def __init__(self, ttl=DEFAULT_CACHE_TTL):
        self.ttl = ttl
        self.ts = 0
        self.data = None

    def get(self, cfg, refresh=False):
        now = time.time()
        if not refresh and self.data and now - self.ts < self.ttl:
            return self.data
        self.data = load_resources(cfg)
        self.ts = now
        return self.data

    def invalidate(self):
        self.ts = 0
        self.data = None
