# coding: utf-8
import os, shutil, sqlite3, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class CmStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        os.environ['CM_DATA_DIR'] = self.tmpdir
        # frisch importieren, da DATA_DIR/DB_FILE beim Modul-Import aus der Env-Var berechnet werden
        sys.modules.pop('cm_store', None)
        import cm_store
        self.cm_store = cm_store
        self.store = cm_store.Store()

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        os.environ.pop('CM_DATA_DIR', None)

    def _make_customer(self, **overrides):
        data = {'company': 'Test GmbH', 'email': 'test@example.com'}
        data.update(overrides)
        return self.store.save_customer(data)

    def test_hash_password_roundtrip(self):
        h = self.cm_store.hash_password('correct horse battery staple')
        self.assertTrue(self.cm_store.verify_password('correct horse battery staple', h))
        self.assertFalse(self.cm_store.verify_password('wrong password', h))

    def test_verify_password_never_raises_on_garbage(self):
        self.assertFalse(self.cm_store.verify_password('x', ''))
        self.assertFalse(self.cm_store.verify_password('x', None))
        self.assertFalse(self.cm_store.verify_password('x', 'not-a-valid-hash'))
        self.assertFalse(self.cm_store.verify_password('x', 'pbkdf2_sha256$abc$def'))

    def test_migration_adds_columns_without_data_loss(self):
        # Altes Schema OHNE Portal-Spalten in einer eigenen, frischen DB simulieren.
        db_path = os.path.join(self.tmpdir, 'legacy.db')
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        con.execute("""CREATE TABLE customers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, customer_no TEXT UNIQUE,
            company TEXT DEFAULT '', first_name TEXT DEFAULT '', last_name TEXT DEFAULT '',
            email TEXT DEFAULT '', phone TEXT DEFAULT '', street TEXT DEFAULT '',
            zip TEXT DEFAULT '', city TEXT DEFAULT '', country TEXT DEFAULT '',
            vat_id TEXT DEFAULT '', note TEXT DEFAULT '', status TEXT DEFAULT 'active',
            created_at INTEGER, updated_at INTEGER)""")
        con.execute("INSERT INTO customers (customer_no, company, status, created_at, updated_at) "
                    "VALUES (?,?,?,?,?)", ('K-00001', 'Bestandskunde', 'active', 1, 1))
        con.commit()
        self.cm_store._migrate(con)
        row = con.execute('SELECT * FROM customers WHERE customer_no=?', ('K-00001',)).fetchone()
        self.assertEqual(row['company'], 'Bestandskunde')
        self.assertEqual(row['portal_enabled'], 0)
        self.assertEqual(row['portal_password_hash'], '')
        con.close()

    def test_set_portal_access_and_password_and_login(self):
        cid = self._make_customer(customer_no='K-00042')
        self.store.set_portal_password(cid, 'sicheres-passwort')
        c = self.store.get_portal_customer('K-00042')
        self.assertIsNotNone(c)
        self.assertTrue(self.cm_store.verify_password('sicheres-passwort', c['portal_password_hash']))

        self.store.set_portal_access(cid, False)
        self.assertIsNone(self.store.get_portal_customer('K-00042'))

    def test_get_portal_customer_case_insensitive(self):
        self._make_customer(customer_no='K-00007')
        cid = self.store.db.execute("SELECT id FROM customers WHERE customer_no='K-00007'").fetchone()[0]
        self.store.set_portal_password(cid, 'sicheres-passwort')
        self.assertIsNotNone(self.store.get_portal_customer('k-00007'))

    def test_get_customer_and_list_customers_never_expose_password_hash(self):
        cid = self._make_customer(customer_no='K-00099')
        self.store.set_portal_password(cid, 'geheimespasswort')
        c = self.store.get_customer(cid)
        self.assertNotIn('portal_password_hash', c)
        for row in self.store.list_customers():
            self.assertNotIn('portal_password_hash', row)

    def test_set_portal_password_rejects_short_password(self):
        cid = self._make_customer()
        with self.assertRaises(ValueError):
            self.store.set_portal_password(cid, 'short')

    def test_is_assigned_and_assign_unassign(self):
        cid = self._make_customer()
        self.assertFalse(self.store.is_assigned(cid, 'site', 'example.com'))
        added, skipped = self.store.assign(cid, [{'type': 'site', 'ref_name': 'example.com', 'ref_id': '5'}])
        self.assertEqual(len(added), 1)
        self.assertTrue(self.store.is_assigned(cid, 'site', 'example.com'))
        row = [a for a in self.store.assignments(cid) if a['ref_name'] == 'example.com'][0]
        got = self.store.get_assignment(row['id'])
        self.assertEqual(got['customer_id'], cid)
        self.store.unassign(row['id'])
        self.assertFalse(self.store.is_assigned(cid, 'site', 'example.com'))
        self.assertIsNone(self.store.get_assignment(row['id']))

    def test_login_throttle_counts_failures_by_login_and_ip(self):
        for _ in range(3):
            self.store.record_login_attempt('K-00001', '127.0.0.1', False)
        self.store.record_login_attempt('K-00001', '127.0.0.1', True)
        by_login, by_ip = self.store.login_attempts_count('K-00001', '127.0.0.1', 3600)
        self.assertEqual(by_login, 3)
        self.assertEqual(by_ip, 3)

    def test_normalize_domain(self):
        n = self.cm_store.normalize_domain
        self.assertEqual(n(' Kunde.AT. '), 'kunde.at')
        self.assertEqual(n('*.kunde.at'), 'kunde.at')
        self.assertEqual(n('müller.at'), 'xn--mller-kva.at')
        for bad in ('', 'localhost', 'a..at', '-a.at', '1.2.3.4', 'http://a.at'):
            with self.assertRaises(ValueError):
                n(bad)

    def test_assign_domain_prevents_overlap_between_customers(self):
        a = self._make_customer(company='A')
        b = self._make_customer(company='B')
        self.assertEqual(self.store.assign_domain(a, 'Kunde.at'), 'kunde.at')
        self.assertTrue(self.store.is_assigned(a, 'domain', 'kunde.at'))
        with self.assertRaises(ValueError):
            self.store.assign_domain(b, 'shop.kunde.at')
        with self.assertRaises(ValueError):
            self.store.assign_domain(b, 'kunde.at')
        # derselbe Kunde darf zusätzliche (auch überlappende) Bereiche bekommen
        self.store.assign_domain(a, 'shop.kunde.at')
        self.store.assign_domain(b, 'andere.at')

    def test_max_sites_default_and_override(self):
        cid = self._make_customer()
        self.assertEqual(self.store.get_customer(cid)['max_sites'], -1)
        self.store.save_customer({'id': cid, 'company': 'Test GmbH', 'max_sites': '3'})
        self.assertEqual(self.store.get_customer(cid)['max_sites'], 3)
        with self.assertRaises(ValueError):
            self.store.save_customer({'id': cid, 'company': 'Test GmbH', 'max_sites': 'viele'})

    def test_migration_adds_max_sites_to_existing_db(self):
        self.store.close()
        db = sqlite3.connect(self.cm_store.DB_FILE)
        db.execute('ALTER TABLE customers DROP COLUMN max_sites')
        db.commit()
        db.close()
        self.store = self.cm_store.Store()
        cols = [r[1] for r in self.store.db.execute('PRAGMA table_info(customers)')]
        self.assertIn('max_sites', cols)

    def test_logo_save_detect_and_replace(self):
        png = b'\x89PNG\r\n\x1a\n' + b'0' * 50
        self.assertEqual(self.cm_store.save_logo(png), 'png')
        self.assertTrue(self.cm_store.logo_path().endswith('logo.png'))
        svg = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'
        self.assertEqual(self.cm_store.save_logo(svg), 'svg')
        # altes Logo wurde ersetzt, nicht zusätzlich behalten
        self.assertTrue(self.cm_store.logo_path().endswith('logo.svg'))
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, 'logo.png')))
        self.cm_store.remove_logo()
        self.assertIsNone(self.cm_store.logo_path())

    def test_logo_rejects_unsafe_or_invalid_files(self):
        for bad in (b'<svg><script>alert(1)</script></svg>',
                    b'<svg onload="alert(1)"></svg>',
                    b'<svg><a href="javascript:alert(1)">x</a></svg>',
                    b'<html><body>kein Bild</body></html>',
                    b'MZ\x90\x00',
                    b''):
            with self.assertRaises(ValueError):
                self.cm_store.save_logo(bad)
        with self.assertRaises(ValueError):
            self.cm_store.save_logo(b'\x89PNG\r\n\x1a\n' + b'0' * (1024 * 1024))
        self.assertIsNone(self.cm_store.logo_path())

    def test_package_crud_and_delete_protection(self):
        pid = self.store.save_package({'name': 'Business', 'max_sites': '5', 'max_mailboxes': 10, 'ssl_allowed': False})
        p = self.store.get_package(pid)
        self.assertEqual((p['max_sites'], p['max_mailboxes'], p['ssl_allowed']), (5, 10, 0))
        self.assertEqual((p['max_ftp'], p['ftp_allowed']), (0, 1))
        pid2 = self.store.save_package({'name': 'NoFtp', 'max_ftp': 3, 'ftp_allowed': False})
        self.assertEqual((self.store.get_package(pid2)['max_ftp'], self.store.get_package(pid2)['ftp_allowed']), (3, 0))
        self.store.delete_package(pid2)
        pid3 = self.store.save_package({'name': 'Backup', 'mail_backup_days': '7', 'mail_backup_allowed': 'false'})
        p3 = self.store.get_package(pid3)
        self.assertEqual((p3['mail_backup_days'], p3['mail_backup_allowed']), (7, 0))
        self.store.delete_package(pid3)
        with self.assertRaises(ValueError):
            self.store.save_package({'name': 'business'})  # Name eindeutig (ohne Groß/Klein)
        with self.assertRaises(ValueError):
            self.store.save_package({'name': 'X', 'max_sites': -1})
        self.store.save_package({'id': pid, 'name': 'Business', 'max_sites': 6})
        self.assertEqual(self.store.get_package(pid)['max_sites'], 6)
        cid = self._make_customer(package_id=str(pid))
        self.assertEqual(self.store.get_customer(cid)['package_id'], pid)
        self.assertEqual(self.store.list_customers()[0]['package_name'], 'Business')
        with self.assertRaises(ValueError):
            self.store.delete_package(pid)
        self.store.save_customer({'id': cid, 'company': 'Test GmbH', 'package_id': ''})
        self.assertIsNone(self.store.get_customer(cid)['package_id'])
        self.store.delete_package(pid)
        self.assertEqual(self.store.list_packages(), [])

    def test_effective_limits_precedence(self):
        eff = self.cm_store.effective_limits
        cfg = {'site_default_max_sites': 3, 'portal_max_upload_mb': 256}
        pkg = {'max_sites': 5, 'max_domains': 2, 'max_mail_domains': 1, 'max_mailboxes': 10,
               'mailbox_quota_mb': 2048, 'max_upload_mb': 0, 'ssl_allowed': 0}
        self.assertEqual(eff({'max_sites': -1}, None, cfg)['site'], 3)
        lim = eff({'max_sites': -1}, pkg, cfg)
        self.assertEqual((lim['site'], lim['domain'], lim['mailbox'], lim['mailbox_quota_mb']), (5, 2, 10, 2048))
        self.assertEqual(lim['upload_mb'], 256)
        self.assertFalse(lim['ssl'])
        self.assertEqual(eff({'max_sites': 0}, pkg, cfg)['site'], 0)   # Kunde: unbegrenzt
        self.assertEqual(eff({'max_sites': 8}, pkg, cfg)['site'], 8)
        self.assertTrue(eff({'max_sites': -1}, None, cfg)['ssl'])
        # FTP: ohne Paket erlaubt/unbegrenzt, sonst laut Paket
        self.assertEqual((lim['ftp'], lim['ftp_allowed']), (0, True))
        self.assertFalse(eff({'max_sites': -1}, dict(pkg, max_ftp=2, ftp_allowed=0), cfg)['ftp_allowed'])
        self.assertEqual(eff({'max_sites': -1}, dict(pkg, max_ftp=2), cfg)['ftp'], 2)
        self.assertTrue(eff({'max_sites': -1}, None, cfg)['ftp_allowed'])
        # Mail-Sicherung: ohne Paket nur manuell, sonst laut Paket
        self.assertEqual((lim['mail_backup'], lim['mail_backup_days']), (True, 0))
        lim2 = eff({'max_sites': -1}, dict(pkg, mail_backup_allowed=0, mail_backup_days=14), cfg)
        self.assertEqual((lim2['mail_backup'], lim2['mail_backup_days']), (False, 14))
        self.assertEqual(eff({'max_sites': -1}, None, cfg)['mail_backup_days'], 0)

    def test_assign_enforces_package_limits_unless_forced(self):
        pid = self.store.save_package({'name': 'Mini', 'max_sites': 1, 'max_domains': 1})
        cid = self._make_customer(package_id=pid)
        self.store.assign(cid, [{'type': 'site', 'ref_name': 'a.at'}], {}, enforce_limits=True)
        with self.assertRaises(self.cm_store.LimitError) as ctx:
            self.store.assign(cid, [{'type': 'site', 'ref_name': 'b.at'}], {}, enforce_limits=True)
        self.assertIn('Paket-Limit', str(ctx.exception))
        self.store.assign(cid, [{'type': 'site', 'ref_name': 'b.at'}], {}, enforce_limits=False)
        self.assertEqual(self.store.over_limits(self.store.get_customer(cid)), ['Websites: 2 von 1'])
        self.store.assign_domain(cid, 'a.at', {}, enforce_limits=True)
        with self.assertRaises(self.cm_store.LimitError):
            self.store.assign_domain(cid, 'b.at', {}, enforce_limits=True)
        # Mail-Domains sind im Paket unbegrenzt
        self.store.assign(cid, [{'type': 'mail_domain', 'ref_name': 'a.at'}, {'type': 'mail_domain', 'ref_name': 'b.at'}],
                          {}, enforce_limits=True)


if __name__ == '__main__':
    unittest.main()
