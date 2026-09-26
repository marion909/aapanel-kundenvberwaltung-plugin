# coding: utf-8
"""aaPanel lädt bei Plugin-Aufrufen nur customer_mgr_main.py neu. Nach einem
Update müssen die Hilfsmodule trotzdem in der neuen Version laufen."""
import importlib, os, sys, types, unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


class ModuleReloadTest(unittest.TestCase):
    def _import_main(self):
        sys.modules.setdefault('public', types.ModuleType('public'))
        with mock.patch('os.chdir'):
            if 'customer_mgr_main' in sys.modules:
                return importlib.reload(sys.modules['customer_mgr_main'])
            import customer_mgr_main
            return customer_mgr_main

    def test_stale_helper_module_is_reloaded(self):
        main = self._import_main()
        import cm_store
        # Zustand wie nach einem Update: alte Modulversion im Speicher
        del cm_store.Store.assign_domain
        cm_store._cm_loaded_mtime = 0
        main = self._import_main()
        self.assertTrue(hasattr(main.cm_store.Store, 'assign_domain'))
        self.assertIs(main.cm_resources.cm_api, main.cm_api)

    def test_no_reload_when_unchanged(self):
        main = self._import_main()
        before = main.cm_store
        marker = object()
        before._marker = marker
        main = self._import_main()
        self.assertIs(getattr(main.cm_store, '_marker', None), marker)


if __name__ == '__main__':
    unittest.main()
