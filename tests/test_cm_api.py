# coding: utf-8
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_api


class CmApiTest(unittest.TestCase):
    def test_find_rows_unwraps_v2_envelope_with_data_key(self):
        # Reale Antwortform von mail_sys (siehe raw_call-Diagnose): {'status':0,'message':{'data':[...],'page':...}}
        payload = {'status': 0, 'timestamp': 123, 'message': {
            'data': [{'domain': 'example.com', 'active': 1}, {'domain': 'test.example', 'active': 1}],
            'page': '<div>...</div>',
        }}
        rows = cm_api.PanelApi.find_rows(payload)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['domain'], 'example.com')

    def test_find_rows_passes_through_v1_list(self):
        payload = [{'id': 1, 'name': 'a'}, {'id': 2, 'name': 'b'}]
        rows = cm_api.PanelApi.find_rows(payload)
        self.assertEqual(len(rows), 2)

    def test_find_rows_raises_on_status_minus_one(self):
        with self.assertRaises(cm_api.ApiError):
            cm_api.PanelApi.find_rows({'status': -1, 'message': 'Auth failed'})

    def test_expect_ok_raises_on_false_status_and_passes_through_otherwise(self):
        api = cm_api.PanelApi.__new__(cm_api.PanelApi)  # kein __init__/Netzwerk nötig
        with self.assertRaises(cm_api.ApiError):
            api._expect_ok({'status': False, 'msg': 'nope'})
        self.assertEqual(api._expect_ok({'status': True}), {'status': True})
        self.assertEqual(api._expect_ok('plain text'), 'plain text')

    def test_mail_box_write_methods_fail_clearly_when_unconfigured(self):
        api = cm_api.PanelApi.__new__(cm_api.PanelApi)
        with self.assertRaises(cm_api.ApiError):
            api.mail_box_create(['/plugin'], '', 'example.com', 'user@example.com', 'pw12345678')
        with self.assertRaises(cm_api.ApiError):
            api.mail_box_set_password(['/plugin'], '', 'example.com', 'user@example.com', 'pw12345678')
        with self.assertRaises(cm_api.ApiError):
            api.mail_box_delete(['/plugin'], '', 'example.com', 'user@example.com')


if __name__ == '__main__':
    unittest.main()
