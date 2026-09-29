# coding: utf-8
import os, sys, unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_resources


class FakeApi(object):
    """Steht für cm_api.PanelApi, ohne echten Netzwerkzugriff."""

    def __init__(self, sites=None, mail_domains=None, mailboxes_by_domain=None, sites_error=None, ftps=None):
        self.ftps = ftps or []
        self.sites = sites or []
        self.mail_domains = mail_domains or []
        self.mailboxes_by_domain = mailboxes_by_domain or {}
        self.sites_error = sites_error

    def list_sites(self, data_path, project_types):
        if self.sites_error:
            raise self.sites_error
        return list(self.sites), []

    def list_ftps(self, data_path):
        return list(self.ftps)

    def list_mail_domains(self, paths, method):
        return list(self.mail_domains), paths[0]

    def list_mailboxes(self, paths, method, domain):
        return list(self.mailboxes_by_domain.get(domain, [])), paths[0]


class CmResourcesTest(unittest.TestCase):
    def test_mail_plugin_paths_defaults_and_custom(self):
        self.assertEqual(cm_resources.mail_plugin_paths({}), ['/v2/plugin', '/plugin'])
        self.assertEqual(cm_resources.mail_plugin_paths({'mail_plugin_paths': '/a, /b'}), ['/a', '/b'])

    def test_load_resources_normalizes_case_and_indexes(self):
        api = FakeApi(
            sites=[{'id': 1, 'name': 'Example.COM', 'status': '1', 'project_type': 'PHP',
                    'ssl': None, 'path': '', 'ps': '', 'edate': ''}],
            mail_domains=[{'domain': 'Example.com', 'active': 1, 'created': ''}],
            mailboxes_by_domain={'Example.com': [{'username': 'Info@Example.com', 'domain': 'Example.com',
                                                  'full_name': '', 'quota': '', 'active': 1}]},
        )
        cfg = {'data_path': '/v2/data', 'site_project_types': ''}
        with mock.patch('cm_resources.os.path.exists', return_value=True):
            res = cm_resources.load_resources(cfg, api=api)

        self.assertEqual(res['sites'][0]['name'], 'example.com')
        self.assertEqual(res['mail_domains'][0]['domain'], 'example.com')
        self.assertEqual(res['mailboxes'][0]['username'], 'info@example.com')
        self.assertEqual(res['mailboxes'][0]['domain'], 'example.com')

        idx = cm_resources.index_resources(res)
        self.assertIn(('site', 'example.com'), idx)
        self.assertIn(('mail_domain', 'example.com'), idx)
        self.assertIn(('mailbox', 'info@example.com'), idx)

    def test_ftp_accounts_are_linked_to_their_website(self):
        api = FakeApi(
            sites=[{'id': 1, 'name': 'Kunde.at', 'status': '1', 'path': '/www/wwwroot/kunde.at'},
                   {'id': 2, 'name': 'shop.kunde.at', 'status': '1', 'path': '/www/wwwroot/kunde.at/shop'},
                   {'id': 3, 'name': 'kunde.at.evil', 'status': '1', 'path': '/www/wwwroot/kunde.at.evil'}],
            ftps=[{'id': 9, 'name': 'Web', 'path': '/www/wwwroot/kunde.at/', 'status': '1', 'ps': ''},
                  {'id': 10, 'name': 'shop', 'path': '/www/wwwroot/kunde.at/shop/uploads', 'status': '0', 'ps': ''},
                  {'id': 11, 'name': 'evil', 'path': '/www/wwwroot/kunde.at.evil', 'status': '1', 'ps': ''},
                  {'id': 12, 'name': 'lose', 'path': '/srv/ftp', 'status': '1', 'ps': ''}],
        )
        with mock.patch('cm_resources.os.path.exists', return_value=False):
            res = cm_resources.load_resources({'data_path': '/v2/data', 'site_project_types': ''}, api=api)
        self.assertEqual({f['name']: f['site'] for f in res['ftps']},
                         {'web': 'kunde.at', 'shop': 'shop.kunde.at', 'evil': 'kunde.at.evil', 'lose': ''})
        self.assertIn(('ftp', 'web'), cm_resources.index_resources(res))

    def test_fetch_mail_reports_not_installed_when_absent(self):
        api = FakeApi()
        with mock.patch('cm_resources.os.path.exists', return_value=False):
            domains, boxes, src = cm_resources.fetch_mail(api, {}, [])
        self.assertEqual((domains, boxes, src), ([], [], 'nicht installiert'))

    def test_annotate_assignments_marks_ok_missing_unknown(self):
        idx = {('site', 'example.com'): {'status': '1'}}
        rows = [{'type': 'site', 'ref_name': 'example.com'}, {'type': 'site', 'ref_name': 'gone.com'}]
        cm_resources.annotate_assignments(rows, idx)
        self.assertEqual(rows[0]['state'], 'ok')
        self.assertEqual(rows[0]['info'], {'status': '1'})
        self.assertEqual(rows[1]['state'], 'missing')
        self.assertEqual(rows[1]['info'], {})

        rows2 = [{'type': 'site', 'ref_name': 'example.com'}]
        cm_resources.annotate_assignments(rows2, None)
        self.assertEqual(rows2[0]['state'], 'unknown')
        self.assertEqual(rows2[0]['info'], {})

    def test_annotate_assignments_domain_area_is_never_missing(self):
        rows = [{'type': 'domain', 'ref_name': 'kunde.at'}]
        cm_resources.annotate_assignments(rows, {})
        self.assertEqual(rows[0]['state'], 'ok')
        rows = [{'type': 'domain', 'ref_name': 'kunde.at'}]
        cm_resources.annotate_assignments(rows, None)
        self.assertEqual(rows[0]['state'], 'ok')

    def test_resource_cache_respects_ttl_and_refresh(self):
        calls = {'n': 0}

        def fake_load(cfg):
            calls['n'] += 1
            return {'n': calls['n']}

        cache = cm_resources.ResourceCache(ttl=100)
        with mock.patch('cm_resources.load_resources', side_effect=fake_load):
            first = cache.get({})
            second = cache.get({})
            self.assertEqual(first, second)
            self.assertEqual(calls['n'], 1)
            third = cache.get({}, refresh=True)
            self.assertEqual(calls['n'], 2)
            self.assertNotEqual(first, third)
            cache.invalidate()
            cache.get({})
            self.assertEqual(calls['n'], 3)


if __name__ == '__main__':
    unittest.main()
