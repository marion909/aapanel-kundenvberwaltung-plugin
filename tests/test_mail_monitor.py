# coding: utf-8
"""Tests für das eigenständige Skript mail_monitor/mail_monitor.py."""
import configparser, os, socket, sys, tempfile, threading, unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'mail_monitor'))
import mail_monitor as mm  # noqa: E402

EXAMPLE = os.path.join(ROOT, 'mail_monitor', 'mail_monitor.example.ini')


def make_cfg(**general):
    p = configparser.ConfigParser(interpolation=None)
    p.read(EXAMPLE, encoding='utf-8')
    for k, v in general.items():
        p.set('general', k, str(v))
    return mm.Config(p)


class FakeClock(object):
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


class ConfigTest(unittest.TestCase):
    def test_example_loads(self):
        cfg = mm.load_config(EXAMPLE)
        self.assertEqual(cfg.server.smtp_port, 587)
        self.assertEqual(cfg.external.imap_port, 993)
        self.assertEqual(cfg.external.spam_folders, ['Spamverdacht'])
        self.assertEqual(len(cfg.ports), 3)

    def test_missing_field(self):
        p = configparser.ConfigParser(interpolation=None)
        p.read(EXAMPLE, encoding='utf-8')
        p.remove_option('server', 'smtp_host')
        with self.assertRaises(mm.ConfigError):
            mm.Config(p)

    def test_port_defaults_follow_security(self):
        p = configparser.ConfigParser(interpolation=None)
        p.read(EXAMPLE, encoding='utf-8')
        p.remove_option('server', 'smtp_port')
        p.set('server', 'smtp_security', 'ssl')
        self.assertEqual(mm.Config(p).server.smtp_port, 465)


class QueueTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(mm.parse_queue('Mail queue is empty\n'), 0)
        self.assertEqual(mm.parse_queue(''), 0)

    def test_postfix(self):
        out = ('-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------\n'
               'A1B2C3D4E5*    1234 Mon Sep 29 10:00:00  a@example.com\n'
               '                                         b@example.org\n\n'
               '-- 3 Kbytes in 3 Requests.\n')
        self.assertEqual(mm.parse_queue(out), 3)
        self.assertEqual(mm.parse_queue('-- 1 Kbytes in 1 Request.'), 1)

    def test_details(self):
        out = ('-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------\n'
               'A1B2C3D4E5     1234 Mon Sep 29 10:00:00  root@mail.example.com\n'
               '(connect to gmx.net[1.2.3.4]:25: Connection timed out)\n'
               '                                         a@gmx.net\n\n'
               'B1B2C3D4E5!    1234 Mon Sep 29 10:05:00  root@mail.example.com\n'
               '(connect to gmx.net[1.2.3.4]:25: Connection timed out)\n'
               '                                         a@gmx.net\n\n'
               '-- 3 Kbytes in 2 Requests.\n')
        with tempfile.TemporaryDirectory() as spool:
            os.makedirs(os.path.join(spool, 'deferred', 'A'))
            open(os.path.join(spool, 'deferred', 'A', 'A1B2C3D4E5'), 'w').close()
            d = mm.queue_details(out, spool)
        self.assertIn('deferred 1', d)
        self.assertIn('2x root@mail.example.com', d)
        self.assertIn('2x connect to gmx.net', d)


class DecideTest(unittest.TestCase):
    def setUp(self):
        self.cfg = make_cfg(alert_after_failures=2, repeat_alert_minutes=60)
        self.bad = [mm.Result('Ausgang', mm.FAIL, 'weg')]
        self.good = [mm.Result('Ausgang', mm.OK, 'ok')]

    def test_alert_after_threshold_repeat_and_recovery(self):
        st = {}
        self.assertIsNone(mm.decide(st, self.bad, self.cfg, 0))
        self.assertEqual(mm.decide(st, self.bad, self.cfg, 600), 'alert')
        self.assertIsNone(mm.decide(st, self.bad, self.cfg, 1200))
        self.assertEqual(mm.decide(st, self.bad, self.cfg, 600 + 3600), 'alert')
        # Art der Störung ändert sich -> sofort melden
        both = self.bad + [mm.Result('Eingang', mm.FAIL, 'weg')]
        self.assertEqual(mm.decide(st, both, self.cfg, 4300), 'alert')
        self.assertEqual(mm.decide(st, self.good, self.cfg, 4900), 'recovery')
        self.assertIsNone(mm.decide(st, self.good, self.cfg, 5500))
        self.assertEqual(st['failures'], 0)

    def test_single_blip_is_silent(self):
        st = {}
        self.assertIsNone(mm.decide(st, self.bad, self.cfg, 0))
        self.assertIsNone(mm.decide(st, self.good, self.cfg, 600))

    def test_payload(self):
        p = mm.discord_payload('alert', self.bad, self.cfg, 2)
        self.assertIn('Störung', p['embeds'][0]['title'])
        self.assertIn('Ausgang', p['embeds'][0]['description'])
        self.assertEqual(p['embeds'][0]['color'], mm.COLORS[mm.FAIL])


class RoundtripTest(unittest.TestCase):
    def run_rt(self, deliver):
        """deliver(dst_section, token) -> Ordner oder None."""
        cfg = make_cfg(wait_seconds=60, poll_interval=10)
        sent = []

        def fake_send(src, dst, token, label, timeout):
            if src.section == 'server' and deliver('send-server', token) == 'error':
                raise mm.smtplib.SMTPAuthenticationError(535, b'auth failed')
            sent.append((dst.section, token))

        def fake_find(acc, tokens, timeout, cleanup=True):
            out = {}
            for sec, tok in sent:
                if sec == acc.section and tok in tokens:
                    folder = deliver(sec, tok)
                    if folder:
                        out[tok] = folder
            return out

        clock = FakeClock()
        with mock.patch.object(mm, 'send_probe', fake_send), \
                mock.patch.object(mm, 'find_probes', fake_find):
            return mm.check_roundtrips(cfg, lambda m: None, clock.sleep, clock)

    def test_both_ok(self):
        res = self.run_rt(lambda sec, tok: 'INBOX')
        self.assertEqual([(r.name, r.status) for r in res],
                         [('Ausgang', mm.OK), ('Eingang', mm.OK)])

    def test_inbound_lost(self):
        res = self.run_rt(lambda sec, tok: None if sec == 'server' else 'INBOX')
        self.assertEqual([(r.name, r.status) for r in res],
                         [('Ausgang', mm.OK), ('Eingang', mm.FAIL)])
        self.assertIn('nicht angekommen', res[1].message)

    def test_outbound_spam_is_warning(self):
        res = self.run_rt(lambda sec, tok: 'Spamverdacht' if sec == 'external' else 'INBOX')
        self.assertEqual(res[0].status, mm.WARN)

    def test_smtp_send_error(self):
        res = self.run_rt(lambda sec, tok: 'error' if sec == 'send-server' else 'INBOX')
        self.assertEqual(res[0].status, mm.FAIL)
        self.assertIn('535', res[0].message)
        self.assertEqual(res[1].status, mm.OK)


class FakeIMAP(object):
    """Minimaler IMAP-Server im Speicher: {ordner: {id: betreff}}."""
    boxes = {}

    def __init__(self, *a, **kw):
        self.sock = None
        self.sel = None

    def login(self, u, p):
        return 'OK', [b'']

    def select(self, folder):
        folder = folder.strip('"')
        if folder not in self.boxes:
            return 'NO', [b'']
        self.sel = folder
        return 'OK', [b'']

    def search(self, charset, key, value):
        needle = value.strip('"')
        ids = [i for i, subj in self.boxes[self.sel].items() if needle in subj]
        return 'OK', [' '.join(ids).encode()]

    def store(self, ids, op, flag):
        for i in ids.split(','):
            self.boxes[self.sel].pop(i, None)
        return 'OK', [b'']

    def expunge(self):
        return 'OK', [b'']

    def close(self):
        pass

    def logout(self):
        pass


class ProbeTest(unittest.TestCase):
    def test_find_and_cleanup(self):
        acc = make_cfg().external
        FakeIMAP.boxes = {
            'INBOX': {'1': 'Hallo', '2': '[mail-monitor] Ausgang MMalt'},
            'Spamverdacht': {'3': '[mail-monitor] Ausgang MMneu'},
        }
        with mock.patch.object(mm.imaplib, 'IMAP4_SSL', FakeIMAP):
            found = mm.find_probes(acc, ['MMneu'], 5)
        self.assertEqual(found, {'MMneu': 'Spamverdacht'})
        self.assertEqual(FakeIMAP.boxes['Spamverdacht'], {})
        # INBOX: ohne Treffer dort bleibt alles (auch die alte Monitor-Mail) liegen
        self.assertEqual(set(FakeIMAP.boxes['INBOX']), {'1', '2'})

    def test_send_probe(self):
        cfg = make_cfg()
        smtp = mock.MagicMock()
        smtp.send_message.return_value = {}
        with mock.patch.object(mm.smtplib, 'SMTP', return_value=smtp):
            mm.send_probe(cfg.server, cfg.external, 'MMtok', 'Ausgang', 5)
        smtp.starttls.assert_called_once()
        smtp.login.assert_called_once_with('monitor@example.com', 'geheim')
        msg = smtp.send_message.call_args[0][0]
        self.assertIn('MMtok', msg['Subject'])
        self.assertEqual(msg['To'], 'mein.monitor@gmx.de')


class PortTest(unittest.TestCase):
    def serve(self, lines):
        srv = socket.socket()
        srv.bind(('127.0.0.1', 0))
        srv.listen(1)

        def run():
            conn, _ = srv.accept()
            conn.sendall(lines)
            conn.recv(100)
            conn.close()
            srv.close()
        threading.Thread(target=run, daemon=True).start()
        return srv.getsockname()[1]

    def test_smtp_banner_ok(self):
        port = self.serve(b'220-mail ESMTP\r\n220 ready\r\n')
        r = mm.check_port('127.0.0.1:%d:plain' % port, make_cfg(timeout=5))
        self.assertEqual(r.status, mm.OK, r.message)

    def test_bad_banner(self):
        port = self.serve(b'554 no service\r\n')
        r = mm.check_port('127.0.0.1:%d:plain' % port, make_cfg(timeout=5))
        self.assertEqual(r.status, mm.FAIL)

    def test_refused(self):
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
        s.close()
        r = mm.check_port('127.0.0.1:%d' % port, make_cfg(timeout=5))
        self.assertEqual(r.status, mm.FAIL)
        self.assertIn('nicht erreichbar', r.message)


class MainTest(unittest.TestCase):
    def test_alert_sent_and_state_saved(self):
        with tempfile.TemporaryDirectory() as d:
            p = configparser.ConfigParser(interpolation=None)
            p.read(EXAMPLE, encoding='utf-8')
            p.set('general', 'state_file', os.path.join(d, 'state.json'))
            p.set('general', 'alert_after_failures', '1')
            ini = os.path.join(d, 'm.ini')
            with open(ini, 'w') as f:
                p.write(f)
            bad = [mm.Result('Eingang', mm.FAIL, 'weg')]
            with mock.patch.object(mm, 'run_checks', return_value=bad), \
                    mock.patch.object(mm, 'send_discord') as send, \
                    mock.patch('sys.stdout'):
                self.assertEqual(mm.main(['-c', ini]), 2)
                self.assertEqual(send.call_count, 1)
                self.assertEqual(mm.main(['-c', ini]), 2)
                self.assertEqual(send.call_count, 1)   # keine Wiederholung sofort
            self.assertEqual(mm.load_state(os.path.join(d, 'state.json'))['failures'], 2)

    def test_config_error(self):
        with mock.patch('sys.stderr'):
            self.assertEqual(mm.main(['-c', '/nicht/da.ini']), 3)


if __name__ == '__main__':
    unittest.main()
