#!/usr/bin/python
# coding: utf-8
# aaPanel-Plugin: Kundenverwaltung
# Klassenname muss dem Dateinamen entsprechen.
import os, sys, json, time, traceback, functools

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir('/www/server/panel')
for p in ('class/', PLUGIN_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

import public
import cm_store
import cm_api
import cm_resources

VERSION = '1.0.0'
_CACHE = cm_resources.ResourceCache()


def _ok(data=None, msg=''):
    return {'status': True, 'msg': msg, 'data': data}


def _err(msg):
    return {'status': False, 'msg': msg}


def endpoint(fn):
    """Einheitliche Fehlerbehandlung für alle Frontend-Methoden."""
    @functools.wraps(fn)
    def wrap(self, args):
        try:
            return fn(self, args)
        except (ValueError, cm_api.ApiError) as e:
            return _err(str(e))
        except Exception as e:
            try:
                public.WriteLog('Kundenverwaltung', 'Fehler in {}: {}'.format(fn.__name__, e))
            except Exception:
                pass
            return _err('Interner Fehler: {} ({})'.format(e, traceback.format_exc().splitlines()[-1]))
    return wrap


def _payload(args):
    raw = getattr(args, 'payload', '') or '{}'
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        raise ValueError('Ungültige Anfrage (payload)')


class customer_mgr_main:

    # ================= Seite =================
    def index(self, args):
        try:
            token = public.get_csrf_sess_html_token_value()
        except Exception:
            token = ''
        return {'csrf_token': token, 'version': VERSION}

    # ================= intern: Panel-Daten =================
    # Fetch-/Normalisierungslogik lebt in cm_resources.py, gemeinsam mit dem
    # Kundenportal genutzt - hier nur noch dünne Wrapper um den Prozess-Cache.
    def _resources(self, refresh=False):
        return _CACHE.get(cm_store.load_cfg(), refresh)

    @staticmethod
    def _index(res):
        return cm_resources.index_resources(res)

    # ================= Kunden =================
    @endpoint
    def get_customers(self, args):
        st = cm_store.Store()
        try:
            return _ok(st.list_customers(str(getattr(args, 'search', '') or '').strip()))
        finally:
            st.close()

    @endpoint
    def get_customer(self, args):
        cid = int(getattr(args, 'id', 0) or 0)
        st = cm_store.Store()
        try:
            c = st.get_customer(cid)
            if not c:
                raise ValueError('Kunde nicht gefunden')
            asg = st.assignments(cid)
            log = st.get_log(cid)
        finally:
            st.close()
        live, warn = None, ''
        try:
            live = self._index(self._resources())
        except Exception as e:
            warn = str(e)
        cm_resources.annotate_assignments(asg, live)
        return _ok({'customer': c, 'assignments': asg, 'log': log, 'warning': warn})

    @endpoint
    def save_customer(self, args):
        data = _payload(args)
        cfg = cm_store.load_cfg()
        st = cm_store.Store()
        try:
            cid = st.save_customer(data, cfg.get('customer_prefix') or 'K-')
        finally:
            st.close()
        return _ok({'id': cid}, 'Kunde gespeichert')

    @endpoint
    def delete_customer(self, args):
        cid = int(getattr(args, 'id', 0) or 0)
        force = str(getattr(args, 'force', '0')) in ('1', 'true')
        st = cm_store.Store()
        try:
            st.delete_customer(cid, force)
        finally:
            st.close()
        return _ok(None, 'Kunde gelöscht')

    # ================= Portal-Zugang =================
    @endpoint
    def set_portal_access(self, args):
        data = _payload(args)
        cid = int(data.get('id') or 0)
        enabled = bool(data.get('enabled'))
        st = cm_store.Store()
        try:
            st.set_portal_access(cid, enabled)
        finally:
            st.close()
        return _ok(None, 'Portal-Zugang aktiviert' if enabled else 'Portal-Zugang deaktiviert')

    @endpoint
    def set_portal_password(self, args):
        data = _payload(args)
        cid = int(data.get('id') or 0)
        password = str(data.get('password') or '')
        st = cm_store.Store()
        try:
            st.set_portal_password(cid, password)
        finally:
            st.close()
        return _ok(None, 'Portal-Passwort gesetzt')

    # ================= Ressourcen & Zuordnung =================
    @endpoint
    def get_resources(self, args):
        refresh = str(getattr(args, 'refresh', '0')) in ('1', 'true')
        res = self._resources(refresh)
        st = cm_store.Store()
        try:
            owners = st.owner_map()
        finally:
            st.close()
        out = {k: res[k] for k in ('sources', 'warnings', 'fetched_at')}
        out['sites'] = [dict(s, owner=owners.get(('site', s['name']))) for s in res['sites']]
        out['mail_domains'] = [dict(d, owner=owners.get(('mail_domain', d['domain']))) for d in res['mail_domains']]
        out['mailboxes'] = [dict(b, owner=owners.get(('mailbox', b['username']))) for b in res['mailboxes']]
        return _ok(out)

    @endpoint
    def assign(self, args):
        data = _payload(args)
        cid = int(data.get('customer_id') or 0)
        items = data.get('items') or []
        if not isinstance(items, list) or not items:
            raise ValueError('Nichts ausgewählt')
        # nur Ressourcen zuordnen, die im Panel wirklich existieren
        live = self._index(self._resources())
        valid, unknown = [], []
        for it in items:
            key = (it.get('type'), str(it.get('ref_name', '')).lower())
            if key in live:
                ref_id = live[key].get('id', '') if key[0] == 'site' else ''
                valid.append({'type': key[0], 'ref_name': key[1], 'ref_id': ref_id})
            else:
                unknown.append(key[1])
        st = cm_store.Store()
        try:
            added, skipped = st.assign(cid, valid)
        finally:
            st.close()
        msg = '{} zugeordnet'.format(len(added))
        if skipped:
            msg += ', {} bereits vergeben'.format(len(skipped))
        if unknown:
            msg += ', {} im Panel nicht gefunden'.format(len(unknown))
        return _ok({'added': added, 'skipped': skipped, 'unknown': unknown}, msg)

    @endpoint
    def domain_bundle(self, args):
        """Alles zu einer Domain: Website(s), Mail-Domain, Mailboxen."""
        d = str(getattr(args, 'domain', '') or '').strip().lower()
        if not d:
            raise ValueError('Keine Domain angegeben')
        res = self._resources()
        items = []
        for s in res['sites']:
            if s['name'] == d or s['name'].endswith('.' + d):
                items.append({'type': 'site', 'ref_name': s['name']})
        for m in res['mail_domains']:
            if m['domain'] == d:
                items.append({'type': 'mail_domain', 'ref_name': m['domain']})
        for b in res['mailboxes']:
            if b['domain'] == d:
                items.append({'type': 'mailbox', 'ref_name': b['username']})
        return _ok(items)

    @endpoint
    def unassign(self, args):
        aid = int(getattr(args, 'id', 0) or 0)
        st = cm_store.Store()
        try:
            r = st.unassign(aid)
        finally:
            st.close()
        return _ok(r, 'Zuordnung gelöst')

    @endpoint
    def get_orphans(self, args):
        """Zuordnungen, deren Ressource im Panel nicht mehr existiert."""
        live = self._index(self._resources(True))
        st = cm_store.Store()
        try:
            rows = st.assignments()
            names = {c['id']: c for c in st.list_customers()}
        finally:
            st.close()
        out = []
        for a in rows:
            if (a['type'], a['ref_name']) not in live:
                c = names.get(a['customer_id'], {})
                a['customer_no'] = c.get('customer_no', '')
                a['customer_label'] = c.get('company') or (c.get('first_name', '') + ' ' + c.get('last_name', '')).strip()
                out.append(a)
        return _ok(out)

    # ================= Einstellungen =================
    @endpoint
    def get_settings(self, args):
        cfg = cm_store.load_cfg()
        key = cfg.pop('api_key', '')
        cfg.pop('portal_secret_key', None)
        cfg['api_key_set'] = bool(key)
        cfg['api_key_hint'] = ('…' + key[-4:]) if len(key) > 8 else ''
        cfg['detected_base_url'] = cm_api.detect_base_url()
        cfg['panel_api'] = cm_api.panel_api_status()
        cfg['mail_db_exists'] = os.path.exists(cm_resources.MAIL_DB)
        cfg['mail_box_actions_configured'] = bool(
            cfg.get('mail_box_create_method') and cfg.get('mail_box_setpw_method') and cfg.get('mail_box_delete_method'))
        cfg['version'] = VERSION
        return _ok(cfg)

    @endpoint
    def save_settings(self, args):
        data = _payload(args)
        cfg = cm_store.load_cfg()
        for k in ('base_url', 'data_path', 'site_project_types', 'mail_plugin_paths',
                  'mail_domains_method', 'mail_boxes_method', 'customer_prefix',
                  'mail_box_create_method', 'mail_box_setpw_method', 'mail_box_delete_method'):
            if k in data:
                cfg[k] = str(data[k] or '').strip()
        if 'mail_db_fallback' in data:
            cfg['mail_db_fallback'] = bool(data['mail_db_fallback'])
        if data.get('api_key'):
            cfg['api_key'] = str(data['api_key']).strip()
        cm_store.save_cfg(cfg)
        _CACHE.invalidate()
        return _ok(None, 'Einstellungen gespeichert')

    @endpoint
    def test_connection(self, args):
        cfg = cm_store.load_cfg()
        status = cm_api.panel_api_status()
        checks = [
            {'label': 'API im Panel aktiviert', 'ok': status['open']},
            {'label': '127.0.0.1 in der API-IP-Whitelist', 'ok': status['localhost_allowed']},
            {'label': 'API-Key im Plugin hinterlegt', 'ok': bool(cfg.get('api_key'))},
        ]
        if not all(c['ok'] for c in checks):
            return _ok({'checks': checks, 'summary': 'Voraussetzungen fehlen, API wurde nicht aufgerufen.'})
        _CACHE.invalidate()
        try:
            res = self._resources(True)
            checks.append({'label': 'Websites laden ({})'.format(res['sources']['sites']), 'ok': True,
                           'detail': '{} gefunden'.format(len(res['sites']))})
            checks.append({'label': 'Mailserver laden ({})'.format(res['sources']['mail']),
                           'ok': res['sources']['mail'] != 'Fehler',
                           'detail': '{} Domains, {} Mailboxen'.format(len(res['mail_domains']), len(res['mailboxes']))})
            return _ok({'checks': checks, 'warnings': res['warnings'], 'summary': 'Verbindung funktioniert.'})
        except cm_api.ApiError as e:
            checks.append({'label': 'API-Aufruf', 'ok': False, 'detail': str(e)})
            return _ok({'checks': checks, 'summary': 'API-Aufruf fehlgeschlagen.'})

    @endpoint
    def raw_call(self, args):
        """Diagnose: beliebigen API-Pfad aufrufen und Rohantwort anzeigen."""
        data = _payload(args)
        path = str(data.get('path', '')).strip()
        if not path.startswith('/'):
            raise ValueError('Pfad muss mit / beginnen, z. B. /v2/plugin?action=a')
        params = data.get('params') or {}
        if not isinstance(params, dict):
            raise ValueError('Parameter müssen ein JSON-Objekt sein')
        api = cm_resources.make_api(cm_store.load_cfg())
        return _ok(api.raw(path, params))
