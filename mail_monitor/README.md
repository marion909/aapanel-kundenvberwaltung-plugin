# Mail-Monitor

Prüft, ob der Mailserver **tatsächlich** Mails senden und empfangen kann, und
schickt bei einer Störung eine Nachricht an einen **Discord-Webhook**.

Dass Postfix und Dovecot laufen, heißt noch nicht, dass Mails durchgehen
(volle Platte, kaputte Konfiguration, Relay gesperrt, Blacklist, abgelaufenes
Zertifikat …). Darum verschickt der Monitor bei jedem Lauf echte Testmails:

| Prüfung       | Was passiert                                                                 |
|---------------|------------------------------------------------------------------------------|
| **Ausgang**   | Login per SMTP am eigenen Server → Mail an ein externes Postfach → Zustellung per IMAP dort nachgewiesen |
| **Eingang**   | Externes Postfach schickt eine Mail an ein Postfach auf dem eigenen Server → per IMAP nachgewiesen |
| Spam          | Landet die Testmail beim externen Anbieter im Spam-Ordner → Warnung            |
| Ports         | Verbindung + Begrüßung (220 / `* OK`) auf z. B. 25, 587, 993, inkl. STARTTLS   |
| Zertifikate   | Warnung, wenn ein TLS-Zertifikat bald abläuft oder ungültig ist               |
| Warteschlange | Anzahl Mails in `postqueue -p` (hängende Mails), nur auf dem Mailserver       |

Testmails werden nach dem Nachweis wieder gelöscht. Nur
Python-Standardbibliothek, keine Installation nötig.

## Einrichtung im Panel (empfohlen)

In der Kundenverwaltung unter **Einstellungen → Mail-Monitoring**: Postfächer
und Discord-Webhook eintragen, „Monitoring aktiv“ anhaken, speichern. Das
Plugin schreibt die Konfiguration nach
`/www/server/panel/data/customer_mgr/mail_monitor.ini` (übersteht Updates)
und legt den Cron-Eintrag `/etc/cron.d/customer_mgr_mail_monitor` selbst an.
„Discord testen“ und „Jetzt prüfen“ gibt es dort ebenfalls, dazu die
Ergebnisse des letzten Laufs. Eine vorhandene `/etc/mail_monitor.ini` wird
beim ersten Öffnen übernommen – danach einen selbst angelegten Cron-Job
löschen.

## Einrichtung von Hand (ohne Panel)

1. **Postfächer anlegen**
   - auf dem eigenen Server ein eigenes Postfach, z. B. `monitor@deine-domain.de`
   - bei einem fremden Anbieter (GMX, web.de, Gmail, Outlook …) ein Postfach
     mit aktiviertem IMAP/SMTP (Gmail/Outlook: App-Passwort)
2. **Discord-Webhook**: Kanal → *Kanal bearbeiten → Integrationen → Webhooks →
   Neuer Webhook → Webhook-URL kopieren*.
3. **Konfiguration**:
   ```bash
   cp mail_monitor.example.ini /etc/mail_monitor.ini
   chmod 600 /etc/mail_monitor.ini
   nano /etc/mail_monitor.ini
   ```
4. **Testen**:
   ```bash
   python3 mail_monitor.py -c /etc/mail_monitor.ini --test-webhook   # kommt die Discord-Nachricht an?
   python3 mail_monitor.py -c /etc/mail_monitor.ini -v --no-alert    # Prüfung ohne Benachrichtigung
   ```
5. **Regelmäßig ausführen**, z. B. alle 10 Minuten per Cron (in aaPanel:
   *Cron → Shell-Skript*):
   ```bash
   python3 /www/server/panel/plugin/customer_mgr/mail_monitor/mail_monitor.py -c /etc/mail_monitor.ini
   ```
   oder in `crontab -e`:
   ```
   */10 * * * * python3 /pfad/zu/mail_monitor.py -c /etc/mail_monitor.ini >/dev/null 2>&1
   ```

> Tipp: Läuft der Monitor auf einem **anderen** Rechner als der Mailserver,
> meldet er auch einen komplett ausgefallenen Server. Die
> Warteschlangen-Prüfung (`queue = yes`) funktioniert allerdings nur direkt
> auf dem Mailserver – auf einem anderen Rechner `queue = no` setzen.

## Benachrichtigungen

- gemeldet wird erst nach `alert_after_failures` Fehlschlägen in Folge
  (Standard 2, filtert kurze Aussetzer)
- solange die Störung anhält, höchstens alle `repeat_alert_minutes` erneut,
  sofort aber, wenn sich die Art der Störung ändert
- sobald wieder alles funktioniert, kommt eine „funktioniert wieder“-Nachricht
- `mention` in `[discord]` pingt einen Benutzer oder eine Rolle bei Störungen

Exit-Code: `0` ok, `1` Warnung, `2` Fehler, `3` Konfigurationsfehler, also
auch für andere Monitoring-Systeme nutzbar.
