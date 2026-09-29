# Kundenverwaltung (`customer_mgr`) für aaPanel

aaPanel-Plugin zum Anlegen von Kunden und Zuordnen von Websites, Mail-Domains
und Postfächern – plus eigenständiges **Kundenportal** (Node.js, `portal/`), in
dem Kunden ihre Websites (inkl. Subdomains, SSL, PHP, Weiterleitungen und
Dateimanager mit Upload), FTP-Zugänge (nur innerhalb der eigenen Website) und
Postfächer selbst verwalten.

- Admin-Plugin: `customer_mgr_main.py`, `cm_*.py`, `templates/`, `static/`
- Kundenportal: `portal/` – Deployment und Funktionsumfang siehe
  [`portal/README.md`](portal/README.md)
- Mail-Monitor: `mail_monitor/` – prüft per echter Testmail, ob der Mailserver
  senden und empfangen kann, und meldet Störungen per Discord-Webhook, siehe
  [`mail_monitor/README.md`](mail_monitor/README.md)

## Installation

Das fertige Paket `customer_mgr-vX.Y.Z.zip` gibt es unter **Releases**. In
aaPanel unter *App Store → Plugin importieren* hochladen (oder nach
`/www/server/panel/plugin/` entpacken und `bash install.sh install` ausführen).
Das Portal danach wie in `portal/README.md` beschrieben starten
(`npm install` im Ordner `portal/`).

## Releases

Jeder Push auf `main` testet das Projekt (Python + Node) und veröffentlicht
automatisch ein GitHub-Release mit dem ZIP (`.github/workflows/release.yml`):

- Basis ist `versions` in `info.json`. Existiert das Tag dazu noch nicht, wird
  genau diese Version veröffentlicht, sonst wird die Patch-Nummer erhöht
  (`1.1.0` → `1.1.1` → …).
- Für eine neue Minor-/Major-Version `versions` in `info.json` anheben.
- Andere Branches und Pull Requests bauen das ZIP nur als Artefakt
  (`…-dev.<Lauf>`).

Lokal bauen: `scripts/build_release.sh 1.2.3` → `build/customer_mgr-v1.2.3.zip`.

## Tests

```bash
python3 -m unittest discover -s tests -t .
cd portal && npm ci && npm test
```
