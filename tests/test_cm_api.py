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


if __name__ == '__main__':
    unittest.main()
