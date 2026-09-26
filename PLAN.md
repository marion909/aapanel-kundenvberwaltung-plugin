# Plan: aaPanel-Plugin „Kundenverwaltung“ mit Kundenportal

Stand: 2026-09-26 · Status: Entwurf v2 (Anforderungen geklärt)

## 1. Ziel

Ein aaPanel-Plugin, mit dem der Admin Kunden anlegt, ihnen Quota-Pakete zuweist und
in einem geführten Workflow **Kunde → Domain → Webseite → Mail-Domain → Postfächer**
bereitstellt. Zusätzlich ein eigenständiges **Kundenportal** (eigener Login, eigenes
SSL-Zertifikat), in dem Kunden ihre eigenen Ressourcen innerhalb der Paketgrenzen
selbst verwalten:

- DNS-Einträge ihrer Domains (Cloudflare): anlegen, ändern, löschen
- Webseiten anlegen, bearbeiten, löschen (PHP-Version, SSL, Weiterleitungen, …)
- Postfächer anlegen, bearbeiten (Passwort, Quota, Weiterleitung), löschen
- FTP-Zugänge und Datenbanken – nur wenn der Admin sie freigeschaltet hat

## 2. Rahmenbedingungen

| Thema | Entscheidung |
|-------|--------------|
| aaPanel-Edition | **Pro** |
| DNS | **Cloudflare**, Verwaltung über die Cloudflare-Anbindung von aaPanel |
| Mail | offizielles aaPanel-Plugin **Mail Server** |
| Portal-Domain | **im Plugin einstellbar**; das Plugin legt vHost und SSL automatisch an |
| Domains hinzufügen | **nur der Admin**; Kunden verwalten nur DNS-Einträge und Subdomains ihrer Domains |
| FTP / Datenbanken | vorhanden, **vom Admin pro Paket bzw. Kunde zuweisbar** |
| Sprachen | **Deutsch und Englisch** (Admin-UI und Portal) |

## 3. Architektur-Überblick

```
┌──────────────────────── Server ─────────────────────────┐
│                                                          │
│  aaPanel Pro (Port 7800, nur Admin)                      │
│   └─ plugin/kundenverwaltung/                            │
│        ├─ Admin-UI (index.html, JS, i18n de/en)          │
│        ├─ kundenverwaltung_main.py  ← Admin-Aktionen     │
│        └─ core/  (Service-Layer, gemeinsam genutzt)      │
│              ├─ customers, packages, quota               │
│              ├─ adapters: site, ssl, dns(Cloudflare),    │
│              │            mail, ftp, database            │
│              └─ db (SQLite)                               │
│                                                          │
│  Portal-Worker (root, Unix-Socket)  ← führt Aktionen aus │
│  Kundenportal (systemd, eigener User, 127.0.0.1:8850)    │
│                                                          │
│  Nginx-vHost <Portal-Domain aus Plugin-Einstellungen>    │
│   └─ 443 + Let's Encrypt → reverse proxy 127.0.0.1:8850  │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTPS (API-Token)
                 ┌───────▼────────┐
                 │ Cloudflare DNS │
                 └────────────────┘
```

**Wichtige Designentscheidung:** Das Portal spricht **nie direkt** mit dem aaPanel-Login
und bekommt keinen Panel-Zugang. Es nutzt einen gemeinsamen Service-Layer (`core/`), der
jede Aktion auf **Besitzrecht (Tenant) und Quota** prüft, bevor er aaPanel-Funktionen
aufruft.

### Anbindung an aaPanel (Adapter)

| Bereich   | Anbindung (bevorzugt)                                              | Fallback |
|-----------|--------------------------------------------------------------------|----------|
| Webseiten | Panel-Klassen (`panelSite.panelSite().AddSite`, `DeleteSite`, `SiteStop/SiteStart`, PHP-Version, Redirects) | aaPanel-API (`/site?action=…` mit `request_token`) |
| SSL       | Let's Encrypt über aaPanel-ACME, **bevorzugt DNS-01 via Cloudflare** (funktioniert auch bei aktivem Cloudflare-Proxy) | HTTP-01 |
| DNS       | **Cloudflare-Konto aus der aaPanel-DNS-API-Konfiguration** (Domain-/DNS-Verwaltung in aaPanel) → Cloudflare API v4 | eigener API-Token in den Plugin-Einstellungen |
| Mail      | Plugin **Mail Server** (`mail_sys_main`: `add_domain`, `add_mailbox`, `update_mailbox`, `delete_mailbox`, DKIM) | — |
| FTP       | `ftp.ftp().AddUser / DeleteUser / SetUserPassword`                 | aaPanel-API |
| Datenbank | `database.database().AddDatabase / DeleteDatabase / ResDatabasePassword` | aaPanel-API |
| Disk-Quota| aaPanel-Pro-Quota für Site-Verzeichnisse (setzt **XFS mit prjquota** voraus) | Cron-Messung mit `du` (siehe 5) |

Alle Adapter liegen hinter einem Interface (`SiteAdapter`, `DnsAdapter`, …). Die
Methodensignaturen ändern sich zwischen aaPanel-Versionen, daher wird in Phase 0 eine
Kompatibilitätsschicht (`adapters/compat.py`) gegen die installierte Version geschrieben.

### Cloudflare im Detail
- Zugangsdaten: bevorzugt das in aaPanel hinterlegte Cloudflare-Konto wiederverwenden;
  alternativ eigener **API-Token mit minimalen Rechten** (`Zone:Read`, `DNS:Edit`, nur
  für die betroffenen Zonen), gespeichert verschlüsselt in der Plugin-DB.
- Admin fügt Domain hinzu → Plugin prüft, ob die Zone in Cloudflare existiert, oder legt
  sie an (Anzeige der Cloudflare-Nameserver für den Registrar).
- Zuordnung `domain ↔ zone_id` wird gespeichert; Kunden sehen nur ihre Zonen.
- Standard-Records beim Anlegen: A/AAAA (Server-IP), `www`, MX, SPF, DMARC, DKIM,
  `autoconfig`/`autodiscover`, `mail` (DNS-only, **nie proxied**).
- Portal zeigt/erlaubt den **Proxy-Schalter (orange Wolke)** pro Record – für Mail-Records gesperrt.
- API-Rate-Limit (1200 Req./5 min) beachten: Zonen-Records kurz cachen.

## 4. Datenmodell (SQLite, `plugin/kundenverwaltung/data/kv.db`)

| Tabelle          | Wichtige Felder |
|------------------|-----------------|
| `settings`       | portal_domain, portal_port, default_language, cloudflare_token (verschlüsselt), branding, smtp für Benachrichtigungen |
| `packages`       | id, name, max_domains, max_sites, max_subdomains, max_mail_domains, max_mailboxes, mailbox_quota_mb_default, mailbox_quota_mb_total, web_disk_mb, **ftp_enabled, max_ftp_accounts, db_enabled, max_databases, db_disk_mb**, max_dns_records, ssl_allowed, php_versions |
| `customers`      | id, customer_no, company, first_name, last_name, email, phone, address, language (de/en), package_id, **feature_overrides_json** (FTP/DB pro Kunde ein-/ausschalten, Limits überschreiben), status (active/suspended/deleted), notes |
| `portal_users`   | id, customer_id, username, email, password_hash (argon2id), totp_secret, language, last_login, failed_attempts, locked_until |
| `domains`        | id, customer_id, domain, cloudflare_zone_id, created_at |
| `sites`          | id, customer_id, domain_id, aapanel_site_id, name, path, php_version, ssl_enabled |
| `mail_domains`   | id, customer_id, domain_id |
| `mailboxes`      | id, customer_id, mail_domain_id, address, quota_mb, active |
| `ftp_accounts`   | id, customer_id, site_id, aapanel_ftp_id, username |
| `databases`      | id, customer_id, aapanel_db_id, name, db_user, type (MySQL) |
| `usage_cache`    | customer_id, web_disk_mb, mail_disk_mb, db_disk_mb, updated_at |
| `audit_log`      | id, actor, customer_id, action, object, payload_json, ip, created_at |
| `sessions`       | id, portal_user_id, token_hash, csrf_token, expires_at, ip, user_agent |

aaPanel und Cloudflare bleiben die „Wahrheit“; die Plugin-DB speichert Zuordnung und
Paketdaten. Ein Sync-Job erkennt Abweichungen (z. B. im Panel manuell gelöschte Seiten).

## 5. Quota-Pakete

- **Zählbare Limits** (Domains, Webseiten, Subdomains, Postfächer, FTP, DBs, DNS-Records)
  werden vor jeder Anlage im Service-Layer geprüft.
- **Funktionsfreigabe:** effektive Rechte = Paket + Kunden-Overrides. Ist FTP/DB nicht
  freigegeben, wird der Menüpunkt im Portal ausgeblendet **und** die API lehnt ab.
- **Mail-Speicher:** Quota pro Postfach; Summe ≤ `mailbox_quota_mb_total`.
- **Web-Speicher:** Pro-Quota von aaPanel, falls `/www` auf XFS mit `prjquota` liegt
  (Installer prüft das und zeigt das Ergebnis an); sonst Cron-Messung → Warnung bei
  90 %, keine Neuanlagen bei 100 %.
- **DB-Speicher:** aaPanel-Pro-DB-Quota, sonst Messung über `information_schema`.
- Paketwechsel: Upgrade sofort; Downgrade nur, wenn aktuelle Nutzung passt.

## 6. Admin-Bereich im aaPanel-Plugin

**Wizard (5 Schritte, einzeln überspringbar / wiederholbar):**

1. **Kunde anlegen** – Stammdaten, Sprache, Paket, optionale Freigaben (FTP/DB);
   Portal-Zugang per Einladungsmail (Link zum Passwort-Setzen).
2. **Domain** – Domain eintragen → Cloudflare-Zone verknüpfen/anlegen → Standard-Records.
3. **Webseite** – Site anlegen (`/www/wwwroot/<kundennr>/<domain>`), PHP-Version,
   Let's Encrypt per DNS-01; optional direkt FTP-Zugang und Datenbank.
4. **Mail-Domain** – im Mail Server anlegen, DKIM erzeugen und in Cloudflare eintragen.
5. **Postfächer** – mit Quota anlegen; Zugangsdaten-Übersicht (PDF) für den Kunden.

Schlägt ein Schritt fehl, bleiben die vorigen bestehen; der Wizard zeigt den Status und
bietet „Erneut versuchen“. Alles landet im Audit-Log.

**Weitere Ansichten:** Kundenliste, Kundendetail mit Verbrauch, Paketverwaltung,
Kunde sperren/entsperren (Sites stoppen, Mail/FTP/Portal sperren), Kunde löschen (mit
Backup-Option), „Als Kunde ansehen“ (geloggt), Domains nachträglich hinzufügen/entfernen.

**Plugin-Einstellungen:** Portal-Domain (Speichern → Nginx-vHost + Reverse Proxy +
Let's Encrypt werden angelegt bzw. umgestellt), Portal-Port, Cloudflare-Zugang
(aaPanel-Konto oder eigener Token + „Verbindung testen“), Standardsprache, Branding
(Name, Logo, Farbe), SMTP-Absender, DNS-Record-Vorlage.

## 7. Kundenportal

### Technik
- Python 3 (aaPanel-pyenv), **FastAPI** + Jinja2-Templates mit Alpine.js.
- systemd-Dienst `kv-portal.service` unter eigenem User; privilegierte Aktionen über den
  Root-Worker (Unix-Socket, feste Aktions-Whitelist).
- **i18n:** Übersetzungsdateien `i18n/de.json`, `i18n/en.json`; Sprache aus Benutzerprofil,
  umschaltbar im Portal; E-Mails ebenfalls zweisprachig.
- HTTPS-only, HSTS; Zertifikat wird vom Plugin automatisch erneuert (aaPanel-Renewal).

### Funktionen für den Kunden
- **Dashboard:** Paket, Verbrauch (Balken), Domains, Webseiten, Postfächer, SSL-Ablauf.
- **DNS (Cloudflare):** Records A, AAAA, CNAME, MX, TXT, SRV, CAA anlegen/ändern/löschen,
  TTL, Proxy an/aus. Validierung (Syntax, CNAME-Konflikte). Systemrecords (MX, DKIM,
  SPF der Mail-Domain) sind geschützt bzw. nur mit Warnung änderbar. **Keine** neuen
  Domains/Zonen – das macht nur der Admin.
- **Webseiten:** anlegen auf eigenen Domains/Subdomains (DNS-Record wird automatisch
  gesetzt), löschen, PHP-Version, SSL + HTTPS erzwingen, Weiterleitungen, Standard-Dokument.
- **FTP** (falls freigegeben): Zugänge pro Webseite anlegen, Passwort ändern, löschen.
- **Datenbanken** (falls freigegeben): anlegen, Passwort ändern, löschen, Link zu phpMyAdmin.
- **E-Mail:** Postfächer anlegen/löschen, Passwort, Quota, Aliase/Weiterleitungen,
  Client-Einstellungen und Webmail-Link.
- **Konto:** Passwort, 2FA (TOTP), Sprache, Aktivitätsprotokoll.

## 8. Sicherheit

- **Tenant-Isolation:** jedes Objekt wird über `customer_id = session.customer_id` geladen;
  keine ungeprüften IDs an aaPanel/Cloudflare.
- **Privilegientrennung:** Portal ohne Root; Root-Worker prüft Ownership + Quota erneut.
- **Cloudflare:** Token mit minimalen Rechten, verschlüsselt gespeichert, nie an den Browser.
- **Eingabevalidierung:** Hostnamen per Regex + IDNA, Pfade nur serverseitig erzeugt,
  keine Shell-Aufrufe mit Nutzereingaben.
- **Auth:** argon2id, Rate-Limit + Sperre, TOTP, Cookies `Secure/HttpOnly/SameSite=Strict`,
  CSRF-Token, Session-Timeout.
- **Header:** CSP, X-Frame-Options, Referrer-Policy.
- **Audit + Backup:** alle Änderungen protokolliert; Plugin-DB im aaPanel-Backup.

## 9. Verzeichnisstruktur

```
kundenverwaltung/
├── info.json, install.sh, icon.png
├── index.html, static/            # Admin-UI
├── i18n/ de.json, en.json         # gemeinsam für Admin & Portal
├── kundenverwaltung_main.py       # aaPanel-Einstiegspunkt
├── core/
│   ├── db.py, models.py, migrations/
│   ├── services/ customers.py, packages.py, quota.py, provisioning.py, settings.py
│   ├── adapters/ site.py, ssl.py, cloudflare.py, mail.py, ftp.py, database.py, compat.py
│   └── security.py, audit.py, validators.py, crypto.py
├── portal/
│   ├── app.py, worker.py
│   ├── routes/ auth.py, dashboard.py, dns.py, sites.py, mail.py, ftp.py, databases.py, account.py
│   └── templates/, static/
├── cron/ usage_collector.py, sync.py, ssl_watch.py
└── tests/
```

## 10. Umsetzungsphasen

| Phase | Inhalt | Ergebnis |
|-------|--------|----------|
| **0 – Analyse** | aaPanel-Pro-Version, Mail-Server-Plugin, Cloudflare-Konfiguration in aaPanel, Dateisystem (XFS?) prüfen; API-Signaturen dokumentieren; Test-VM | `compat.py`-Spezifikation |
| **1 – Grundgerüst** | Plugin-Skelett, `install.sh`, SQLite + Migrationen, i18n-Grundlage, Einstellungen, Pakete- und Kunden-CRUD | Plugin installierbar |
| **2 – Provisionierung** | Adapter Site/SSL/Cloudflare/Mail/FTP/DB, Wizard, Quota + Freigaben, Audit | Admin-Workflow komplett |
| **3 – Portal MVP** | FastAPI-Portal, Worker, automatischer vHost + SSL für Portal-Domain, Login + 2FA, Dashboard, DNS, E-Mail | Kunde verwaltet DNS & Mail |
| **4 – Portal erweitert** | Webseiten, SSL, Redirects, PHP, FTP, Datenbanken | volle Self-Service-Funktion |
| **5 – Betrieb** | Disk-Quota (XFS/Cron), Sync-Job, SSL-Warnung, Sperren, Benachrichtigungen, Branding | produktionsreif |
| **6 – Optional** | Rechnungs-/WHMCS-Anbindung, 1-Klick-WordPress, Dateimanager, Reseller-Ebene | — |

## 11. Tests

- Unit-Tests für Service-Layer (Quota, Freigaben, Validierung, Ownership) mit Mock-Adaptern.
- Cloudflare-Adapter gegen Test-Zone bzw. aufgezeichnete API-Antworten.
- Integrationstests auf Test-VM mit aaPanel Pro + Mail Server.
- Sicherheitstests: IDOR, CSRF, Rate-Limit, Fuzzing der DNS-Eingaben.

## 12. Noch offen

1. Liegt `/www` auf **XFS mit `prjquota`**? (Sonst Web-Disk-Quota nur per Messung.)
   Prüfen mit: `df -T /www` und `mount | grep /www`.
2. Ist das Cloudflare-Konto in aaPanel mit **API-Token** oder mit **Global API Key**
   hinterlegt? (Token wird empfohlen.)
