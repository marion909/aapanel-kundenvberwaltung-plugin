# coding: utf-8
"""Mail-Monitoring-Einstellungen: INI + Cron schreiben, Geheimnisse, Status."""
import configparser, json, os, shutil, sys, tempfile, time, unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def full_form(**over):
    data = {
        'admin.enabled': True, 'admin.interval': '5', 'general.name': 'mail.test',
        'discord.webhook_url': 'https://discord.com/api/webhooks/1/abc',
        'checks.outbound': True, 'checks.inbound': True, 'checks.queue': True,
        'checks.ports': 'mail.test:25, mail.test:993',
    }
    for acc, addr in (('server', 'monitor@test.at'), ('external', 'x@gmx.at')):
        data.update({acc + '.address': addr, acc + '.password': 'pw-' + acc,
                     acc + '.smtp_host': 'smtp.' + acc, acc + '.smtp_security': 'starttls',
                     acc + '.imap_security': 'ssl', acc + '.smtp_port': ''})
    data.update(over)
    return data


class CmMonitorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ['CM_DATA_DIR'] = os.path.join(self.tmp, 'data')
        os.environ['CM_CRON_FILE'] = os.path.join(self.tmp, 'cron')
        for m in ('cm_store', 'cm_monitor'):
            sys.modules.pop(m, None)
        import cm_monitor
        self.m = cm_monitor
        self.m.LEGACY_INI = os.path.join(self.tmp, 'etc_mail_monitor.ini')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        os.environ.pop('CM_DATA_DIR', None)
        os.environ.pop('CM_CRON_FILE', None)

    def ini(self):
        p = configparser.ConfigParser(interpolation=None)
        p.read(self.m.INI_FILE, encoding='utf-8')
        return p

    def test_defaults_without_config(self):
        values, legacy = self.m.load()
        self.assertFalse(legacy)
        self.assertFalse(values['admin.enabled'])
        self.assertEqual(values['admin.interval'], 10)
        self.assertTrue(values['general.name'])

    def test_save_writes_ini_and_cron(self):
        self.m.save(full_form())
        p = self.ini()
        self.assertEqual(p.get('server', 'password'), 'pw-server')
        self.assertEqual(p.get('general', 'state_file'), self.m.STATE_FILE)
        self.assertFalse(p.has_option('server', 'smtp_port'))   # leer = Standard des Skripts
        self.assertEqual(oct(os.stat(self.m.INI_FILE).st_mode & 0o777), '0o600')
        with open(self.m.CRON_FILE) as f:
            cron = f.read()
        self.assertIn('*/5 * * * * root ', cron)
        self.assertIn(self.m.SCRIPT, cron)
        self.assertIn('-c ' + self.m.INI_FILE, cron)

    def test_ini_is_valid_for_the_script(self):
        self.m.save(full_form())
        sys.path.insert(0, os.path.join(ROOT, 'mail_monitor'))
        import mail_monitor
        cfg = mail_monitor.load_config(self.m.INI_FILE)
        self.assertEqual(cfg.server.smtp_port, 587)
        self.assertEqual(cfg.external.address, 'x@gmx.at')
        self.assertEqual(cfg.alert_after, 2)
        self.assertEqual(cfg.state_file, self.m.STATE_FILE)

    def test_secrets_kept_when_empty_and_not_exposed(self):
        self.m.save(full_form())
        self.m.save(full_form(**{'server.password': '', 'discord.webhook_url': ''}))
        self.assertEqual(self.ini().get('server', 'password'), 'pw-server')
        values, _ = self.m.load()
        pub, secrets = self.m.public_values(values)
        self.assertNotIn('server.password', pub)
        self.assertNotIn('discord.webhook_url', pub)
        self.assertTrue(secrets['server.password'])

    def test_disable_removes_cron(self):
        self.m.save(full_form())
        self.assertTrue(os.path.exists(self.m.CRON_FILE))
        self.m.save(full_form(**{'admin.enabled': False}))
        self.assertFalse(os.path.exists(self.m.CRON_FILE))
        self.assertEqual(self.ini().get('admin', 'enabled'), 'no')

    def test_validation(self):
        with self.assertRaises(ValueError):
            self.m.save(full_form(**{'server.address': ''}))
        with self.assertRaises(ValueError):
            self.m.save(full_form(**{'admin.interval': '0'}))
        with self.assertRaises(ValueError):
            self.m.save(full_form(**{'server.smtp_security': 'tls'}))
        with self.assertRaises(ValueError):
            self.m.save(full_form(**{'discord.webhook_url': 'http://x'}))
        with self.assertRaises(ValueError):   # keine INI-Injektion über Zeilenumbrüche
            self.m.save(full_form(**{'general.name': 'x\n[server]\npassword = y'}))
        # deaktiviert darf unvollständig gespeichert werden
        self.m.save({'admin.enabled': False, 'general.name': 'nur Name'})
        self.assertFalse(os.path.exists(self.m.CRON_FILE))

    def test_legacy_import(self):
        with open(self.m.LEGACY_INI, 'w') as f:
            f.write('[server]\naddress = alt@test.at\npassword = geheim\n'
                    '[general]\nwait_seconds = 120\n[checks]\nqueue = no\n')
        values, legacy = self.m.load()
        self.assertTrue(legacy)
        self.assertEqual(values['server.address'], 'alt@test.at')
        self.assertEqual(values['server.password'], 'geheim')
        self.assertEqual(values['general.wait_seconds'], 120)
        self.assertFalse(values['checks.queue'])
        self.assertFalse(values['admin.enabled'])

    def test_status(self):
        self.m.save(full_form())
        os.makedirs(os.path.dirname(self.m.STATE_FILE), exist_ok=True)
        with open(self.m.STATE_FILE, 'w') as f:
            json.dump({'last_run': time.time() - 3600 * 5, 'last_status': 'fail', 'failures': 3,
                       'last_results': [['Eingang', 'fail', 'nicht angekommen']]}, f)
        with open(self.m.LOG_FILE, 'w') as f:
            f.write("ERROR: ld.so: object 'x' cannot be preloaded\n[FAIL] Eingang: nicht angekommen\n")
        st = self.m.status()
        self.assertEqual(st['last_status'], 'fail')
        self.assertEqual(st['results'][0]['name'], 'Eingang')
        self.assertTrue(st['stale'])
        self.assertTrue(st['cron_active'])
        self.assertNotIn('ld.so', st['log'])

    def test_run_and_webhook_need_config(self):
        with self.assertRaises(ValueError):
            self.m.run_now()
        with self.assertRaises(ValueError):
            self.m.test_webhook()

    def test_test_webhook_reports_script_error(self):
        self.m.save(full_form())
        fake = mock.Mock(returncode=3, stdout="ERROR: ld.so: x\n[discord] webhook_url ist leer\n")
        with mock.patch.object(self.m.subprocess, 'run', return_value=fake):
            with self.assertRaises(ValueError) as ctx:
                self.m.test_webhook()
        self.assertEqual(str(ctx.exception), '[discord] webhook_url ist leer')


if __name__ == '__main__':
    unittest.main()
