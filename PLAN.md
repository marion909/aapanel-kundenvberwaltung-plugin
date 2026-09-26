# Plan: aaPanel-Plugin „Kundenverwaltung“ mit Kundenportal

Stand: 2026-09-26 · Status: Entwurf

## 1. Ziel

Ein aaPanel-Plugin, mit dem der Admin Kunden anlegt, ihnen Quota-Pakete zuweist und
in einem geführten Workflow **Kunde → Domain → Webseite → Mail-Domain → Postfächer**
bereitstellt. Zusätzlich ein eigenständiges **Kundenportal** (eigener Login, eigenes
SSL-Zertifikat), in dem Kunden ihre eigenen Ressourcen innerhalb der Paketgrenzen
selbst verwalten:

- DNS-Zonen ihrer Domains: Einträge anlegen, ändern, löschen
- Webseiten anlegen, bearbeiten, löschen (PHP-Version, SSL, Weiterleitungen, …)
- Postfächer anlegen, bearbeiten (Passwort, Quota, Weiterleitung), löschen

## 2. Architektur-Überblick

```
┌──────────────────────── Server ─────────────────────────┐
│                                                          │
│  aaPanel (Port 7800, nur Admin)                          │
│   └─ plugin/kundenverwaltung/                            │
│        ├─ Admin-UI (index.html, JS)                      │
│        ├─ kundenverwaltung_main.py  ← Admin-Aktionen     │
│        └─ core/  (Service-Layer, gemeinsam genutzt)      │
│              ├─ customers, packages, quota               │
│              ├─ adapters: site, dns, mail, ssl            │
│              └─ db (SQLite)                               │
│                                                          │
│  Kundenportal-Dienst (systemd, 127.0.0.1:8850)           │
│   └─ FastAPI/Flask-App → nutzt denselben core/            │
│                                                          │
│  Nginx-vHost portal.<deine-domain> (443, Let's Encrypt)  │
│   └─ reverse proxy → 127.0.0.1:8850                      │
└──────────────────────────────────────────────────────────┘
```

**Wichtige Designentscheidung:** Das Portal spricht **nie direkt** mit dem aaPanel-Login
und bekommt keinen Panel-Zugang. Es nutzt einen gemeinsamen Service-Layer (`core/`), der
jede Aktion auf **Besitzrecht (Tenant) und Quota** prüft, bevor er aaPanel-Funktionen
aufruft. Damit bleibt das Panel selbst unerreichbar für Kunden.

### Anbindung an aaPanel (Adapter)

| Bereich   | Anbindung (bevorzugt)                                              | Fallback                          |
|-----------|--------------------------------------------------------------------|-----------------------------------|
| Webseiten | Panel-Klassen importieren (`panelSite.panelSite().AddSite`, `DeleteSite`, `SetPHPVersion`, Redirects …) | aaPanel-API (`/site?action=…` mit `request_token`) |
| SSL       | `acme_v2` / `panelSite.SetSSL` (Let's Encrypt, HTTP-01)            | aaPanel-API `/acme?action=…`       |
| DNS       | aaPanel-Plugin **DNS Manager** (`dns_manager_main`)                | Eigener Adapter für PowerDNS-API oder externen DNS (Cloudflare, Hetzner) |
| Mail      | aaPanel-Plugin **Mail Server** (`mail_sys_main`: `add_domain`, `add_mailbox`, `update_mailbox`, `delete_mailbox`) | direkt in `postfixadmin.db` (nicht empfohlen) |
| Datenbank | `database.database().AddDatabase` (optional, Phase 3)              | —                                 |
| FTP       | `ftp.ftp().AddUser` (optional, Phase 3)                            | —                                 |

Alle Adapter hinter einem Interface (`SiteAdapter`, `DnsAdapter`, `MailAdapter`), damit
ein späterer Wechsel (z. B. externer DNS) ohne Änderung an UI/Workflow möglich ist.
**Erster Schritt der Umsetzung:** Methodensignaturen der installierten aaPanel-Version
prüfen und in einer Kompatibilitätsschicht kapseln (aaPanel ändert interne APIs gelegentlich).

## 3. Datenmodell (SQLite, `plugin/kundenverwaltung/data/kv.db`)

| Tabelle          | Wichtige Felder |
|------------------|-----------------|
| `packages`       | id, name, max_domains, max_sites, max_subdomains, max_mail_domains, max_mailboxes, mailbox_quota_mb_default, mailbox_quota_mb_total, web_disk_mb, max_databases, max_dns_records, ssl_allowed, php_versions, price_note |
| `customers`      | id, customer_no, company, first_name, last_name, email, phone, address, package_id, status (active/suspended/deleted), created_at, notes |
| `portal_users`   | id, customer_id, username, email, password_hash (argon2id), totp_secret (nullable), last_login, failed_attempts, locked_until |
| `domains`        | id, customer_id, domain, dns_managed (bool), created_at |
| `sites`          | id, customer_id, domain_id, aapanel_site_id, name, path, php_version, ssl_enabled |
| `mail_domains`   | id, customer_id, domain_id, created_at |
| `mailboxes`      | id, customer_id, mail_domain_id, address, quota_mb, active |
| `usage_cache`    | customer_id, web_disk_mb, mail_disk_mb, updated_at |
| `audit_log`      | id, actor (admin/portal-user), customer_id, action, object, payload_json, ip, created_at |
| `sessions`       | id, portal_user_id, token_hash, csrf_token, expires_at, ip, user_agent |

Die aaPanel-Objekte (Sites, Mail-Domains, Postfächer) bleiben die „Wahrheit“ – die
Plugin-DB speichert nur **Zuordnung + Paketdaten**. Ein Sync-Job gleicht beides ab
(z. B. manuell im Panel gelöschte Seiten erkennen).

## 4. Quota-Pakete

- **Zählbare Limits** (Domains, Webseiten, Postfächer, DNS-Einträge, DBs): werden vor
  jeder Anlage im Service-Layer geprüft (`quota.check(customer, "mailboxes", +1)`).
- **Mail-Speicher:** pro Postfach über den Mail-Server-Quota gesetzt; Summe aller
  Postfach-Quotas ≤ `mailbox_quota_mb_total`.
- **Web-Speicher:**
  - Option A (empfohlen, wenn XFS): Projekt-Quota pro Site-Verzeichnis (`xfs_quota`) → hartes Limit.
  - Option B: Cronjob (`du` alle 30–60 min) → Warnung bei 90 %, Sperre für Neuanlagen bei 100 %.
- Paketwechsel: Upgrade sofort; Downgrade nur, wenn aktuelle Nutzung ins neue Paket passt.
- Anzeige im Admin und im Portal als Balken „verwendet / verfügbar“.

## 5. Admin-Workflow im aaPanel-Plugin

Geführter Assistent (Wizard) mit 5 Schritten, jeder Schritt einzeln überspringbar:

1. **Kunde anlegen** – Stammdaten, Paket wählen, Portal-Zugang erzeugen
   (Einladungsmail mit Link zum Passwort-Setzen, kein Klartext-Passwort per Mail).
2. **Domain** – Domain eintragen, optional DNS-Zone im DNS Manager anlegen
   (Standard-Records aus Template: A/AAAA, www, MX, SPF, DMARC, autoconfig).
3. **Webseite** – Site in aaPanel anlegen (Root `/www/wwwroot/<kunde>/<domain>`),
   PHP-Version, optional Let's-Encrypt-SSL sofort ausstellen.
4. **Mail-Domain** – Domain im Mail Server anlegen, DKIM erzeugen und automatisch als
   TXT-Record in die DNS-Zone schreiben.
5. **Postfächer** – ein oder mehrere Postfächer mit Quota anlegen; Zugangsdaten als
   PDF/Übersicht für den Kunden.

Jeder Schritt ist **transaktional gedacht**: schlägt z. B. Schritt 4 fehl, werden
Schritte 1–3 nicht zurückgerollt, aber der Wizard zeigt den Status und erlaubt „erneut
versuchen“. Alle Aktionen landen im `audit_log`.

Weitere Admin-Ansichten: Kundenliste (Suche, Filter, Status), Kundendetail (alle
Ressourcen + Nutzung), Paketverwaltung, Kunde sperren/entsperren (sperrt Sites via
`SiteStop`, Mail-Login, Portal-Login), Kunde löschen (mit Bestätigung und Backup-Option),
„Als Kunde ansehen“ (Impersonation, geloggt).

## 6. Kundenportal

### Technik
- Python 3 (gleiche Umgebung wie aaPanel: `/www/server/panel/pyenv`), **FastAPI** + Jinja2
  oder schlankes SPA (Vue/Alpine) mit JSON-API.
- Läuft als systemd-Dienst `kv-portal.service` als eigener, unprivilegierter User;
  privilegierte Aktionen über eine lokale, auf Root-Seite laufende Worker-Queue
  (siehe Sicherheit).
- Erreichbar über eigenen Nginx-vHost `portal.<deine-domain>` (in aaPanel als Site mit
  Reverse Proxy angelegt) → **Let's-Encrypt-Zertifikat, HTTP→HTTPS, HSTS**.
- Optional: White-Label (Logo, Farben, Name) in den Plugin-Einstellungen.

### Funktionen für den Kunden
- **Dashboard:** Paket, Verbrauch, Domains, Webseiten, Postfächer, SSL-Ablaufdaten.
- **Domains & DNS:** Zonen anzeigen; Records (A, AAAA, CNAME, MX, TXT, SRV, CAA) anlegen,
  bearbeiten, löschen. Validierung (Syntax, TTL-Bereich, keine Konflikte CNAME/andere).
  Geschützte System-Records (z. B. MX/DKIM der Mail-Domain) nur mit Warnung änderbar.
  „Auf Standard zurücksetzen“.
- **Webseiten:** anlegen (Domain/Subdomain aus eigenen Domains), löschen, PHP-Version,
  SSL an/aus + Let's Encrypt, HTTPS erzwingen, Weiterleitungen, Standard-Dokument,
  optional FTP/SFTP-Zugang und Datenbanken (Phase 3), später Dateimanager/1-Klick-WordPress.
- **E-Mail:** Postfächer anlegen/löschen, Passwort ändern, Quota (innerhalb Paket),
  Weiterleitungen/Aliase, Abwesenheitsnotiz (falls Mail Server unterstützt),
  Anzeige der Client-Einstellungen (IMAP/SMTP/Webmail-Link).
- **Konto:** Passwort ändern, 2FA (TOTP) aktivieren, Aktivitätsprotokoll.

## 7. Sicherheit (kritisch, da Kunden indirekt Root-Aktionen auslösen)

- **Tenant-Isolation:** jede Portal-Anfrage lädt das Objekt über
  `customer_id = session.customer_id`; niemals IDs aus dem Request ungeprüft an aaPanel geben.
- **Privilegientrennung:** Portal-Webprozess ohne Root. Aktionen gehen als strukturierte
  Jobs (JSON, Whitelist von Aktionen) an einen Root-Worker über Unix-Socket/Queue;
  der Worker validiert erneut (Ownership + Quota) und ruft die Adapter auf.
- **Eingabevalidierung:** Domain-/Hostnamen per Regex + IDNA, Pfade nur generiert
  (kein Pfad vom Kunden), keine Shell-Aufrufe mit Nutzereingaben.
- **Auth:** argon2id, Login-Rate-Limit + Sperre, optional TOTP, sichere Cookies
  (`Secure`, `HttpOnly`, `SameSite=Strict`), CSRF-Token, Session-Timeout.
- **Transport:** nur HTTPS, HSTS, sichere Header (CSP, X-Frame-Options).
- **Audit:** jede Änderung mit Kunde, IP, Zeit, Vorher/Nachher.
- **Backups:** DB des Plugins in aaPanel-Backup einbinden; vor Löschungen Snapshot.

## 8. Verzeichnisstruktur (Repository)

```
kundenverwaltung/
├── info.json                  # aaPanel-Plugin-Metadaten
├── install.sh                 # Installation/Deinstallation (DB, systemd, Nginx)
├── icon.png
├── index.html                 # Admin-UI (im aaPanel eingebettet)
├── static/                    # JS/CSS der Admin-UI
├── kundenverwaltung_main.py   # aaPanel-Einstiegspunkt (Admin-Aktionen)
├── core/
│   ├── db.py, models.py, migrations/
│   ├── services/ customers.py, packages.py, quota.py, provisioning.py
│   ├── adapters/ site.py, dns.py, mail.py, ssl.py, compat.py
│   └── security.py, audit.py, validators.py
├── portal/
│   ├── app.py                 # FastAPI-App
│   ├── routes/ auth.py, dashboard.py, dns.py, sites.py, mail.py, account.py
│   ├── templates/, static/
│   └── worker.py              # Root-Worker für privilegierte Aktionen
├── cron/ usage_collector.py, sync.py, ssl_watch.py
├── tests/
└── docs/
```

## 9. Umsetzungsphasen

| Phase | Inhalt | Ergebnis |
|-------|--------|----------|
| **0 – Analyse** (1–2 Tage) | aaPanel-Version, installierte Plugins (Mail Server, DNS Manager) prüfen; interne API-Signaturen dokumentieren; Testserver/VM aufsetzen | `compat.py`-Spezifikation |
| **1 – Grundgerüst** | Plugin-Skelett, `install.sh`, SQLite + Migrationen, Pakete- und Kunden-CRUD im Admin | Plugin installierbar, Kunden & Pakete verwaltbar |
| **2 – Provisionierung** | Adapter Site/SSL/DNS/Mail, Wizard (Kunde → Domain → Site → Mail-Domain → Postfächer), Quota-Prüfung, Audit | Admin-Workflow komplett |
| **3 – Portal MVP** | FastAPI-Portal, Login + 2FA, Worker, Nginx-vHost + SSL, Dashboard, DNS-Verwaltung, Postfach-Verwaltung | Kunde verwaltet DNS & Mail selbst |
| **4 – Portal Webseiten** | Sites anlegen/bearbeiten/löschen, SSL, Redirects, PHP; optional FTP & Datenbanken | Volle Self-Service-Funktion |
| **5 – Betrieb** | Web-Disk-Quota (XFS/Cron), Sync-Job, SSL-Ablaufwarnung, Sperren/Entsperren, E-Mail-Benachrichtigungen, White-Label | Produktionsreif |
| **6 – Extras (optional)** | Rechnungs-/WHMCS-Anbindung, 1-Klick-WordPress, Dateimanager, Mehrsprachigkeit (DE/EN), Reseller-Ebene | — |

## 10. Tests

- Unit-Tests für Service-Layer (Quota, Validierung, Ownership) mit gemockten Adaptern.
- Integrationstests gegen eine Test-VM mit aaPanel + Mail Server + DNS Manager.
- Sicherheits-Tests: IDOR (fremde IDs), CSRF, Rate-Limit, Eingabe-Fuzzing für DNS-Records.

## 11. Offene Fragen

1. Welche aaPanel-Version läuft (Free/Pro, Linux-Distribution)? Ist XFS für Disk-Quota vorhanden?
2. DNS: Läuft der DNS auf dem Server (DNS Manager/BIND/PowerDNS) oder extern (Cloudflare, Hetzner, Registrar)?
3. Mail: Wird das offizielle aaPanel-Plugin „Mail Server“ genutzt?
4. Soll das Portal unter einer eigenen Domain laufen (z. B. `kunden.meinefirma.at`)?
5. Dürfen Kunden eigene Domains hinzufügen, oder nur der Admin?
6. Brauchst du FTP/Datenbanken für Kunden bereits im MVP?
7. Sprache des Portals: nur Deutsch oder auch Englisch?
