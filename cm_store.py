# coding: utf-8
"""SQLite-Speicher für Kunden und Zuordnungen.
Liegt außerhalb des Plugin-Verzeichnisses, damit Updates/Neuinstallationen die Daten nicht löschen."""
import base64, hashlib, hmac, json, os, re, sqlite3, time

# CM_DATA_DIR erlaubt lokale Tests/Entwicklung außerhalb eines echten aaPanel-
# Servers (der Standardpfad existiert z. B. auf macOS gar nicht). Im Produktiv-
# betrieb bleibt die Variable ungesetzt und der feste Pfad greift wie bisher.
DATA_DIR = os.environ.get('CM_DATA_DIR') or '/www/server/panel/data/customer_mgr'
DB_FILE = DATA_DIR + '/customer_mgr.db'
CFG_FILE = DATA_DIR + '/config.json'

DEFAULT_CFG = {
    'api_key': '',
    'base_url': '',                       # leer = automatisch (127.0.0.1 + Panel-Port)
    'data_path': '/v2/data',              # Fallback /data wird automatisch versucht
    'site_project_types': 'Node,Proxy,Python,Go,Java,WP2',
    'mail_plugin_paths': '/v2/plugin,/plugin',
    'mail_domains_method': 'get_domains',
    'mail_boxes_method': 'get_mailboxs',
    'mail_box_create_method': '',         # muss über "API-Rohaufruf" ermittelt werden
    'mail_box_setpw_method': '',
    'mail_box_delete_method': '',
    'mail_box_default_quota': '1024 MB',  # Format "Zahl Einheit", von add_mailbox_v2/update_mailbox_v2 verlangt
    'mail_db_fallback': True,             # nur lesend: /www/vmail/postfixadmin.db
    'customer_prefix': 'K-',
    'portal_secret_key': '',              # wird beim ersten Portal-Start automatisch erzeugt
    # Websites im Kundenportal (Anlegen/Konfigurieren/Dateimanager)
    'site_api_prefixes': '/v2,',          # Reihenfolge der API-Präfixe (/v2/site, /site); leer = klassisch
    'site_path_template': '/www/wwwroot/{host}',  # Platzhalter: {host}, {domain}, {customer_no}
    'site_default_max_sites': 0,          # 0 = unbegrenzt (pro Kunde überschreibbar)
    'portal_max_upload_mb': 512,          # max. Dateigröße pro Upload im Dateimanager
    'cf_email': '',                       # Cloudflare (optional): DNS-Einträge für neue (Sub-)Domains
    'cf_api_key': '',                     # Global API Key - verlässt den Server nie
    'cf_proxied': False,
    'server_ipv4': '',
    'server_ipv6': '',
    'portal_name': 'KundenPortal',        # Name im Kundenportal (Seitenleiste, Login, Titel)
}

PBKDF2_ITERATIONS = 600000  # aktuelle OWASP-Empfehlung für PBKDF2-SHA256


def hash_password(password):
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PBKDF2_ITERATIONS)
    return 'pbkdf2_sha256${}${}${}'.format(
        PBKDF2_ITERATIONS,
        base64.b64encode(salt).decode('ascii'),
        base64.b64encode(dk).decode('ascii'))


def verify_password(password, stored):
    try:
        algo, iterations, salt_b64, hash_b64 = str(stored or '').split('$')
        if algo != 'pbkdf2_sha256':
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, int(iterations))
        return hmac.compare_digest(dk, expected)
    except Exception:
        return False

SCHEMA = """
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_no TEXT UNIQUE,
  company TEXT DEFAULT '', first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
  email TEXT DEFAULT '', phone TEXT DEFAULT '',
  street TEXT DEFAULT '', zip TEXT DEFAULT '', city TEXT DEFAULT '', country TEXT DEFAULT '',
  vat_id TEXT DEFAULT '', note TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  portal_enabled INTEGER NOT NULL DEFAULT 0,
  portal_password_hash TEXT NOT NULL DEFAULT '',
  portal_password_set_at INTEGER NOT NULL DEFAULT 0,
  portal_last_login INTEGER NOT NULL DEFAULT 0,
  max_sites INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,              -- site | mail_domain | mailbox | domain (Domain-Bereich fürs Portal)
  ref_name TEXT NOT NULL,          -- Domain bzw. Mailadresse
  ref_id TEXT DEFAULT '',          -- Panel-ID (Sites)
  created_at INTEGER,
  UNIQUE(type, ref_name)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER, action TEXT, customer_id INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS portal_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL, success INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_asg_customer ON assignments(customer_id);
CREATE INDEX IF NOT EXISTS idx_log_customer ON audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts_login ON portal_login_attempts(login, ts);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON portal_login_attempts(ip, ts);
"""

# Migration für Bestandsinstallationen: SCHEMA legt neue Spalten nur bei
# CREATE TABLE an, ALTER TABLE ist dafür separat nötig (additiv, verlustfrei).
_MIGRATIONS = (
    ('customers', 'portal_enabled', "INTEGER NOT NULL DEFAULT 0"),
    ('customers', 'portal_password_hash', "TEXT NOT NULL DEFAULT ''"),
    ('customers', 'portal_password_set_at', "INTEGER NOT NULL DEFAULT 0"),
    ('customers', 'portal_last_login', "INTEGER NOT NULL DEFAULT 0"),
    ('customers', 'max_sites', "INTEGER NOT NULL DEFAULT -1"),
)


def _column_exists(db, table, col):
    return any(r[1] == col for r in db.execute('PRAGMA table_info({})'.format(table)))


def _migrate(db):
    for table, col, decl in _MIGRATIONS:
        if not _column_exists(db, table, col):
            db.execute('ALTER TABLE {} ADD COLUMN {} {}'.format(table, col, decl))
    db.commit()


CUSTOMER_FIELDS = ('company', 'first_name', 'last_name', 'email', 'phone', 'street',
                   'zip', 'city', 'country', 'vat_id', 'note', 'status')
TYPES = ('site', 'mail_domain', 'mailbox', 'domain')

_LABEL_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(?<!-)$')


def normalize_domain(value):
    """Kleinschreibung + IDNA + Syntaxprüfung für einen Domain-Bereich (z. B. kunde.at)."""
    d = str(value or '').strip().lower().rstrip('.')
    if d.startswith('*.'):
        d = d[2:]
    try:
        d = d.encode('idna').decode('ascii')
    except UnicodeError:
        raise ValueError('Ungültige Domain: {}'.format(value))
    labels = d.split('.')
    if len(d) > 253 or len(labels) < 2 or not all(_LABEL_RE.match(x) for x in labels) or labels[-1].isdigit():
        raise ValueError('Ungültige Domain: {}'.format(value))
    return d
_SECRET_FIELDS = ('portal_password_hash',)


def _strip_secrets(row):
    d = dict(row)
    for k in _SECRET_FIELDS:
        d.pop(k, None)
    return d


def _ensure_dir():
    if not os.path.isdir(DATA_DIR):
        os.makedirs(DATA_DIR, mode=0o700)


def load_cfg():
    _ensure_dir()
    cfg = dict(DEFAULT_CFG)
    try:
        cfg.update(json.loads(open(CFG_FILE).read()))
    except Exception:
        pass
    return cfg


def save_cfg(cfg):
    _ensure_dir()
    tmp = CFG_FILE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CFG_FILE)


# ---------- Branding (Logo für das Kundenportal) ----------
LOGO_MAX_BYTES = 1024 * 1024
LOGO_EXTS = ('png', 'jpg', 'gif', 'webp', 'svg')


def _logo_type(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    head = data[:4096].lstrip(b'\xef\xbb\xbf \t\r\n').lower()
    if (head.startswith(b'<?xml') or head.startswith(b'<svg') or head.startswith(b'<!--')) and b'<svg' in head:
        low = data.lower()
        # Das Logo wird nur als <img> eingebunden (dort laufen keine Skripte) und
        # mit strikter CSP ausgeliefert - aktive Inhalte trotzdem gar nicht erst annehmen.
        for bad in (b'<script', b'javascript:', b'<foreignobject', b'<iframe', b'<embed', b'<object'):
            if bad in low:
                raise ValueError('SVG-Logo enthält aktive Inhalte (Skripte o. Ä.) und wurde abgelehnt')
        if re.search(rb'\son[a-z]+\s*=', low):
            raise ValueError('SVG-Logo enthält Event-Handler (onload o. Ä.) und wurde abgelehnt')
        return 'svg'
    return None


def logo_path():
    for ext in LOGO_EXTS:
        p = os.path.join(DATA_DIR, 'logo.' + ext)
        if os.path.isfile(p):
            return p
    return None


def save_logo(data):
    if not data:
        raise ValueError('Keine Datei übermittelt')
    if len(data) > LOGO_MAX_BYTES:
        raise ValueError('Logo ist zu groß (max. 1 MB)')
    ext = _logo_type(data)
    if not ext:
        raise ValueError('Nur PNG, JPG, GIF, WebP oder SVG sind als Logo erlaubt')
    _ensure_dir()
    remove_logo()
    target = os.path.join(DATA_DIR, 'logo.' + ext)
    tmp = target + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(data)
    os.chmod(tmp, 0o644)
    os.replace(tmp, target)
    return ext


def remove_logo():
    for ext in LOGO_EXTS:
        p = os.path.join(DATA_DIR, 'logo.' + ext)
        if os.path.isfile(p):
            os.remove(p)


class Store(object):
    def __init__(self, db_file=None):
        db_file = db_file or DB_FILE
        if db_file == DB_FILE:
            _ensure_dir()
        self.db = sqlite3.connect(db_file, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript(SCHEMA)
        _migrate(self.db)
        try:
            os.chmod(db_file, 0o600)
        except Exception:
            pass

    def close(self):
        try:
            self.db.close()
        except Exception:
            pass

    # ---------- Kunden ----------
    def list_customers(self, search=''):
        sql = """SELECT c.*,
                  (SELECT COUNT(*) FROM assignments a WHERE a.customer_id=c.id AND a.type='site') AS sites,
                  (SELECT COUNT(*) FROM assignments a WHERE a.customer_id=c.id AND a.type='mail_domain') AS mail_domains,
                  (SELECT COUNT(*) FROM assignments a WHERE a.customer_id=c.id AND a.type='mailbox') AS mailboxes
                 FROM customers c"""
        args = ()
        if search:
            like = '%' + search + '%'
            sql += """ WHERE c.customer_no LIKE ? OR c.company LIKE ? OR c.first_name LIKE ?
                       OR c.last_name LIKE ? OR c.email LIKE ?
                       OR c.id IN (SELECT customer_id FROM assignments WHERE ref_name LIKE ?)"""
            args = (like,) * 6
        sql += ' ORDER BY c.company COLLATE NOCASE, c.last_name COLLATE NOCASE'
        return [_strip_secrets(r) for r in self.db.execute(sql, args)]

    def get_customer(self, cid):
        r = self.db.execute('SELECT * FROM customers WHERE id=?', (cid,)).fetchone()
        return _strip_secrets(r) if r else None

    def _next_no(self, prefix):
        rows = self.db.execute('SELECT customer_no FROM customers WHERE customer_no LIKE ?', (prefix + '%',)).fetchall()
        n = 0
        for r in rows:
            try:
                n = max(n, int(r[0][len(prefix):]))
            except Exception:
                pass
        return '{}{:05d}'.format(prefix, n + 1)

    def save_customer(self, data, prefix='K-'):
        now = int(time.time())
        vals = {k: str(data.get(k, '') or '').strip() for k in CUSTOMER_FIELDS}
        if vals['status'] not in ('active', 'inactive'):
            vals['status'] = 'active'
        if not (vals['company'] or vals['last_name'] or vals['first_name']):
            raise ValueError('Firma oder Name ist erforderlich')
        if 'max_sites' in data and str(data.get('max_sites')).strip() != '':
            try:
                vals['max_sites'] = max(-1, int(data.get('max_sites')))
            except (TypeError, ValueError):
                raise ValueError('Max. Websites muss eine Zahl sein (-1 = Standard, 0 = unbegrenzt)')
        no = str(data.get('customer_no', '') or '').strip()
        cid = data.get('id')
        if cid:
            cid = int(cid)
            if not self.get_customer(cid):
                raise ValueError('Kunde nicht gefunden')
            if no:
                dup = self.db.execute('SELECT id FROM customers WHERE customer_no=? AND id<>?', (no, cid)).fetchone()
                if dup:
                    raise ValueError('Kundennummer bereits vergeben')
                vals['customer_no'] = no
            sets = ', '.join('{}=?'.format(k) for k in vals)
            self.db.execute('UPDATE customers SET {}, updated_at=? WHERE id=?'.format(sets),
                            tuple(vals.values()) + (now, cid))
            self.log('customer_edit', cid, vals.get('company') or vals.get('last_name'))
        else:
            vals['customer_no'] = no or self._next_no(prefix)
            if self.db.execute('SELECT id FROM customers WHERE customer_no=?', (vals['customer_no'],)).fetchone():
                raise ValueError('Kundennummer bereits vergeben')
            cols = ', '.join(vals.keys())
            ph = ', '.join('?' for _ in vals)
            cur = self.db.execute('INSERT INTO customers ({}, created_at, updated_at) VALUES ({}, ?, ?)'.format(cols, ph),
                                  tuple(vals.values()) + (now, now))
            cid = cur.lastrowid
            self.log('customer_add', cid, vals['customer_no'])
        self.db.commit()
        return cid

    def delete_customer(self, cid, force=False):
        n = self.db.execute('SELECT COUNT(*) FROM assignments WHERE customer_id=?', (cid,)).fetchone()[0]
        if n and not force:
            raise ValueError('Kunde hat noch {} Zuordnung(en). Erst lösen oder "trotzdem löschen" wählen.'.format(n))
        c = self.get_customer(cid)
        self.db.execute('DELETE FROM assignments WHERE customer_id=?', (cid,))
        self.db.execute('DELETE FROM customers WHERE id=?', (cid,))
        self.log('customer_delete', cid, (c or {}).get('customer_no', ''))
        self.db.commit()

    # ---------- Portal-Zugang ----------
    def get_portal_customer(self, login):
        """Für den Portal-Login: liefert den Kunden nur, wenn portal_enabled=1.
        Unterscheidet 'nicht gefunden' nicht von 'deaktiviert' (kein Enumeration-Signal)."""
        login = str(login or '').strip()
        if not login:
            return None
        r = self.db.execute(
            'SELECT * FROM customers WHERE customer_no=? COLLATE NOCASE AND portal_enabled=1', (login,)
        ).fetchone()
        return dict(r) if r else None

    def set_portal_access(self, cid, enabled):
        if not self.get_customer(cid):
            raise ValueError('Kunde nicht gefunden')
        self.db.execute('UPDATE customers SET portal_enabled=? WHERE id=?', (1 if enabled else 0, cid))
        self.log('portal_enable' if enabled else 'portal_disable', cid)
        self.db.commit()

    def set_portal_password(self, cid, new_password):
        if not self.get_customer(cid):
            raise ValueError('Kunde nicht gefunden')
        if len(str(new_password or '')) < 8:
            raise ValueError('Passwort muss mindestens 8 Zeichen haben')
        now = int(time.time())
        self.db.execute(
            'UPDATE customers SET portal_password_hash=?, portal_password_set_at=?, portal_enabled=1 WHERE id=?',
            (hash_password(new_password), now, cid))
        self.log('portal_password_set', cid)
        self.db.commit()

    def touch_portal_login(self, cid):
        self.db.execute('UPDATE customers SET portal_last_login=? WHERE id=?', (int(time.time()), cid))
        self.db.commit()

    def record_login_attempt(self, login, ip, success):
        self.db.execute('INSERT INTO portal_login_attempts (login, ip, ts, success) VALUES (?,?,?,?)',
                        (str(login or '').strip().lower(), str(ip or ''), int(time.time()), 1 if success else 0))
        # alte Einträge nebenbei aufräumen, damit die Tabelle nicht unbegrenzt wächst
        self.db.execute('DELETE FROM portal_login_attempts WHERE ts < ?', (int(time.time()) - 86400,))
        self.db.commit()

    def login_attempts_count(self, login, ip, window_seconds):
        since = int(time.time()) - window_seconds
        by_login = self.db.execute(
            'SELECT COUNT(*) FROM portal_login_attempts WHERE login=? AND success=0 AND ts>=?',
            (str(login or '').strip().lower(), since)).fetchone()[0]
        by_ip = self.db.execute(
            'SELECT COUNT(*) FROM portal_login_attempts WHERE ip=? AND success=0 AND ts>=?',
            (str(ip or ''), since)).fetchone()[0]
        return by_login, by_ip

    def is_assigned(self, cid, type_, ref_name):
        row = self.db.execute(
            'SELECT 1 FROM assignments WHERE customer_id=? AND type=? AND ref_name=?',
            (cid, type_, str(ref_name or '').strip().lower())).fetchone()
        return row is not None

    # ---------- Zuordnungen ----------
    def assignments(self, cid=None):
        if cid is None:
            rows = self.db.execute('SELECT * FROM assignments')
        else:
            rows = self.db.execute('SELECT * FROM assignments WHERE customer_id=? ORDER BY type, ref_name', (cid,))
        return [dict(r) for r in rows]

    def get_assignment(self, aid):
        r = self.db.execute('SELECT * FROM assignments WHERE id=?', (aid,)).fetchone()
        return dict(r) if r else None

    def owner_map(self):
        m = {}
        for r in self.db.execute("""SELECT a.type, a.ref_name, a.customer_id, c.customer_no, c.company, c.first_name, c.last_name
                                    FROM assignments a JOIN customers c ON c.id=a.customer_id"""):
            label = r['company'] or (r['first_name'] + ' ' + r['last_name']).strip()
            m[(r['type'], r['ref_name'])] = {'customer_id': r['customer_id'], 'customer_no': r['customer_no'], 'label': label}
        return m

    def assign(self, cid, items):
        if not self.get_customer(cid):
            raise ValueError('Kunde nicht gefunden')
        now = int(time.time())
        added, skipped = [], []
        for it in items:
            t = it.get('type')
            name = str(it.get('ref_name', '')).strip().lower()
            if t not in TYPES or not name:
                continue
            row = self.db.execute('SELECT customer_id FROM assignments WHERE type=? AND ref_name=?', (t, name)).fetchone()
            if row:
                skipped.append({'type': t, 'ref_name': name, 'owner': row[0]})
                continue
            self.db.execute('INSERT INTO assignments (customer_id, type, ref_name, ref_id, created_at) VALUES (?,?,?,?,?)',
                            (cid, t, name, str(it.get('ref_id', '') or ''), now))
            added.append({'type': t, 'ref_name': name})
        if added:
            self.log('assign', cid, json.dumps(added, ensure_ascii=False))
        self.db.commit()
        return added, skipped

    def assign_domain(self, cid, domain):
        """Domain-Bereich zuordnen: der Kunde darf darin Websites und Subdomains anlegen."""
        d = normalize_domain(domain)
        for r in self.db.execute("SELECT customer_id, ref_name FROM assignments WHERE type='domain'"):
            other = r['ref_name']
            if r['customer_id'] != cid and (d == other or d.endswith('.' + other) or other.endswith('.' + d)):
                raise ValueError('{} überschneidet sich mit dem Domain-Bereich {} eines anderen Kunden'.format(d, other))
        added, skipped = self.assign(cid, [{'type': 'domain', 'ref_name': d}])
        if not added:
            raise ValueError('Domain-Bereich {} ist bereits zugeordnet'.format(d))
        return d

    def unassign(self, aid):
        r = self.db.execute('SELECT * FROM assignments WHERE id=?', (aid,)).fetchone()
        if not r:
            raise ValueError('Zuordnung nicht gefunden')
        self.db.execute('DELETE FROM assignments WHERE id=?', (aid,))
        self.log('unassign', r['customer_id'], '{}: {}'.format(r['type'], r['ref_name']))
        self.db.commit()
        return dict(r)

    # ---------- Log ----------
    def log(self, action, cid, detail=''):
        self.db.execute('INSERT INTO audit_log (ts, action, customer_id, detail) VALUES (?,?,?,?)',
                        (int(time.time()), action, cid, detail))

    def get_log(self, cid, limit=100):
        return [dict(r) for r in self.db.execute(
            'SELECT * FROM audit_log WHERE customer_id=? ORDER BY id DESC LIMIT ?', (cid, limit))]
