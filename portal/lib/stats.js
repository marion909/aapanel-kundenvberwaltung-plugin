'use strict';
// Kennzahlen für die Übersicht: Anfragen der letzten 30 Tage (aaPanel-
// Websitestatistik, wie im Sub-aaPanel) und Speicherplatz der Websites.
// Beides ist "best effort" - fehlt eine Quelle, bleibt der Bereich leer.
const fs = require('fs');
const path = require('path');
const { panelCall } = require('./sites');

const DISK_TTL = 10 * 60 * 1000;
const MAX_ENTRIES = 200000;
const diskCache = new Map();

function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Liefert [{date:'2026-09-01', requests:n}, ...] (30 Tage, lückenlos) für die
// angegebenen Websites, oder null, wenn aaPanel keine Statistik liefert.
async function requests30(api, cfg, siteNames, now) {
  if (!siteNames.length) return null;
  const end = now || new Date();
  const start = new Date(end.getTime() - 29 * 86400000);
  const days = [];
  for (let i = 0; i < 30; i++) days.push(ymd(new Date(start.getTime() + i * 86400000)));
  const totals = new Map(days.map((d) => [d, 0]));
  let found = false;
  for (const type of ['PHP', 'WP']) {
    let res;
    try {
      res = await panelCall(api, cfg, 'data', 'getSiteThirtyTotal', { site_type: type, start_date: days[0], end_date: days[29] });
    } catch (e) {
      continue;
    }
    if (!res || typeof res !== 'object') continue;
    for (const name of siteNames) {
      const entry = res[name] || res['www.' + name];
      const list = entry && Array.isArray(entry.list) ? entry.list : [];
      for (const r of list) {
        const s = String(r.date || '');
        const key = s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
        if (totals.has(key)) {
          totals.set(key, totals.get(key) + (Number(r.request) || 0));
          found = true;
        }
      }
    }
    if (found) break;
  }
  return found ? days.map((d) => ({ date: d, requests: totals.get(d) })) : null;
}

// Größe eines Verzeichnisses (ohne Symlinks zu folgen), gecacht.
async function dirSize(root) {
  const hit = diskCache.get(root);
  if (hit && Date.now() - hit.ts < DISK_TTL) return hit.value;
  let total = 0;
  let count = 0;
  let partial = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      if (++count > MAX_ENTRIES) {
        partial = true;
        break;
      }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fs.promises.lstat(p)).size;
        } catch (err) {
          // Datei verschwunden - ignorieren
        }
      }
    }
    if (partial) break;
  }
  const value = { bytes: total, partial };
  diskCache.set(root, { ts: Date.now(), value });
  return value;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

// Flächendiagramm als SVG (nur Zahlen/Datumswerte, daher unbedenklich einzubetten)
function areaChart(points, opts) {
  const o = Object.assign({ w: 720, h: 200, padL: 44, padB: 22, padT: 10, padR: 10 }, opts || {});
  const max = Math.max(1, ...points.map((p) => p.value));
  const nice = niceMax(max);
  const iw = o.w - o.padL - o.padR;
  const ih = o.h - o.padT - o.padB;
  const x = (i) => o.padL + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v) => o.padT + ih - (v / nice) * ih;
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${o.padL},${o.padT + ih} ${line} ${x(points.length - 1).toFixed(1)},${o.padT + ih}`;
  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = (nice / 4) * k;
    const gy = y(v).toFixed(1);
    grid += `<line x1="${o.padL}" x2="${o.w - o.padR}" y1="${gy}" y2="${gy}" class="grid"/>`;
    grid += `<text x="${o.padL - 6}" y="${gy}" class="ylab" text-anchor="end" dominant-baseline="middle">${fmtNum(v)}</text>`;
  }
  let labels = '';
  const step = Math.ceil(points.length / 8);
  points.forEach((p, i) => {
    // letzte Beschriftung nur, wenn sie nicht mit der vorherigen kollidiert
    if (i % step === 0 || (i === points.length - 1 && i % step >= step / 2)) {
      labels += `<text x="${x(i).toFixed(1)}" y="${o.h - 6}" class="xlab" text-anchor="middle">${escapeXml(p.label)}</text>`;
    }
  });
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.5" class="dot"><title>${escapeXml(p.label)}: ${p.value}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${o.w} ${o.h}" class="chart" role="img">${grid}<polygon points="${area}" class="area"/><polyline points="${line}" class="line"/>${dots}${labels}</svg>`;
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function fmtNum(v) {
  if (v >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(+v.toFixed(0));
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { requests30, dirSize, fmtBytes, areaChart, diskCache };
