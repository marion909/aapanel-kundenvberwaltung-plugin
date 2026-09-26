'use strict';
// Minimaler Cloudflare-Client: A/AAAA-Einträge für neue Websites/Subdomains.
// Nur aktiv, wenn im Admin-Plugin E-Mail + Global API Key hinterlegt sind.
// Der Key wird nie an den Browser gegeben.
const https = require('https');

class CloudflareError extends Error {}

function configured(cfg) {
  return !!(cfg.cf_email && cfg.cf_api_key);
}

function call(cfg, method, path, params, body) {
  return new Promise((resolve, reject) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        method,
        hostname: 'api.cloudflare.com',
        path: '/client/v4' + path + qs,
        headers: Object.assign(
          { 'X-Auth-Email': cfg.cf_email, 'X-Auth-Key': cfg.cf_api_key, 'Content-Type': 'application/json' },
          data ? { 'Content-Length': Buffer.byteLength(data) } : {}
        ),
        timeout: 30000,
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(text);
          } catch (e) {
            return reject(new CloudflareError('Ungültige Antwort von Cloudflare'));
          }
          if (!json.success) {
            const msg = (json.errors || []).map((e) => e.message).join(', ');
            return reject(new CloudflareError('Cloudflare: ' + (msg || 'Unbekannter Fehler')));
          }
          resolve(json.result);
        });
      }
    );
    req.on('timeout', () => req.destroy(new CloudflareError('Cloudflare: Timeout')));
    req.on('error', (e) => reject(e instanceof CloudflareError ? e : new CloudflareError('Cloudflare nicht erreichbar: ' + e.message)));
    if (data) req.write(data);
    req.end();
  });
}

async function findZone(cfg, host) {
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const zones = await call(cfg, 'GET', '/zones', { name: labels.slice(i).join('.') });
    if (zones && zones.length) return zones[0];
  }
  return null;
}

// Legt A/AAAA auf die Server-IP an, wenn für host noch kein A/AAAA/CNAME existiert.
async function ensureHostRecords(cfg, host) {
  if (!configured(cfg)) return `Cloudflare nicht konfiguriert – DNS-Eintrag für ${host} bitte manuell auf den Server zeigen lassen.`;
  if (!cfg.server_ipv4 && !cfg.server_ipv6) return 'Keine Server-IP in den Einstellungen – DNS-Eintrag bitte manuell setzen.';
  const zone = await findZone(cfg, host);
  if (!zone) return `Keine Cloudflare-Zone für ${host} gefunden – DNS-Eintrag bitte manuell setzen.`;
  const existing = await call(cfg, 'GET', `/zones/${zone.id}/dns_records`, { name: host });
  const done = [];
  for (const [type, ip] of [['A', cfg.server_ipv4], ['AAAA', cfg.server_ipv6]]) {
    if (!ip) continue;
    if (existing.some((r) => r.type === type || r.type === 'CNAME')) continue;
    await call(cfg, 'POST', `/zones/${zone.id}/dns_records`, null, {
      type, name: host, content: ip, ttl: 1, proxied: !!cfg.cf_proxied,
    });
    done.push(type);
  }
  return done.length ? `DNS-Eintrag (${done.join('/')}) für ${host} in Cloudflare angelegt.` : `DNS-Eintrag für ${host} existiert bereits.`;
}

// Entfernt nur A/AAAA-Einträge von host, die auf die eigene Server-IP zeigen.
async function removeHostRecords(cfg, host) {
  if (!configured(cfg)) return;
  const zone = await findZone(cfg, host);
  if (!zone) return;
  const ips = [cfg.server_ipv4, cfg.server_ipv6].filter(Boolean);
  const records = await call(cfg, 'GET', `/zones/${zone.id}/dns_records`, { name: host });
  for (const r of records) {
    if ((r.type === 'A' || r.type === 'AAAA') && ips.includes(r.content)) {
      await call(cfg, 'DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
    }
  }
}

module.exports = { CloudflareError, configured, ensureHostRecords, removeHostRecords, findZone };
