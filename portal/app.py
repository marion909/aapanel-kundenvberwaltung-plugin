# coding: utf-8
"""Eigenständiger Flask-Prozess: Kundenportal für customer_mgr.

Läuft UNABHÄNGIG vom aaPanel-Admin-Plugin. Grund: aaPanels eigenes Routing
verlangt für JEDE Anfrage an /<plugin_name>/... zwingend eine eingeloggte
Admin-Session (panel_other() -> comm.local() -> check_login(), ohne Ausnahme
für Drittanbieter-Plugins). Ein Kunde ohne Admin-Login kann diese Routen also
nie erreichen - deshalb ein zweiter, eigener Prozess mit eigenem Login.

Teilt sich Datenbank (cm_store) und Panel-API-Client (cm_api/cm_resources)
mit dem Admin-Plugin, hat aber ein komplett eigenes Session-/Login-System.
Deployment über aaPanels "Python-Projektmanager", siehe README.md.
"""
import functools, hmac, os, secrets, sys
from datetime import datetime, timedelta

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

import cm_api
import cm_resources
import cm_store

from flask import Flask, abort, flash, g, redirect, render_template, request, session, url_for

app = Flask(__name__)

_cfg = cm_store.load_cfg()
if not _cfg.get('portal_secret_key'):
    _cfg['portal_secret_key'] = secrets.token_hex(32)
    cm_store.save_cfg(_cfg)
app.secret_key = bytes.fromhex(_cfg['portal_secret_key'])
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    # Nur für den lokalen Test ohne HTTPS deaktivieren (PORTAL_DEBUG=1) - siehe README.md.
    SESSION_COOKIE_SECURE=not os.environ.get('PORTAL_DEBUG'),
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)

_CACHE = cm_resources.ResourceCache()
LOGIN_WINDOW_SECONDS = 15 * 60
MAX_ATTEMPTS_PER_LOGIN = 5
MAX_ATTEMPTS_PER_IP = 20


# ---------- Infrastruktur ----------
@app.before_request
def _open_store():
    g.store = cm_store.Store()


@app.teardown_request
def _close_store(exc):
    store = g.pop('store', None)
    if store:
        store.close()


@app.before_request
def _csrf_protect():
    if request.method == 'POST':
        token = session.get('csrf')
        sent = request.form.get('csrf_token', '')
        if not token or not sent or not hmac.compare_digest(token, sent):
            abort(400)


@app.context_processor
def _inject_csrf():
    if 'csrf' not in session:
        session['csrf'] = secrets.token_hex(16)
    return {'csrf_token': session['csrf']}


@app.template_filter('fmttime')
def _fmttime(ts):
    return datetime.fromtimestamp(ts).strftime('%d.%m.%Y %H:%M') if ts else ''


@app.after_request
def _security_headers(resp):
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['X-Frame-Options'] = 'DENY'
    resp.headers['Referrer-Policy'] = 'same-origin'
    return resp


def login_required(view):
    """Lädt den aktuellen Kunden bei JEDEM Request neu aus der DB (nicht nur
    aus der Session), damit ein vom Admin entzogener Portal-Zugang sofort
    greift, statt erst nach Ablauf der Session-Cookie-Lebensdauer."""
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        cid = session.get('customer_id')
        customer = g.store.get_customer(cid) if cid else None
        if not customer or not customer.get('portal_enabled'):
            session.clear()
            return redirect(url_for('login'))
        g.customer = customer
        return view(*args, **kwargs)
    return wrapped


def _owned_assignment(aid, expected_type=None):
    """Zentrale Autorisierungsprüfung: eine Ressource darf nur bearbeitet
    werden, wenn sie laut assignments-Tabelle dem eingeloggten Kunden gehört.
    Der aaPanel-API-Key ist ein globaler Admin-Credential ohne Kundengrenze -
    diese Prüfung ist die einzige Autorisierungsschicht, die es gibt."""
    row = g.store.get_assignment(aid)
    if not row or row['customer_id'] != g.customer['id']:
        abort(404)
    if expected_type and row['type'] != expected_type:
        abort(404)
    return row


def _live_index(cfg):
    try:
        return cm_resources.index_resources(_CACHE.get(cfg))
    except cm_api.ApiError:
        return None


# ---------- Login/Logout ----------
@app.route('/login', methods=['GET', 'POST'])
def login():
    if session.get('customer_id'):
        return redirect(url_for('dashboard'))
    if request.method == 'GET':
        return render_template('login.html')

    login_id = request.form.get('login', '').strip()
    password = request.form.get('password', '')
    ip = request.remote_addr or ''

    by_login, by_ip = g.store.login_attempts_count(login_id, ip, LOGIN_WINDOW_SECONDS)
    if by_login >= MAX_ATTEMPTS_PER_LOGIN or by_ip >= MAX_ATTEMPTS_PER_IP:
        flash('Zu viele Fehlversuche. Bitte später erneut versuchen.', 'error')
        return render_template('login.html'), 429

    customer = g.store.get_portal_customer(login_id)
    ok = bool(customer) and cm_store.verify_password(password, customer.get('portal_password_hash', ''))
    g.store.record_login_attempt(login_id, ip, ok)
    if not ok:
        # Bewusst dieselbe Meldung für "unbekannt" und "falsches Passwort" (kein Enumeration-Leak).
        flash('Kundennummer oder Passwort ist falsch.', 'error')
        return render_template('login.html'), 401

    g.store.touch_portal_login(customer['id'])
    session.clear()
    session.permanent = True
    session['customer_id'] = customer['id']
    return redirect(url_for('dashboard'))


@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('login'))


# ---------- Dashboard ----------
@app.route('/')
@login_required
def dashboard():
    asg = g.store.assignments(g.customer['id'])
    counts = {'site': 0, 'mail_domain': 0, 'mailbox': 0}
    for a in asg:
        counts[a['type']] = counts.get(a['type'], 0) + 1
    return render_template('dashboard.html', counts=counts)


# ---------- Websites ----------
@app.route('/sites')
@login_required
def sites():
    cfg = cm_store.load_cfg()
    asg = [a for a in g.store.assignments(g.customer['id']) if a['type'] == 'site']
    cm_resources.annotate_assignments(asg, _live_index(cfg))
    return render_template('sites.html', sites=asg)


@app.route('/sites/<int:assignment_id>/start', methods=['POST'])
@login_required
def site_start(assignment_id):
    row = _owned_assignment(assignment_id, 'site')
    api = cm_resources.make_api(cm_store.load_cfg())
    try:
        api.site_start(row['ref_id'], row['ref_name'])
        flash('Website „{}“ wurde gestartet.'.format(row['ref_name']))
    except cm_api.ApiError as e:
        flash(str(e), 'error')
    _CACHE.invalidate()
    return redirect(url_for('sites'))


@app.route('/sites/<int:assignment_id>/stop', methods=['POST'])
@login_required
def site_stop(assignment_id):
    row = _owned_assignment(assignment_id, 'site')
    api = cm_resources.make_api(cm_store.load_cfg())
    try:
        api.site_stop(row['ref_id'], row['ref_name'])
        flash('Website „{}“ wurde gestoppt.'.format(row['ref_name']))
    except cm_api.ApiError as e:
        flash(str(e), 'error')
    _CACHE.invalidate()
    return redirect(url_for('sites'))


# ---------- Mail ----------
@app.route('/mail')
@login_required
def mail():
    cfg = cm_store.load_cfg()
    asg = g.store.assignments(g.customer['id'])
    domains = [a for a in asg if a['type'] == 'mail_domain']
    boxes = [a for a in asg if a['type'] == 'mailbox']
    idx = _live_index(cfg)
    cm_resources.annotate_assignments(domains, idx)
    cm_resources.annotate_assignments(boxes, idx)
    return render_template('mail.html', domains=domains, boxes=boxes)


@app.route('/mail/boxes', methods=['POST'])
@login_required
def mail_box_create():
    domain = request.form.get('domain', '').strip().lower()
    local = request.form.get('local', '').strip().lower()
    password = request.form.get('password', '')
    if not g.store.is_assigned(g.customer['id'], 'mail_domain', domain):
        abort(404)
    if not local or not password:
        flash('Postfachname und Passwort sind erforderlich.', 'error')
        return redirect(url_for('mail'))
    full = '{}@{}'.format(local, domain)
    cfg = cm_store.load_cfg()
    api = cm_resources.make_api(cfg)
    try:
        api.mail_box_create(cm_resources.mail_plugin_paths(cfg), cfg.get('mail_box_create_method'),
                            domain, full, password)
    except cm_api.ApiError as e:
        flash(str(e), 'error')
        return redirect(url_for('mail'))
    # Sofort zuordnen, sonst würde der Kunde bei der eigenen Ownership-Prüfung
    # (z. B. beim nächsten Passwort ändern) durchfallen - siehe Plan-Dokument.
    g.store.assign(g.customer['id'], [{'type': 'mailbox', 'ref_name': full}])
    _CACHE.invalidate()
    flash('Postfach „{}“ wurde angelegt.'.format(full))
    return redirect(url_for('mail'))


@app.route('/mail/boxes/<int:assignment_id>/password', methods=['POST'])
@login_required
def mail_box_password(assignment_id):
    row = _owned_assignment(assignment_id, 'mailbox')
    password = request.form.get('password', '')
    if not password:
        flash('Bitte ein neues Passwort angeben.', 'error')
        return redirect(url_for('mail'))
    domain = row['ref_name'].split('@')[-1]
    cfg = cm_store.load_cfg()
    api = cm_resources.make_api(cfg)
    try:
        api.mail_box_set_password(cm_resources.mail_plugin_paths(cfg), cfg.get('mail_box_setpw_method'),
                                  domain, row['ref_name'], password)
        flash('Passwort für „{}“ wurde geändert.'.format(row['ref_name']))
    except cm_api.ApiError as e:
        flash(str(e), 'error')
    return redirect(url_for('mail'))


@app.route('/mail/boxes/<int:assignment_id>/delete', methods=['POST'])
@login_required
def mail_box_delete(assignment_id):
    row = _owned_assignment(assignment_id, 'mailbox')
    domain = row['ref_name'].split('@')[-1]
    cfg = cm_store.load_cfg()
    api = cm_resources.make_api(cfg)
    try:
        api.mail_box_delete(cm_resources.mail_plugin_paths(cfg), cfg.get('mail_box_delete_method'),
                            domain, row['ref_name'])
    except cm_api.ApiError as e:
        flash(str(e), 'error')
        return redirect(url_for('mail'))
    g.store.unassign(assignment_id)
    _CACHE.invalidate()
    flash('Postfach „{}“ wurde gelöscht.'.format(row['ref_name']))
    return redirect(url_for('mail'))


if __name__ == '__main__':
    # Nur für den lokalen Test (siehe README.md). Im Produktivbetrieb startet
    # der Python-Projektmanager die App über Gunicorn, dieser Block läuft dann nicht.
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 8901)), debug=bool(os.environ.get('PORTAL_DEBUG')))
