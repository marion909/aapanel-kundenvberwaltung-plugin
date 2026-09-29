'use strict';
// Hosting-Pakete: wirksame Limits eines Kunden.
// MUSS mit cm_store.effective_limits (Python, Admin-Plugin) übereinstimmen.
//
// Websites: Kunden-Wert (>= 0) > Paket > Standard aus den Einstellungen.
// Übrige Anzahlen: Paket, ohne Paket unbegrenzt. 0 bedeutet immer "unbegrenzt".
const LIMIT_LABEL = { site: 'Websites', domain: 'Domain-Bereiche', mail_domain: 'Mail-Domains', mailbox: 'Postfächer', ftp: 'FTP-Zugänge' };

function effectiveLimits(customer, pkg, cfg) {
  const c = cfg || {};
  const p = pkg || {};
  const own = customer && customer.max_sites !== undefined && customer.max_sites !== null ? Number(customer.max_sites) : -1;
  let sites;
  if (own >= 0) sites = own;
  else if (pkg) sites = Number(p.max_sites) || 0;
  else sites = Number(c.site_default_max_sites) || 0;
  return {
    site: sites,
    domain: Number(p.max_domains) || 0,
    mail_domain: Number(p.max_mail_domains) || 0,
    mailbox: Number(p.max_mailboxes) || 0,
    mailbox_quota_mb: Number(p.mailbox_quota_mb) || 0,
    upload_mb: Number(p.max_upload_mb) || Number(c.portal_max_upload_mb) || 512,
    ssl: pkg ? !!Number(p.ssl_allowed === undefined ? 1 : p.ssl_allowed) : true,
    ftp: Number(p.max_ftp) || 0,
    ftp_allowed: pkg ? !!Number(p.ftp_allowed === undefined ? 1 : p.ftp_allowed) : true,
  };
}

module.exports = { effectiveLimits, LIMIT_LABEL };
