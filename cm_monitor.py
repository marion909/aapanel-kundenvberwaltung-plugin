# coding: utf-8
"""Mail-Monitoring: Konfiguration aus dem Admin-Plugin heraus verwalten.

Das eigentliche Prüfskript ist mail_monitor/mail_monitor.py (eigenständig,
läuft per Cron). Dieses Modul schreibt dessen INI-Datei in den Datenordner
(übersteht Plugin-Updates), legt den Cron-Eintrag in /etc/cron.d an und liest
Zustand und letzte Ausgabe für die Statusanzeige."""
import configparser, json, os, shlex, shutil, socket, subprocess, sys, time

import cm_store

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(PLUGIN_DIR, 'mail_monitor', 'mail_monitor.py')
INI_FILE = os.path.join(cm_store.DATA_DIR, 'mail_monitor.ini')
STATE_FILE = os.path.join(cm_store.DATA_DIR, 'mail_monitor_state.json')
LOG_FILE = os.path.join(cm_store.DATA_DIR, 'mail_monitor.log')
LEGACY_INI = '/etc/mail_monitor.ini'
CRON_FILE = os.environ.get('CM_CRON_FILE') or '/etc/cron.d/customer_mgr_mail_monitor'

SECURITY = ('ssl', 'starttls', 'none')

# (Abschnitt, Schlüssel, Typ, Standard)  Typen: str, secret, bool, int, security
FIELDS = [
    ('admin', 'enabled', 'bool', False),
    ('admin', 'interval', 'int', 10),
    ('general', 'name', 'str', ''),
    ('general', 'wait_seconds', 'int', 240),
    ('general', 'alert_after_failures', 'int', 2),
    ('general', 'repeat_alert_minutes', 'int', 120),
    ('general', 'notify_recovery', 'bool', True),
    ('discord', 'webhook_url', 'secret', ''),
    ('discord', 'mention', 'str', ''),
    ('checks', 'outbound', 'bool', True),
    ('checks', 'inbound', 'bool', True),
    ('checks', 'ports', 'str', ''),
    ('checks', 'cert_warn_days', 'int', 14),
    ('checks', 'queue', 'bool', True),
    ('checks', 'queue_warn', 'int', 20),
    ('checks', 'queue_fail', 'int', 100),
]
for _acc in ('server', 'external'):
    FIELDS += [
        (_acc, 'address', 'str', ''),
        (_acc, 'user', 'str', ''),
        (_acc, 'password', 'secret', ''),
        (_acc, 'smtp_host', 'str', ''),
        (_acc, 'smtp_security', 'security', 'starttls'),
        (_acc, 'smtp_port', 'int', ''),
        (_acc, 'imap_host', 'str', ''),
        (_acc, 'imap_security', 'security', 'ssl'),
        (_acc, 'imap_port', 'int', ''),
        (_acc, 'folders', 'str', 'INBOX'),
        (_acc, 'spam_folders', 'str', ''),
    ]

INT_RANGES = {
    'admin.interval': (1, 60),
    'general.wait_seconds': (30, 900),
    'general.alert_after_failures': (1, 100),
    'general.repeat_alert_minutes': (0, 10080),
    'checks.cert_warn_days': (0, 365),
    'checks.queue_warn': (1, 100000),
    'checks.queue_fail': (1, 100000),
}


def _parse_bool(v):
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ('1', 'yes', 'true', 'on')


def _read_ini(path):
    p = configparser.ConfigParser(interpolation=None)
    try:
        p.read(path, encoding='utf-8')
    except (OSError, configparser.Error):
        return None
    return p


def load():
    """Aktuelle Werte als {"abschnitt.schlüssel": wert}. Existiert noch keine
    Plugin-Konfiguration, wird eine vorhandene /etc/mail_monitor.ini übernommen."""
    path, legacy = INI_FILE, False
    if not os.path.isfile(INI_FILE) and os.path.isfile(LEGACY_INI):
        path, legacy = LEGACY_INI, True
    p = _read_ini(path) if os.path.isfile(path) else None
    values = {}
    for sec, key, typ, default in FIELDS:
        raw = p.get(sec, key, fallback=None) if p else None
        name = sec + '.' + key
        if raw is None:
            values[name] = default
        elif typ == 'bool':
            values[name] = _parse_bool(raw)
        elif typ == 'int':
            try:
                values[name] = int(raw)
            except ValueError:
                values[name] = default
        else:
            values[name] = raw
    if not values['general.name']:
        values['general.name'] = socket.gethostname()
    if legacy:
        values['admin.enabled'] = False   # Cron läuft dort noch extern
    return values, legacy


def public_values(values):
    """Für das Frontend: Geheimnisse nicht mitschicken, nur ob sie gesetzt sind."""
    out, secrets = {}, {}
    for sec, key, typ, _ in FIELDS:
        name = sec + '.' + key
        if typ == 'secret':
            secrets[name] = bool(values.get(name))
        else:
            out[name] = values.get(name)
    return out, secrets


def merge(values, data):
    """Formulardaten in `values` übernehmen und prüfen. Leere Geheimnisse
    bleiben unverändert (außer "<name>__clear" ist gesetzt)."""
    new = dict(values)
    for sec, key, typ, default in FIELDS:
        name = sec + '.' + key
        if name not in data and typ != 'secret':
            continue
        v = data.get(name)
        if typ == 'bool':
            new[name] = _parse_bool(v)
            continue
        v = '' if v is None else str(v).strip()
        if '\n' in v or '\r' in v:
            raise ValueError('{}: Zeilenumbrüche sind nicht erlaubt'.format(name))
        if typ == 'secret':
            if data.get(name + '__clear'):
                new[name] = ''
            elif v:
                new[name] = v
        elif typ == 'int':
            if v == '':
                new[name] = default
                continue
            try:
                n = int(v)
            except ValueError:
                raise ValueError('{} muss eine Zahl sein'.format(name))
            lo, hi = INT_RANGES.get(name, (1, 65535))
            if not lo <= n <= hi:
                raise ValueError('{} muss zwischen {} und {} liegen'.format(name, lo, hi))
            new[name] = n
        elif typ == 'security':
            if v not in SECURITY:
                raise ValueError('{} muss ssl, starttls oder none sein'.format(name))
            new[name] = v
        else:
            new[name] = v
    url = new['discord.webhook_url']
    if url and not url.startswith('https://'):
        raise ValueError('Discord-Webhook-URL muss mit https:// beginnen')
    if new['admin.enabled']:
        missing = []
        if not url:
            missing.append('Discord-Webhook-URL')
        if new['checks.outbound'] or new['checks.inbound']:
            for acc, label in (('server', 'eigenes Postfach'), ('external', 'externes Postfach')):
                for key, what in (('address', 'Adresse'), ('password', 'Passwort'), ('smtp_host', 'SMTP-Server')):
                    if not new[acc + '.' + key]:
                        missing.append('{} ({})'.format(what, label))
        if missing:
            raise ValueError('Zum Aktivieren fehlt: ' + ', '.join(missing))
    return new


def write_ini(values):
    p = configparser.ConfigParser(interpolation=None)
    p['general'] = {'state_file': STATE_FILE, 'timeout': '30', 'poll_interval': '15'}
    for sec, key, typ, _ in FIELDS:
        v = values.get(sec + '.' + key)
        if not p.has_section(sec):
            p.add_section(sec)
        if typ == 'bool':
            p.set(sec, key, 'yes' if v else 'no')
        elif v not in (None, ''):
            p.set(sec, key, str(v))
    cm_store._ensure_dir()
    tmp = INI_FILE + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write('# Verwaltet von der Kundenverwaltung (Einstellungen -> Mail-Monitoring).\n'
                '# Änderungen hier werden beim nächsten Speichern im Panel überschrieben.\n\n')
        p.write(f)
    os.replace(tmp, INI_FILE)


def python_bin():
    for cand in ('/www/server/panel/pyenv/bin/python3', shutil.which('python3'), sys.executable):
        if cand and os.path.exists(cand):
            return cand
    return 'python3'


def command(extra=''):
    return '{} {} -c {}{}'.format(python_bin(), SCRIPT, INI_FILE, extra)


def write_cron(values):
    if not values['admin.enabled']:
        if os.path.exists(CRON_FILE):
            os.remove(CRON_FILE)
        return
    n = int(values['admin.interval'])
    minute = '*' if n == 1 else '*/{}'.format(n)
    line = '{} * * * * root {} > {} 2>&1\n'.format(minute, command(), LOG_FILE)
    tmp = CRON_FILE + '.tmp'
    with open(tmp, 'w') as f:
        f.write('# Mail-Monitoring der Kundenverwaltung (customer_mgr) - im Panel verwaltet\n'
                'SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n'
                'MAILTO=""\n' + line)
    os.chmod(tmp, 0o644)
    os.replace(tmp, CRON_FILE)


def save(data):
    values, _ = load()
    values = merge(values, data)
    write_ini(values)
    write_cron(values)
    return values


def status(values=None):
    if values is None:
        values, _ = load()
    try:
        with open(STATE_FILE, encoding='utf-8') as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    try:
        with open(LOG_FILE, encoding='utf-8', errors='replace') as f:
            log = f.read()[-4000:]
    except OSError:
        log = ''
    log = '\n'.join(l for l in log.splitlines() if 'ld.so' not in l)
    last = state.get('last_run')
    stale = False
    if values['admin.enabled'] and last:
        max_age = values['admin.interval'] * 60 * 3 + values['general.wait_seconds']
        stale = time.time() - last > max_age
    return {
        'last_run': last,
        'last_status': state.get('last_status'),
        'results': [{'name': r[0], 'status': r[1], 'message': r[2]}
                    for r in state.get('last_results') or []],
        'failures': state.get('failures', 0),
        'alerted': bool(state.get('alerted')),
        'stale': stale,
        'running': _running(),
        'log': log.strip(),
        'cron_active': os.path.exists(CRON_FILE),
        'legacy_ini': os.path.isfile(LEGACY_INI),
        'script_exists': os.path.isfile(SCRIPT),
    }


def _running():
    lock = STATE_FILE + '.lock'
    if not os.path.exists(lock):
        return False
    try:
        import fcntl
    except ImportError:
        return False
    with open(lock, 'a') as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(fh, fcntl.LOCK_UN)
    return False


def _require_config():
    if not os.path.isfile(INI_FILE):
        raise ValueError('Bitte zuerst die Monitoring-Einstellungen speichern')
    if not os.path.isfile(SCRIPT):
        raise ValueError('Prüfskript fehlt: ' + SCRIPT)


def test_webhook():
    _require_config()
    r = subprocess.run([python_bin(), SCRIPT, '-c', INI_FILE, '--test-webhook'],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       universal_newlines=True, timeout=60)
    out = '\n'.join(l for l in r.stdout.splitlines() if 'ld.so' not in l).strip()
    if r.returncode != 0:
        raise ValueError(out or 'Testnachricht fehlgeschlagen')
    return out


def run_now():
    """Prüflauf im Hintergrund starten (dauert bis zu wait_seconds)."""
    _require_config()
    if _running():
        raise ValueError('Es läuft bereits eine Prüfung')
    cm_store._ensure_dir()
    # über die Shell abkoppeln, damit kein Zombie-Prozess im Panel zurückbleibt
    cmd = '{} {} -c {} > {} 2>&1 < /dev/null &'.format(
        *(shlex.quote(x) for x in (python_bin(), SCRIPT, INI_FILE, LOG_FILE)))
    subprocess.run(['/bin/sh', '-c', cmd], timeout=15, check=True)
