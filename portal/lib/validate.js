'use strict';
// Eingabeprüfung für Website-Aktionen im Portal (Hostnamen, Domain-Bereich, URLs).
const url = require('url');

class ValidationError extends Error {}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function normalizeHostname(value) {
  let host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) throw new ValidationError('Hostname fehlt.');
  if (/^https?:\/\//.test(host)) throw new ValidationError('Bitte nur den Hostnamen ohne http:// angeben.');
  // Umlaut-Domains -> Punycode (wie aaPanel sie speichert)
  const ascii = url.domainToASCII(host);
  if (!ascii) throw new ValidationError(`Ungültiger Hostname: ${value}`);
  host = ascii;
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) {
    throw new ValidationError(`Ungültiger Hostname: ${value}`);
  }
  return host;
}

// "shop" oder "dev.shop" - leer bedeutet Hauptdomain
function normalizeSubdomain(value) {
  const sub = String(value || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!sub) return '';
  const ascii = url.domainToASCII(sub + '.example');
  if (!ascii) throw new ValidationError(`Ungültige Subdomain: ${value}`);
  const labels = ascii.slice(0, -'.example'.length).split('.');
  if (!labels.every((l) => LABEL.test(l))) throw new ValidationError(`Ungültige Subdomain: ${value}`);
  return labels.join('.');
}

// host liegt im Bereich, wenn er der Domain entspricht oder eine Subdomain davon ist.
// Die längste passende Domain gewinnt.
function domainOwner(host, domains) {
  let best = null;
  for (const d of domains) {
    if (host === d || host.endsWith('.' + d)) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
}

function redirectTarget(value) {
  const v = String(value || '').trim();
  if (!/^https?:\/\/[^\s"'<>;{}\\]+$/.test(v)) throw new ValidationError('Ziel muss eine gültige http(s)-URL sein.');
  return v;
}

function urlPath(value) {
  const v = String(value || '').trim();
  if (!/^\/[A-Za-z0-9._~/%-]*$/.test(v)) throw new ValidationError('Pfad muss mit / beginnen (erlaubt: a-z, 0-9, . _ ~ / % -).');
  return v;
}

function indexList(value) {
  const v = String(value || '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$/.test(v)) {
    throw new ValidationError('Standard-Dokumente: Dateinamen durch Komma getrennt.');
  }
  return v;
}

module.exports = { ValidationError, normalizeHostname, normalizeSubdomain, domainOwner, redirectTarget, urlPath, indexList };
