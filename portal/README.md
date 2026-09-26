# Kundenportal – Deployment (Node.js)

Dieses Verzeichnis ist eine eigenständige Node/Express-App. Sie läuft **nicht**
als Teil des `customer_mgr`-Admin-Plugins (das bleibt Python, weil aaPanel das
für Plugins verlangt), sondern als separater Prozess, weil aaPanel für jede
`/customer_mgr/...`-URL zwingend eine eingeloggte Admin-Session verlangt – ein
Kunde kann diese Route nie erreichen. Diese App teilt sich stattdessen nur die
Datenbank (`customer_mgr.db` im Daten-Verzeichnis des Plugins) und die
Konfiguration (`config.json`, inkl. API-Key) mit dem Admin-Plugin – über eine
eigene, in JavaScript nachgebaute Zugriffsschicht (`lib/store.js`, `lib/api.js`,
`lib/resources.js`), da Node kein Python-Modul importieren kann.

**Warum Node und nicht mehr Python:** Die erste Version dieses Portals war
Flask-basiert. Beim Deployment über aaPanels „Python-Projektmanager" trat ein
reproduzierbarer Bug im Panel selbst auf (beim automatischen Installieren von
`uwsgi`, unabhängig von der Python-Version). Node/npm hat i. d. R. keine
vergleichbare Bootstrap-Problematik.

## Wichtige Lektion aus der Python-Fehlersuche: erst manuell testen

Bevor irgendetwas in aaPanels Projektmanager-UI konfiguriert wird: **im
Terminal manuell verifizieren, dass die App überhaupt läuft.** Das war beim
Python-Portal die einzige Methode, mit der sich Panel-Bugs von echten
Code-Fehlern unterscheiden ließen.

```bash
cd /www/server/panel/plugin/customer_mgr/portal
npm install
```

Falls `npm install` hier fehlschlägt (am ehesten bei `better-sqlite3`, der
einzigen Abhängigkeit mit nativem Code): `build-essential` und `python3.11-dev`
installieren (dieselben Pakete, die für die uwsgi-Kompilierung nötig waren):
```bash
apt-get install -y build-essential python3.11-dev
```

Danach manuell starten und testen:
```bash
mkdir -p /tmp/customer_mgr_test
PORTAL_DEBUG=1 CM_DATA_DIR=/tmp/customer_mgr_test PORT=8901 node server.js
# in einem zweiten Terminal:
curl -i http://127.0.0.1:8901/login
```
Kommt eine HTML-Antwort mit dem Login-Formular zurück, funktioniert der Code.
**Erst dann** weiter zu aaPanel.

`PORTAL_DEBUG=1` deaktiviert das `secure`-Flag beim Session-Cookie, damit der
Login auch über Klartext-`http://` funktioniert (Browser setzen
„Secure"-Cookies sonst nicht ohne HTTPS). **Nicht** in Produktion setzen.

## Deployment über aaPanels Node.js-Projektmanager

1. Plugin „Node.js-Projektmanager" installieren, falls nicht vorhanden.
2. Neues Projekt anlegen: Projektpfad `.../plugin/customer_mgr/portal`,
   Startdatei `server.js`, Port `8901` (oder frei wählbar, dann unten beim
   Reverse-Proxy anpassen).
3. Domain/Reverse-Proxy einrichten: normale aaPanel-Website (Subdomain, z. B.
   `kunden.deinedomain.tld`) mit Reverse-Proxy auf `127.0.0.1:<Port>` und
   Let's-Encrypt-SSL über den Website-Assistenten. Der Kunden-Login läuft
   ausschließlich über diese HTTPS-Adresse – den Port selbst nicht öffentlich
   freigeben.

## Vor dem ersten Kunden-Login

Im Admin-Plugin unter **Einstellungen → Mailserver** die drei Aktionsnamen für
Postfach anlegen/Passwort ändern/löschen eintragen. Diese Namen sind nicht
öffentlich dokumentiert und je nach `mail_sys`-Version unterschiedlich – über
das vorhandene **„API-Rohaufruf"**-Diagnosefeld (Einstellungen-Tab) gegen die
eigene Installation ermitteln. Ohne diese Konfiguration meldet das Portal beim
Postfach-Anlegen/Ändern/Löschen einen klaren Fehler statt etwas Falsches zu tun.

**Bei einer aaPanel-Version mit `mail_sys` 8.24.0 bestätigt funktionierend:**
`add_mailbox_v2` (braucht `domain`, `username`=volle Adresse, `password`,
`quota` im Format `"Zahl Einheit"` z. B. `"1024 MB"`, `full_name`),
`update_mailbox_v2` (dieselben Felder plus `active`, `is_admin` - überschreibt
offenbar den kompletten Datensatz, deshalb schickt der Portal-Code beim
Passwortändern die aktuellen Werte mit statt nur das Passwort), `delete_mailbox`
(nur `domain` + `username`). Andere `mail_sys`-Versionen können andere Namen
oder Pflichtfelder haben - bei Fehlern zeigt das „API-Rohaufruf"-Diagnosefeld
oft den echten Python-Traceback aus `mail_sys_main.py` inkl. der fehlenden
Feldnamen, das war hier der schnellste Weg zur Lösung.

Pro Kunde, der Zugang bekommen soll: im Admin-Plugin auf der Kundenseite
(„Stammdaten"-Tab) Portal-Zugang aktivieren und ein Passwort setzen. Der Kunde
loggt sich anschließend mit seiner **Kundennummer** und diesem Passwort ein.
Es gibt keine „Passwort vergessen"-Funktion (keine SMTP-Infrastruktur) – ein
neues Passwort setzt ausschließlich der Admin (über das weiterhin
Python-basierte Admin-Plugin).

## Tests

```bash
npm install
npm test
```
Läuft komplett gegen eine temporäre SQLite-Datei und eine gestubbte
Panel-API – kein echter aaPanel-Server nötig. Ein Test prüft explizit, dass
ein von Python (`cm_store.hash_password`) erzeugter Passwort-Hash von Node
akzeptiert wird (`test/hash-compat.test.js`) – das ist die kritischste
Garantie in diesem Aufbau, da Passwörter weiterhin ausschließlich über das
Python-Admin-Plugin gesetzt werden.

## Troubleshooting

- **`SqliteError: unable to open database file`** beim Start: Der vom
  Node.js-Projektmanager gestartete Prozess läuft unter einem anderen
  Betriebssystem-Benutzer als der aaPanel-Daemon und hat keinen Zugriff auf
  das Datenverzeichnis (`chmod 700`, meist `root`-Eigentümer). Entweder das
  Node-Projekt unter demselben Benutzer laufen lassen, oder die Rechte auf dem
  Datenverzeichnis entsprechend anpassen.
- **`npm install` bricht bei `better-sqlite3` ab:** `build-essential` und
  `python3.11-dev` fehlen (siehe oben) – node-gyp braucht einen C++-Compiler,
  falls kein passendes Prebuild-Binary für die Server-Architektur existiert.
- **Login schlägt trotz korrektem Passwort fehl:** Prüfen, ob unter
  Einstellungen → Mailserver überhaupt ein Passwort gesetzt und der
  Portal-Zugang für den Kunden aktiviert wurde (Admin-Plugin,
  „Stammdaten"-Tab).
- **Postfach-Aktionen melden „ist nicht konfiguriert":** die drei
  Mail-Aktionsnamen (siehe oben) sind noch leer oder falsch.
