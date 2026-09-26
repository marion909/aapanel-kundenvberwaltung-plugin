# coding: utf-8
"""aaPanel-API-Client für customer_mgr.

Signatur: request_token = md5(request_time + md5(api_key)).
Achtung: aaPanel sperrt eine IP nach 20 fehlgeschlagenen Signaturprüfungen
für eine Stunde. Daher keine automatischen Wiederholungen bei Auth-Fehlern.
"""
import hashlib, json, os, time

try:
    import requests
    import urllib3
    urllib3.disable_warnings()
except Exception:  # pragma: no cover
    requests = None

PANEL = '/www/server/panel'


def _md5(s):
    return hashlib.md5(s.encode('utf-8')).hexdigest()


def detect_base_url():
    try:
        port = open(PANEL + '/data/port.pl').read().strip()
    except Exception:
        port = '7800'
    proto = 'https' if os.path.exists(PANEL + '/data/ssl.pl') else 'http'
    return '{}://127.0.0.1:{}'.format(proto, port)


def panel_api_status():
    """Liest /www/server/panel/config/api.json (ohne Geheimnisse)."""
    info = {'exists': False, 'open': False, 'localhost_allowed': False, 'limit_addr': []}
    try:
        cfg = json.loads(open(PANEL + '/config/api.json').read())
        info['exists'] = True
        info['open'] = bool(cfg.get('open'))
        addrs = cfg.get('limit_addr') or []
        info['limit_addr'] = addrs
        wild = ('*', 'all', '0.0.0.0', '0.0.0.0/0')
        info['localhost_allowed'] = any(a in wild or a.startswith('127.') for a in addrs)
    except Exception:
        pass
    return info


class ApiError(Exception):
    pass


class PanelApi(object):
    def __init__(self, api_key, base_url=None, timeout=30):
        if requests is None:
            raise ApiError('Python-Modul "requests" nicht verfügbar')
        if not api_key:
            raise ApiError('Kein API-Key hinterlegt (Einstellungen)')
        self.key_md5 = _md5(api_key.strip())
        self.base = (base_url or detect_base_url()).rstrip('/')
        self.timeout = timeout
        self.s = requests.Session()
        self.s.verify = False

    def raw(self, path, params=None):
        """POST an path (z. B. '/v2/data?action=getData'). Gibt geparstes JSON oder Text zurück."""
        now = str(int(time.time()))
        body = dict(params or {})
        body['request_time'] = now
        body['request_token'] = _md5(now + self.key_md5)
        url = self.base + (path if path.startswith('/') else '/' + path)
        try:
            r = self.s.post(url, data=body, timeout=self.timeout)
        except Exception as e:
            raise ApiError('Verbindung zu {} fehlgeschlagen: {}'.format(self.base, e))
        text = r.text
        try:
            data = r.json()
        except Exception:
            if '<html' in text[:500].lower():
                raise ApiError('Panel lieferte HTML statt JSON (HTTP {}). API aktiv? Pfad korrekt?'.format(r.status_code))
            return text
        # Typische Fehlermeldungen der API-Prüfung
        if isinstance(data, dict) and data.get('status') is False:
            msg = str(data.get('msg', ''))
            if 'verification' in msg or 'IP validation' in msg or 'prohibited' in msg:
                raise ApiError('API-Authentifizierung: ' + msg)
        return data

    # ---------- Hilfen zum Normalisieren v1/v2 ----------
    @staticmethod
    def unwrap(data):
        """v2 liefert {'status':0,'message':X}, v1 direkt X."""
        if isinstance(data, dict) and 'message' in data and data.get('status') in (0, -1, 1) and not isinstance(data.get('message'), str):
            return data['message']
        if isinstance(data, dict) and data.get('status') == -1:
            raise ApiError(str(data.get('message')))
        return data

    @staticmethod
    def find_rows(data):
        """Sucht die erste Liste von Dicts in einer Antwort."""
        data = PanelApi.unwrap(data)
        if isinstance(data, list):
            return [x for x in data if isinstance(x, dict)]
        if isinstance(data, dict):
            for k in ('data', 'list', 'rows', 'items'):
                v = data.get(k)
                if isinstance(v, list):
                    return [x for x in v if isinstance(x, dict)]
                if isinstance(v, dict):
                    sub = PanelApi.find_rows(v)
                    if sub:
                        return sub
            for v in data.values():
                if isinstance(v, list) and v and isinstance(v[0], dict):
                    return v
            if data.get('status') is False:
                raise ApiError(str(data.get('msg', 'Unbekannter Fehler')))
        return []

    # ---------- Websites ----------
    def list_sites(self, data_path='/v2/data', project_types=None):
        """Alle Sites. Ohne project_type liefert aaPanel nur PHP/WP,
        daher zusätzlich die konfigurierten Projekttypen abfragen."""
        seen, out = set(), []
        queries = [None] + [t for t in (project_types or []) if t]
        errors = []
        for pt in queries:
            p = {'table': 'sites', 'p': 1, 'limit': 1000, 'search': '', 'type': -1, 'order': ''}
            if pt:
                p['project_type'] = pt
            try:
                rows = self.find_rows(self.raw(data_path + '?action=getData', p))
            except ApiError as e:
                if pt is None:
                    raise
                errors.append('{}: {}'.format(pt, e))
                continue
            for r in rows:
                sid = r.get('id')
                if sid in seen:
                    continue
                seen.add(sid)
                out.append({
                    'id': sid,
                    'name': r.get('name', ''),
                    'path': r.get('path', ''),
                    'status': str(r.get('status', '')),
                    'project_type': r.get('project_type') or pt or 'PHP',
                    'ps': r.get('ps', ''),
                    'edate': r.get('edate', ''),
                    'ssl': r.get('ssl'),
                    'php_version': r.get('php_version', ''),
                })
        return out, errors

    # ---------- Mailserver (mail_sys) ----------
    # Nur Lese-Zugriffe: Schreibaktionen (Postfach anlegen/ändern/löschen,
    # Website Start/Stopp) werden ausschließlich vom Node-Portal ausgeführt
    # (portal/lib/api.js), das eine eigene, unabhängige Implementierung hat.
    def _mail_call(self, plugin_paths, method, params=None):
        last = None
        for pp in plugin_paths:
            p = {'name': 'mail_sys', 's': method}
            p.update(params or {})
            try:
                return self.find_rows(self.raw(pp + '?action=a', p)), pp
            except ApiError as e:
                last = e
        raise last or ApiError('Kein Plugin-Pfad konfiguriert')

    def list_mail_domains(self, plugin_paths, method):
        rows, used = self._mail_call(plugin_paths, method, {'p': 1, 'size': 1000, 'limit': 1000})
        out = []
        for r in rows:
            d = r.get('domain') or r.get('name')
            if d:
                out.append({'domain': d, 'active': r.get('active', 1), 'created': r.get('created', '')})
        return out, used

    def list_mailboxes(self, plugin_paths, method, domain):
        rows, used = self._mail_call(plugin_paths, method, {'domain': domain, 'p': 1, 'size': 1000, 'limit': 1000})
        out = []
        for r in rows:
            u = r.get('username') or r.get('email') or r.get('mailbox')
            if u:
                out.append({'username': u, 'domain': r.get('domain') or domain,
                            'full_name': r.get('full_name', ''), 'quota': r.get('quota', ''),
                            'active': r.get('active', 1)})
        return out, used
