# coding: utf-8
"""Testet die Portal-Flask-App per app.test_client(). Braucht Flask
(siehe portal/requirements.txt) - in diesem Dev-Checkout z. B. in einem
separaten venv installieren, die anderen tests/test_*.py brauchen es nicht.
"""
import os, re, shutil, sys, tempfile, unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, 'portal'))


class PortalAppTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        os.environ['CM_DATA_DIR'] = self.tmpdir
        os.environ['PORTAL_DEBUG'] = '1'  # deaktiviert SESSION_COOKIE_SECURE für den Test-Client (kein HTTPS)
        for mod in ('cm_store', 'cm_api', 'cm_resources', 'app'):
            sys.modules.pop(mod, None)

        import cm_store
        self.cm_store = cm_store
        store = cm_store.Store()
        self.cid = store.save_customer({'company': 'Testkunde', 'customer_no': 'K-00001'})
        store.set_portal_password(self.cid, 'sicheresPasswort123')
        store.assign(self.cid, [{'type': 'site', 'ref_name': 'example.com', 'ref_id': '7'}])
        store.close()

        import app as portal_app
        self.portal_app = portal_app
        portal_app.app.config['TESTING'] = True
        self.client = portal_app.app.test_client()

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)
        os.environ.pop('CM_DATA_DIR', None)
        os.environ.pop('PORTAL_DEBUG', None)

    def _csrf(self, path='/login'):
        html = self.client.get(path).get_data(as_text=True)
        m = re.search(r'name="csrf_token" value="([^"]+)"', html)
        self.assertIsNotNone(m, 'kein csrf_token-Feld in {} gefunden'.format(path))
        return m.group(1)

    def _login(self, login='K-00001', password='sicheresPasswort123'):
        token = self._csrf()
        return self.client.post('/login', data={'login': login, 'password': password, 'csrf_token': token})

    def test_login_page_loads(self):
        resp = self.client.get('/login')
        self.assertEqual(resp.status_code, 200)

    def test_dashboard_requires_login(self):
        resp = self.client.get('/', follow_redirects=False)
        self.assertEqual(resp.status_code, 302)
        self.assertIn('/login', resp.headers['Location'])

    def test_post_without_csrf_token_rejected(self):
        resp = self.client.post('/login', data={'login': 'K-00001', 'password': 'sicheresPasswort123'})
        self.assertEqual(resp.status_code, 400)

    def test_login_wrong_password_fails(self):
        resp = self._login(password='falsch')
        self.assertEqual(resp.status_code, 401)

    def test_login_success_and_dashboard_shows_customer(self):
        resp = self._login()
        self.assertEqual(resp.status_code, 302)
        dash = self.client.get('/')
        self.assertEqual(dash.status_code, 200)
        self.assertIn('Testkunde', dash.get_data(as_text=True))

    def test_disabled_portal_access_blocks_even_with_valid_session(self):
        self._login()
        self.assertEqual(self.client.get('/').status_code, 200)
        store = self.cm_store.Store()
        store.set_portal_access(self.cid, False)
        store.close()
        # Zugang wird bei jedem Request neu aus der DB geprüft, nicht nur beim Login.
        resp = self.client.get('/', follow_redirects=False)
        self.assertEqual(resp.status_code, 302)
        self.assertIn('/login', resp.headers['Location'])

    def test_login_throttled_after_too_many_failures(self):
        for _ in range(5):
            self._login(password='falsch')
        resp = self._login()  # korrektes Passwort, aber Drossel-Limit erreicht
        self.assertEqual(resp.status_code, 429)

    def test_ownership_check_blocks_foreign_assignment(self):
        store = self.cm_store.Store()
        other_cid = store.save_customer({'company': 'Anderer Kunde', 'customer_no': 'K-00002'})
        store.assign(other_cid, [{'type': 'site', 'ref_name': 'other.com', 'ref_id': '9'}])
        other_assignment_id = store.assignments(other_cid)[0]['id']
        store.close()

        self._login()  # als K-00001 eingeloggt
        token = self._csrf('/sites')
        resp = self.client.post('/sites/{}/stop'.format(other_assignment_id), data={'csrf_token': token})
        self.assertEqual(resp.status_code, 404)

    def test_mail_box_create_rejects_unowned_domain(self):
        self._login()
        token = self._csrf('/mail')
        resp = self.client.post('/mail/boxes', data={
            'domain': 'not-mine.example', 'local': 'info', 'password': 'x12345678', 'csrf_token': token})
        self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main()
