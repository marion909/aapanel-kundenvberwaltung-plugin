#!/bin/bash
PATH=/bin:/sbin:/usr/bin:/usr/sbin:/usr/local/bin:/usr/local/sbin:~/bin
export PATH

PLUGIN=customer_mgr
PANEL=/www/server/panel
DATA=$PANEL/data/customer_mgr
MENU=$PANEL/config/menu.json
MENU_ID=memuCustomerMgr
PY=$PANEL/pyenv/bin/python3
[ -x "$PY" ] || PY=python3

menu_add() {
[ -f "$MENU" ] || { echo "menu.json nicht gefunden"; return; }
$PY - "$MENU" "$MENU_ID" <<'PYEOF'
import json, sys
p, mid = sys.argv[1], sys.argv[2]
menu = json.load(open(p))
if not any(m.get('id') == mid for m in menu):
    menu.append({"title": "Kunden", "href": "/customer_mgr/index.html",
                 "class": "menu_account", "id": mid, "sort": 16})
    json.dump(menu, open(p, 'w'), indent=2, ensure_ascii=False)
    print('Menüeintrag hinzugefügt')
else:
    print('Menüeintrag existiert bereits')
PYEOF
}

menu_remove() {
[ -f "$MENU" ] || return
$PY - "$MENU" "$MENU_ID" <<'PYEOF'
import json, sys
p, mid = sys.argv[1], sys.argv[2]
menu = [m for m in json.load(open(p)) if m.get('id') != mid]
json.dump(menu, open(p, 'w'), indent=2, ensure_ascii=False)
print('Menüeintrag entfernt')
PYEOF
}

install() {
  mkdir -p $DATA && chmod 700 $DATA
  [ -f "$MENU" ] && [ ! -f "$MENU.bak_before_$PLUGIN" ] && cp "$MENU" "$MENU.bak_before_$PLUGIN"
  menu_add
  find $PANEL/plugin/$PLUGIN -type d -name __pycache__ -exec rm -rf {} +
  # Achtung: chmod -R hier NICHT erneut ausfuehren, nachdem im Portal-Ordner
  # bereits "npm install" gelaufen ist - das wuerde node_modules/ (Binaries,
  # .bin-Symlinks) die Ausfuehrbarkeit entziehen. install.sh ist nur fuer die
  # Erstinstallation der Plugin-Dateien gedacht, das Portal-Deployment ist ein
  # separater, spaeterer Schritt (siehe portal/README.md).
  chmod -R 600 $PANEL/plugin/$PLUGIN
  chmod 700 $PANEL/plugin/$PLUGIN \
            $PANEL/plugin/$PLUGIN/templates $PANEL/plugin/$PLUGIN/static \
            $PANEL/plugin/$PLUGIN/portal \
            $PANEL/plugin/$PLUGIN/portal/views $PANEL/plugin/$PLUGIN/portal/static
  echo 'Successify'
  echo 'Hinweis: Kundenportal (portal/) muss separat ueber den Node.js-Projektmanager deployt werden, siehe portal/README.md'
}

uninstall() {
  menu_remove
  # Kundendaten bleiben bewusst erhalten: $DATA
  if [ -d "$PANEL/plugin/$PLUGIN/portal" ]; then
    echo 'Hinweis: Falls der Node.js-Projektmanager auf plugin/'"$PLUGIN"'/portal zeigt, wird dessen Prozess durch das Loeschen jetzt funktionsunfaehig.'
  fi
  rm -rf $PANEL/plugin/$PLUGIN
  echo 'Successify'
}

case "$1" in
  install)   install ;;
  uninstall) uninstall ;;
  menu)      menu_add ;;   # nach einem Panel-Update erneut ausführen
  purge)     uninstall; rm -rf $DATA; echo 'Daten gelöscht' ;;
  *) echo "Usage: bash install.sh {install|uninstall|menu|purge}" ;;
esac
