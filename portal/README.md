# Kundenportal – Deployment

Dieses Verzeichnis ist eine eigenständige Flask-App. Sie läuft **nicht** als
Teil des `customer_mgr`-Admin-Plugins, sondern als separater Prozess, weil
aaPanel für jede `/customer_mgr/...`-URL zwingend eine eingeloggte
Admin-Session verlangt – ein Kunde kann diese Route nie erreichen. Diese App
teilt sich stattdessen nur die Datenbank (`../customer_mgr.db` im
Daten-Verzeichnis des Plugins) und den aaPanel-API-Key mit dem Admin-Plugin.

## Deployment über den aaPanel Python-Projektmanager

1. Falls noch nicht installiert: Plugin **"Python-Projektmanager"** im
   Plugin-Store installieren.
2. Neues Projekt anlegen, Projektverzeichnis auf diesen Ordner
   (`.../plugin/customer_mgr/portal`) zeigen lassen.
3. Startdatei: `app.py`, WSGI-Objekt: `app` (Standard-Flask-Konvention, keine
   Sonderkonfiguration nötig). Framework-Typ: Flask.
4. Abhängigkeiten aus `requirements.txt` installieren lassen (nur `Flask`).
5. Port frei wählen (Vorschlag: `8901`), Prozess starten.
6. **Domain/Reverse-Proxy einrichten:** entweder direkt über die
   Domain-Bindung des Python-Projektmanagers, oder klassisch über eine
   normale aaPanel-Website (Subdomain, z. B. `kunden.deinedomain.tld`) mit
   Reverse-Proxy auf `127.0.0.1:<Port>` und Let's-Encrypt-SSL über den
   Website-Assistenten. Der Kunden-Login läuft ausschließlich über diese
   HTTPS-Adresse – den gewählten Port selbst nicht öffentlich freigeben.
7. Empfehlung: 1–2 Worker-Prozesse (`--workers 1` bzw. `2`). Der
   Ressourcen-Cache lebt pro Worker-Prozess (siehe `cm_resources.py`), bei
   dieser Traffic-Größe unkritisch.

## Vor dem ersten Kunden-Login

Im Admin-Plugin unter **Einstellungen → Mailserver** die drei Aktionsnamen für
Postfach anlegen/Passwort ändern/löschen eintragen. Diese Namen sind nicht
öffentlich dokumentiert und je nach `mail_sys`-Version unterschiedlich – über
das bereits vorhandene **"API-Rohaufruf"**-Diagnosefeld (Einstellungen-Tab)
gegen die eigene Installation ermitteln. Ohne diese Konfiguration meldet das
Portal beim Postfach-Anlegen/Ändern/Löschen einen klaren Fehler statt etwas
Falsches zu tun.

Pro Kunde, der Zugang bekommen soll: im Admin-Plugin auf der Kundenseite
("Stammdaten"-Tab) Portal-Zugang aktivieren und ein Passwort setzen. Der
Kunde loggt sich anschließend mit seiner **Kundennummer** und diesem Passwort
ein. Es gibt keine "Passwort vergessen"-Funktion (keine SMTP-Infrastruktur) –
ein neues Passwort setzt ausschließlich der Admin.

## Lokaler Test (ohne aaPanel-Server)

```bash
cd portal
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
mkdir -p /tmp/customer_mgr_test
PORTAL_DEBUG=1 CM_DATA_DIR=/tmp/customer_mgr_test python3 app.py
```
`PORTAL_DEBUG=1` deaktiviert `SESSION_COOKIE_SECURE`, damit der Login auch
über Klartext-`http://127.0.0.1:8901` funktioniert (Browser setzen
"Secure"-Cookies sonst nicht über HTTP). **Nicht** in Produktion setzen.

## Troubleshooting

- **`sqlite3.OperationalError: unable to open database file`** beim Start:
  Der vom Python-Projektmanager gestartete Prozess läuft unter einem anderen
  Betriebssystem-Benutzer als der aaPanel-Daemon und hat keinen Zugriff auf
  das Datenverzeichnis (`chmod 700`, meist `root`-Eigentümer). Entweder das
  Python-Projekt unter demselben Benutzer laufen lassen, oder die Rechte auf
  dem Datenverzeichnis entsprechend anpassen.
- **Login schlägt trotz korrektem Passwort fehl:** Prüfen, ob unter
  Einstellungen → Mailserver überhaupt ein Passwort gesetzt und der
  Portal-Zugang für den Kunden aktiviert wurde (Admin-Plugin,
  "Stammdaten"-Tab).
- **Postfach-Aktionen melden "ist nicht konfiguriert":** die drei
  Mail-Aktionsnamen (siehe oben) sind noch leer oder falsch.
