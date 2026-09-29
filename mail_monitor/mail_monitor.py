#!/usr/bin/env python3
# coding: utf-8
"""Mail-Monitor: prüft, ob der Mailserver wirklich Mails senden UND empfangen
kann, und meldet Störungen per Discord-Webhook.

Ein laufender Postfix/Dovecot heißt noch nicht, dass Mails durchgehen. Darum
macht das Skript bei jedem Lauf einen echten Rundlauf:

  Ausgang:  eigener Server (SMTP-Login) -> externes Postfach (z. B. GMX/Gmail),
            Zustellung per IMAP im externen Postfach nachgewiesen
  Eingang:  externes Postfach (SMTP)    -> eigenes Postfach,
            Zustellung per IMAP auf dem eigenen Server nachgewiesen

Dazu kommen Port-/Banner-Checks, Ablauf der TLS-Zertifikate und die Größe der
Postfix-Warteschlange. Testmails werden nach dem Nachweis wieder gelöscht.

Benachrichtigt wird erst nach `alert_after_failures` Fehlschlägen in Folge,
danach höchstens alle `repeat_alert_minutes` erneut und einmal, sobald alles
wieder funktioniert.

Nur Python-Standardbibliothek (>= 3.7), z. B. per Cron alle 10 Minuten:

  */10 * * * * python3 /pfad/mail_monitor.py -c /etc/mail_monitor.ini

Aufrufe:
  mail_monitor.py -c datei.ini                 # Prüfen + ggf. melden
  mail_monitor.py -c datei.ini -v --no-alert   # nur testen, nichts senden
  mail_monitor.py -c datei.ini --test-webhook  # Testnachricht an Discord

Exit-Code: 0 = alles ok, 1 = Warnung, 2 = Fehler, 3 = Konfigurationsfehler.
"""
import argparse
import configparser
import email.utils
import imaplib
import json
import os
import re
import shutil
import smtplib
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from email.message import EmailMessage

OK, WARN, FAIL = 'ok', 'warn', 'fail'
RANK = {OK: 0, WARN: 1, FAIL: 2}
SUBJECT_PREFIX = '[mail-monitor]'
COLORS = {OK: 0x2ECC71, WARN: 0xF1C40F, FAIL: 0xE74C3C}


class ConfigError(Exception):
    pass


class Result(object):
    def __init__(self, name, status, message):
        self.name, self.status, self.message = name, status, message

    def __repr__(self):
        return 'Result(%r, %r, %r)' % (self.name, self.status, self.message)


# --------------------------------------------------------------------------
# Konfiguration
# --------------------------------------------------------------------------

DEFAULTS = {
    'general': {
        'name': socket.gethostname(),
        'state_file': '/var/lib/mail_monitor/state.json',
        'timeout': '30',
        'wait_seconds': '240',
        'poll_interval': '15',
        'alert_after_failures': '2',
        'repeat_alert_minutes': '120',
        'notify_recovery': 'yes',
    },
    'discord': {'webhook_url': '', 'mention': '', 'username': 'Mail-Monitor'},
    'checks': {
        'outbound': 'yes',
        'inbound': 'yes',
        'ports': '',
        'cert_warn_days': '14',
        'queue': 'no',
        'queue_warn': '20',
        'queue_fail': '100',
        'queue_command': '',
    },
}


class Account(object):
    """SMTP/IMAP-Zugang eines Postfachs (eigener Server oder extern)."""

    def __init__(self, section, sec):
        def need(key):
            val = sec.get(key, '').strip()
            if not val:
                raise ConfigError('[%s] %s fehlt' % (section, key))
            return val

        self.section = section
        self.address = need('address')
        user = sec.get('user', '').strip() or self.address
        password = sec.get('password', '')
        self.smtp_host = need('smtp_host')
        self.smtp_security = sec.get('smtp_security', 'starttls').strip().lower()
        self.smtp_port = int(sec.get('smtp_port', '') or
                             {'ssl': 465, 'starttls': 587}.get(self.smtp_security, 25))
        self.smtp_user = sec.get('smtp_user', '').strip() or user
        self.smtp_password = sec.get('smtp_password', '') or password
        self.imap_host = sec.get('imap_host', '').strip() or self.smtp_host
        self.imap_security = sec.get('imap_security', 'ssl').strip().lower()
        self.imap_port = int(sec.get('imap_port', '') or
                             (993 if self.imap_security == 'ssl' else 143))
        self.imap_user = sec.get('imap_user', '').strip() or user
        self.imap_password = sec.get('imap_password', '') or password
        folders = sec.get('folders', 'INBOX')
        self.folders = [f.strip() for f in folders.split(',') if f.strip()]
        spam = sec.get('spam_folders', '')
        self.spam_folders = [f.strip() for f in spam.split(',') if f.strip()]
        self.verify_tls = sec.getboolean('verify_tls', True)
        for key, val in (('smtp_security', self.smtp_security),
                         ('imap_security', self.imap_security)):
            if val not in ('ssl', 'starttls', 'none'):
                raise ConfigError('[%s] %s muss ssl, starttls oder none sein'
                                  % (section, key))


class Config(object):
    def __init__(self, parser):
        for sec, values in DEFAULTS.items():
            if not parser.has_section(sec):
                parser.add_section(sec)
            for key, val in values.items():
                if not parser.has_option(sec, key):
                    parser.set(sec, key, val)
        g, c = parser['general'], parser['checks']
        self.name = g.get('name')
        self.state_file = g.get('state_file')
        self.timeout = g.getfloat('timeout')
        self.wait_seconds = g.getfloat('wait_seconds')
        self.poll_interval = max(1.0, g.getfloat('poll_interval'))
        self.alert_after = max(1, g.getint('alert_after_failures'))
        self.repeat_minutes = g.getfloat('repeat_alert_minutes')
        self.notify_recovery = g.getboolean('notify_recovery')
        d = parser['discord']
        self.webhook_url = d.get('webhook_url', '').strip()
        self.mention = d.get('mention', '').strip()
        self.username = d.get('username', '').strip() or 'Mail-Monitor'
        self.check_outbound = c.getboolean('outbound')
        self.check_inbound = c.getboolean('inbound')
        self.ports = [p.strip() for p in c.get('ports').split(',') if p.strip()]
        self.cert_warn_days = c.getint('cert_warn_days')
        self.check_queue = c.getboolean('queue')
        self.queue_warn = c.getint('queue_warn')
        self.queue_fail = c.getint('queue_fail')
        self.queue_command = c.get('queue_command').strip()
        self.server = self.external = None
        if self.check_outbound or self.check_inbound:
            for sec in ('server', 'external'):
                if not parser.has_section(sec):
                    raise ConfigError('Abschnitt [%s] fehlt' % sec)
            self.server = Account('server', parser['server'])
            self.external = Account('external', parser['external'])


def load_config(path):
    parser = configparser.ConfigParser(interpolation=None)
    if not os.path.isfile(path):
        example = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               'mail_monitor.example.ini')
        raise ConfigError('%s existiert nicht. Vorlage kopieren und anpassen:\n'
                          '  cp %s %s && chmod 600 %s' % (path, example, path, path))
    try:
        parser.read(path, encoding='utf-8')
    except (OSError, configparser.Error) as e:
        raise ConfigError('%s nicht lesbar: %s' % (path, e))
    try:
        return Config(parser)
    except ValueError as e:
        raise ConfigError(str(e))


# --------------------------------------------------------------------------
# SMTP / IMAP
# --------------------------------------------------------------------------

def _tls_context(verify=True):
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def smtp_connect(acc, timeout):
    ctx = _tls_context(acc.verify_tls)
    if acc.smtp_security == 'ssl':
        smtp = smtplib.SMTP_SSL(acc.smtp_host, acc.smtp_port, timeout=timeout,
                                context=ctx)
    else:
        smtp = smtplib.SMTP(acc.smtp_host, acc.smtp_port, timeout=timeout)
        smtp.ehlo()
        if acc.smtp_security == 'starttls':
            smtp.starttls(context=ctx)
            smtp.ehlo()
    if acc.smtp_password:
        smtp.login(acc.smtp_user, acc.smtp_password)
    return smtp


def imap_connect(acc, timeout):
    ctx = _tls_context(acc.verify_tls)
    if acc.imap_security == 'ssl':
        imap = imaplib.IMAP4_SSL(acc.imap_host, acc.imap_port, ssl_context=ctx)
    else:
        imap = imaplib.IMAP4(acc.imap_host, acc.imap_port)
        if acc.imap_security == 'starttls':
            imap.starttls(ssl_context=ctx)
    if imap.sock:
        imap.sock.settimeout(timeout)
    imap.login(acc.imap_user, acc.imap_password)
    return imap


def build_probe(sender, recipient, token, label):
    msg = EmailMessage()
    msg['From'] = sender
    msg['To'] = recipient
    msg['Subject'] = '%s %s %s' % (SUBJECT_PREFIX, label, token)
    msg['Date'] = email.utils.formatdate(localtime=True)
    msg['Message-ID'] = email.utils.make_msgid(domain=sender.split('@')[-1])
    msg['X-Mail-Monitor'] = token
    msg['Auto-Submitted'] = 'auto-generated'
    msg.set_content('Automatische Testmail des Mail-Monitors (%s).\n'
                    'Sie wird nach dem Empfang automatisch gelöscht.\n' % label)
    return msg


def send_probe(src, dst, token, label, timeout):
    msg = build_probe(src.address, dst.address, token, label)
    smtp = smtp_connect(src, timeout)
    try:
        refused = smtp.send_message(msg)
    finally:
        try:
            smtp.quit()
        except Exception:
            pass
    if refused:
        raise smtplib.SMTPRecipientsRefused(refused)


def _quote_folder(name):
    if re.match(r'^[A-Za-z0-9_.\-/]+$', name):
        return name
    return '"%s"' % name.replace('\\', '\\\\').replace('"', '\\"')


def find_probes(acc, tokens, timeout, cleanup=True):
    """Sucht Testmails in den Ordnern von `acc`.

    Liefert {token: ordner} für gefundene Tokens. Mit `cleanup` werden alle
    Monitor-Mails in den durchsuchten Ordnern gelöscht (auch verspätete aus
    früheren Läufen), sobald wenigstens ein Token gefunden wurde."""
    found = {}
    imap = imap_connect(acc, timeout)
    try:
        for folder in acc.folders + acc.spam_folders:
            typ, _ = imap.select(_quote_folder(folder))
            if typ != 'OK':
                continue
            to_delete = []
            for token in tokens:
                if token in found:
                    continue
                typ, data = imap.search(None, 'SUBJECT', '"%s"' % token)
                ids = data[0].split() if typ == 'OK' and data and data[0] else []
                if ids:
                    found[token] = folder
            if cleanup and found:
                typ, data = imap.search(None, 'SUBJECT', '"%s"' % SUBJECT_PREFIX)
                if typ == 'OK' and data and data[0]:
                    to_delete = data[0].split()
            if to_delete:
                imap.store(b','.join(to_delete).decode(), '+FLAGS', '\\Deleted')
                imap.expunge()
            imap.close()
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    return found


def _err(e):
    text = str(e) or e.__class__.__name__
    if isinstance(e, smtplib.SMTPResponseException):
        msg = e.smtp_error
        if isinstance(msg, bytes):
            msg = msg.decode('utf-8', 'replace')
        text = '%s %s' % (e.smtp_code, msg)
    return '%s: %s' % (e.__class__.__name__, text.strip())


def check_roundtrips(cfg, log, sleep=time.sleep, clock=time.time):
    """Ausgang (server -> external) und Eingang (external -> server)."""
    probes = []   # (name, src, dst, token)
    if cfg.check_outbound:
        probes.append(('Ausgang', cfg.server, cfg.external))
    if cfg.check_inbound:
        probes.append(('Eingang', cfg.external, cfg.server))

    results, pending = [], []
    for name, src, dst in probes:
        token = 'MM' + uuid.uuid4().hex[:16]
        try:
            send_probe(src, dst, token, name, cfg.timeout)
            log('%s: Testmail %s -> %s gesendet (%s)' % (name, src.address,
                                                         dst.address, token))
            pending.append((name, src, dst, token, clock()))
        except Exception as e:
            where = 'eigener Server' if src.section == 'server' else 'externer Server'
            results.append(Result(name, FAIL, 'Senden über %s (%s:%s) fehlgeschlagen: %s'
                                  % (where, src.smtp_host, src.smtp_port, _err(e))))

    deadline = clock() + cfg.wait_seconds
    last_error = {}
    while pending:
        sleep(cfg.poll_interval)
        still = []
        for item in pending:
            name, src, dst, token, sent = item
            try:
                found = find_probes(dst, [token], cfg.timeout)
                last_error.pop(name, None)
            except Exception as e:
                found = {}
                last_error[name] = _err(e)
                log('%s: IMAP-Fehler bei %s: %s' % (name, dst.imap_host, last_error[name]))
            if token in found:
                secs = clock() - sent
                folder = found[token]
                if folder in dst.spam_folders:
                    results.append(Result(name, WARN, 'Zugestellt nach %.0fs, aber im Spam-Ordner '
                                          '"%s" von %s gelandet' % (secs, folder, dst.address)))
                else:
                    results.append(Result(name, OK, 'Zugestellt nach %.0fs (%s -> %s)'
                                          % (secs, src.address, dst.address)))
                log('%s: gefunden nach %.0fs in %s' % (name, secs, folder))
            else:
                still.append(item)
        pending = still
        if pending and clock() >= deadline:
            for name, src, dst, token, sent in pending:
                msg = 'Testmail %s -> %s nach %.0fs nicht angekommen' % (
                    src.address, dst.address, clock() - sent)
                if name in last_error:
                    msg += ' (IMAP %s: %s)' % (dst.imap_host, last_error[name])
                results.append(Result(name, FAIL, msg))
            break
    order = {'Ausgang': 0, 'Eingang': 1}
    return sorted(results, key=lambda r: order.get(r.name, 9))


# --------------------------------------------------------------------------
# Ports, Zertifikate, Warteschlange
# --------------------------------------------------------------------------

def _cert_days_left(cert):
    return (ssl.cert_time_to_seconds(cert['notAfter']) - time.time()) / 86400.0


def check_port(spec, cfg):
    """spec: host:port[:ssl|starttls|plain] – SMTP/IMAP/POP3 werden am Port erkannt."""
    parts = spec.split(':')
    if len(parts) < 2 or not parts[1].isdigit():
        return Result('Port %s' % spec, FAIL, 'Ungültige Angabe (erwartet host:port)')
    host, port = parts[0], int(parts[1])
    mode = parts[2].lower() if len(parts) > 2 else (
        'ssl' if port in (465, 993, 995) else 'starttls' if port in (587, 143, 110) else 'plain')
    name = 'Port %s:%s' % (host, port)
    proto = 'imap' if port in (143, 993) else 'pop3' if port in (110, 995) else 'smtp'
    ctx = ssl.create_default_context()
    try:
        start = time.time()
        sock = socket.create_connection((host, port), timeout=cfg.timeout)
        try:
            if mode == 'ssl':
                sock = ctx.wrap_socket(sock, server_hostname=host)
            f = sock.makefile('rb')
            banner = f.readline().decode('utf-8', 'replace').strip()
            line = banner
            while proto == 'smtp' and line[3:4] == '-':   # mehrzeilige Begrüßung
                line = f.readline().decode('utf-8', 'replace').strip()
            ok_prefix = {'smtp': '220', 'imap': '* OK', 'pop3': '+OK'}[proto]
            if not banner.startswith(ok_prefix):
                return Result(name, FAIL, 'Unerwartete Begrüßung: %r' % banner[:120])
            if mode == 'starttls':
                if proto == 'smtp':
                    sock.sendall(b'EHLO mail-monitor\r\n')
                    while True:
                        line = f.readline().decode('utf-8', 'replace')
                        if not line or line[3:4] != '-':
                            break
                    sock.sendall(b'STARTTLS\r\n')
                    expect = '220'
                elif proto == 'imap':
                    sock.sendall(b'a1 STARTTLS\r\n')
                    expect = 'a1 OK'
                else:
                    sock.sendall(b'STLS\r\n')
                    expect = '+OK'
                resp = f.readline().decode('utf-8', 'replace').strip()
                if not resp.startswith(expect):
                    return Result(name, FAIL, 'STARTTLS abgelehnt: %r' % resp[:120])
                f.close()
                sock = ctx.wrap_socket(sock, server_hostname=host)
            msg = 'erreichbar (%.1fs)' % (time.time() - start)
            if mode in ('ssl', 'starttls'):
                days = _cert_days_left(sock.getpeercert())
                msg += ', Zertifikat gültig noch %d Tage' % days
                if days < 0:
                    return Result(name, FAIL, 'Zertifikat abgelaufen')
                if days < cfg.cert_warn_days:
                    return Result(name, WARN, msg)
            return Result(name, OK, msg)
        finally:
            try:
                sock.close()
            except Exception:
                pass
    except ssl.SSLCertVerificationError as e:
        return Result(name, FAIL, 'Zertifikat ungültig: %s' % getattr(e, 'verify_message', e))
    except Exception as e:
        return Result(name, FAIL, 'nicht erreichbar: %s' % _err(e))


def parse_queue(output):
    """Anzahl Mails in der Ausgabe von `postqueue -p` / `mailq` (Postfix, Exim)."""
    text = output.strip()
    if not text or 'queue is empty' in text.lower():
        return 0
    m = re.search(r'in (\d+) Requests?\.', text)
    if m:
        return int(m.group(1))
    # Exim: "  1h  2.1K 1abcDE-000123-Xy <absender>"
    return len(re.findall(r'^\s*\d+[smhdw]\s+\S+\s+\w{6}-\w{6,}-\w{2,}', text, re.M))


def queue_details(output, spool='/var/spool/postfix'):
    """Kurzbeschreibung, wo und warum Mails hängen (Postfix)."""
    parts = []
    counts = []
    for q in ('maildrop', 'incoming', 'active', 'deferred', 'hold'):
        n = 0
        for _, _, files in os.walk(os.path.join(spool, q)):
            n += len(files)
        if n:
            counts.append('%s %d' % (q, n))
    if counts:
        parts.append(', '.join(counts))
    senders, reasons = {}, {}
    for line in output.splitlines():
        m = re.match(r'^[0-9A-Za-z]{6,}[*!]?\s+\d+\s+\w{3} \w{3}\s+\d+ [\d:]+\s+(\S+)', line)
        if m:
            senders[m.group(1)] = senders.get(m.group(1), 0) + 1
            continue
        m = re.match(r'^\s*\((.+)\)\s*$', line)
        if m:
            reason = re.sub(r'\s+', ' ', m.group(1))[:160]
            reasons[reason] = reasons.get(reason, 0) + 1

    def top(d):
        k = max(d, key=d.get)
        return '%dx %s' % (d[k], k)
    if senders:
        parts.append('häufigster Absender: ' + top(senders))
    if reasons:
        parts.append('häufigster Grund: ' + top(reasons))
    return '; '.join(parts)


def check_queue(cfg):
    cmd = cfg.queue_command.split() if cfg.queue_command else None
    if not cmd:
        for cand in (['postqueue', '-p'], ['mailq']):
            if shutil.which(cand[0]) or os.path.exists('/usr/sbin/' + cand[0]):
                cmd = cand
                break
    if not cmd:
        return Result('Warteschlange', WARN, 'postqueue/mailq nicht gefunden')
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             timeout=cfg.timeout, universal_newlines=True).stdout
    except Exception as e:
        return Result('Warteschlange', WARN, '%s fehlgeschlagen: %s' % (' '.join(cmd), _err(e)))
    n = parse_queue(out)
    status = FAIL if n >= cfg.queue_fail else WARN if n >= cfg.queue_warn else OK
    msg = '%d Mail(s) in der Warteschlange' % n
    if n:
        details = queue_details(out)
        if details:
            msg += ' (%s)' % details
    return Result('Warteschlange', status, msg)


def run_checks(cfg, log):
    results = [check_port(p, cfg) for p in cfg.ports]
    for r in results:
        log('%s: %s' % (r.name, r.message))
    if cfg.check_queue:
        results.append(check_queue(cfg))
        log('%s: %s' % (results[-1].name, results[-1].message))
    results.extend(check_roundtrips(cfg, log))
    return results


# --------------------------------------------------------------------------
# Zustand + Discord
# --------------------------------------------------------------------------

def load_state(path):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (IOError, OSError, ValueError):
        return {}


def save_state(path, state):
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, 0o700)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def overall(results):
    worst = OK
    for r in results:
        if RANK[r.status] > RANK[worst]:
            worst = r.status
    return worst


def decide(state, results, cfg, now):
    """Aktualisiert `state` und liefert 'alert', 'recovery' oder None."""
    status = overall(results)
    state['last_run'] = now
    state['last_status'] = status
    state['last_results'] = [[r.name, r.status, r.message] for r in results]
    if status == OK:
        state['failures'] = 0
        if state.pop('alerted', False):
            state.pop('last_alert', None)
            return 'recovery' if cfg.notify_recovery else None
        return None
    state['failures'] = state.get('failures', 0) + 1
    if state['failures'] < cfg.alert_after:
        return None
    signature = sorted('%s:%s' % (r.name, r.status) for r in results if r.status != OK)
    changed = signature != state.get('signature')
    state['signature'] = signature
    last = state.get('last_alert')
    due = (last is None or changed or
           (cfg.repeat_minutes > 0 and now - last >= cfg.repeat_minutes * 60))
    if due:
        state['alerted'] = True
        state['last_alert'] = now
        return 'alert'
    return None


def discord_payload(kind, results, cfg, failures=0):
    icons = {OK: '✅', WARN: '⚠️', FAIL: '❌'}
    status = overall(results)
    if kind == 'recovery':
        title = 'Mailserver %s funktioniert wieder' % cfg.name
        color = COLORS[OK]
    elif kind == 'test':
        title = 'Mail-Monitor %s: Testnachricht' % cfg.name
        color = COLORS[OK]
    else:
        word = 'Störung' if status == FAIL else 'Warnung'
        title = '%s: Mailserver %s' % (word, cfg.name)
        color = COLORS[status]
    lines = ['%s **%s** – %s' % (icons[r.status], r.name, r.message) for r in results]
    desc = '\n'.join(lines) or 'Webhook ist korrekt eingerichtet.'
    if kind == 'alert' and failures > 1:
        desc += '\n\n%d fehlgeschlagene Prüfungen in Folge.' % failures
    payload = {
        'username': cfg.username,
        'embeds': [{
            'title': title[:256],
            'description': desc[:4000],
            'color': color,
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }],
        'allowed_mentions': {'parse': ['users', 'roles', 'everyone']},
    }
    if cfg.mention and kind == 'alert':
        payload['content'] = cfg.mention
    return payload


def send_discord(url, payload, timeout=15):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode('utf-8'), method='POST',
        headers={'Content-Type': 'application/json',
                 'User-Agent': 'mail-monitor/1.0'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                try:
                    wait = float(json.loads(e.read().decode()).get('retry_after', 2))
                except Exception:
                    wait = 2
                time.sleep(min(wait, 30))
                continue
            raise


# --------------------------------------------------------------------------
# Hauptprogramm
# --------------------------------------------------------------------------

def _lock(path):
    try:
        import fcntl
    except ImportError:   # Windows: ohne Sperre
        return open(os.devnull, 'w')
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, 0o700)
    fh = open(path + '.lock', 'w')
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        fh.close()
        return None
    return fh


def main(argv=None):
    ap = argparse.ArgumentParser(description='Prüft Ein- und Ausgang eines Mailservers '
                                             'und meldet Störungen per Discord.')
    ap.add_argument('-c', '--config', default='/etc/mail_monitor.ini')
    ap.add_argument('-v', '--verbose', action='store_true', help='Fortschritt ausgeben')
    ap.add_argument('--no-alert', action='store_true',
                    help='nichts an Discord senden, Zustand nicht ändern')
    ap.add_argument('--test-webhook', action='store_true',
                    help='nur eine Testnachricht an Discord senden')
    args = ap.parse_args(argv)

    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print('Konfigurationsfehler: %s' % e, file=sys.stderr)
        return 3

    def log(msg):
        if args.verbose:
            print(time.strftime('%H:%M:%S ') + msg, flush=True)

    if args.test_webhook:
        if not cfg.webhook_url:
            print('[discord] webhook_url ist leer', file=sys.stderr)
            return 3
        send_discord(cfg.webhook_url, discord_payload('test', [], cfg))
        print('Testnachricht gesendet.')
        return 0

    socket.setdefaulttimeout(cfg.timeout)
    lock = _lock(cfg.state_file)
    if lock is None:
        print('Ein anderer Lauf ist noch aktiv, breche ab.', file=sys.stderr)
        return 0

    try:
        return _run(cfg, args, log)
    finally:
        lock.close()


def _run(cfg, args, log):
    results = run_checks(cfg, log)
    status = overall(results)
    for r in results:
        print('[%s] %s: %s' % (r.status.upper(), r.name, r.message))

    if args.no_alert:
        return RANK[status]

    state = load_state(cfg.state_file)
    action = decide(state, results, cfg, time.time())
    if action:
        if cfg.webhook_url:
            try:
                send_discord(cfg.webhook_url,
                             discord_payload(action, results, cfg, state.get('failures', 0)))
                log('Discord-Benachrichtigung gesendet (%s)' % action)
            except Exception as e:
                print('Discord-Webhook fehlgeschlagen: %s' % _err(e), file=sys.stderr)
                if action == 'alert':   # beim nächsten Lauf erneut versuchen
                    state.pop('last_alert', None)
                else:
                    state['alerted'] = True
        else:
            print('Keine webhook_url konfiguriert – Benachrichtigung (%s) entfällt.' % action,
                  file=sys.stderr)
    save_state(cfg.state_file, state)
    return RANK[status]


if __name__ == '__main__':
    sys.exit(main())
