'use strict';
// Postfach-Dateien des aaPanel-Mailservers (mail_sys/Dovecot, Maildir++ unter
// /www/vmail/<domain>/<postfach>/) lesen und als .tar.gz sichern bzw. aus einer
// Sicherung einen Maildir-Baum für "doveadm import" erzeugen.
//
// Archiv-Aufbau (bewusst ohne Maildir-Interna, damit Kunden es direkt nutzen können):
//   backup.json                      Metadaten (Postfach, Datum, Ordner)
//   <Ordner>/000001_S.eml            eine Nachricht pro Datei, Flags hinter "_"
// Ordnernamen stehen im Archiv lesbar (UTF-8); der originale Maildir-Name
// (modified UTF-7, "." als Trenner) steht in backup.json.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable, Writable } = require('stream');
const { ValidationError } = require('./validate');

const VMAIL_ROOT = process.env.CM_VMAIL_ROOT || '/www/vmail';
const FORMAT = 1;

// ------------------------------------------------------ modified UTF-7 (RFC 3501)
function decodeMutf7(s) {
  return String(s).replace(/&([^-]*)-/g, (m, b64) => {
    if (b64 === '') return '&';
    const buf = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i));
    return out;
  });
}

function encodeMutf7(s) {
  let out = '';
  let pending = '';
  const flush = () => {
    if (!pending) return;
    const buf = Buffer.alloc(pending.length * 2);
    for (let i = 0; i < pending.length; i++) buf.writeUInt16BE(pending.charCodeAt(i), i * 2);
    out += '&' + buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
    pending = '';
  };
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += ch === '&' ? '&-' : ch;
    } else {
      pending += ch; // Zeichen außerhalb der BMP ergeben Surrogat-Paare - so will es RFC 3501
    }
  }
  flush();
  return out;
}

// ------------------------------------------------------------- Postfach-Pfad
function mailboxDir(address, root) {
  const base = root || VMAIL_ROOT;
  const m = /^([a-z0-9._%+-]{1,64})@([a-z0-9.-]{1,253})$/.exec(String(address || '').toLowerCase());
  if (!m || m[1].startsWith('.') || m[2].split('.').some((p) => !p)) throw new ValidationError('Ungültige Postfach-Adresse.');
  const dir = path.join(base, m[2], m[1]);
  let real;
  try {
    real = fs.realpathSync(dir);
  } catch (e) {
    if (e.code === 'EACCES') throw new ValidationError(`Kein Lesezugriff auf ${base} – das Kundenportal muss als root laufen.`);
    throw new ValidationError('Das Postfach-Verzeichnis existiert (noch) nicht – es entsteht mit der ersten Nachricht.');
  }
  const realBase = fs.realpathSync(base);
  if (!real.startsWith(realBase + path.sep)) throw new ValidationError('Ungültiges Postfach-Verzeichnis.');
  // Dovecot-Varianten: Maildir direkt im Postfach-Ordner oder im Unterordner "Maildir"
  for (const cand of [path.join(real, 'Maildir'), real]) {
    if (isDir(path.join(cand, 'cur')) || isDir(path.join(cand, 'new'))) return cand;
  }
  throw new ValidationError('Im Postfach-Verzeichnis wurde kein Maildir gefunden.');
}

function isDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch (e) {
    if (e.code === 'EACCES') throw new ValidationError('Kein Lesezugriff auf die Postfächer – das Kundenportal muss als root laufen.');
    return false;
  }
}

// Ordner: INBOX + Maildir++-Unterordner (".Sent", ".Archiv.2024", ...)
function listFolders(maildir) {
  const out = [{ raw: 'INBOX', name: 'INBOX', dir: maildir }];
  for (const n of fs.readdirSync(maildir).sort()) {
    if (!n.startsWith('.') || n === '.' || n === '..') continue;
    const dir = path.join(maildir, n);
    if (!isDir(path.join(dir, 'cur')) && !isDir(path.join(dir, 'new'))) continue;
    const raw = n.slice(1);
    out.push({ raw, name: raw.split('.').map(decodeMutf7).join('/'), dir });
  }
  return out;
}

// Nachrichten eines Ordners (new/ und cur/), nach Dateiname = Eingangszeit sortiert
function listMessages(folderDir) {
  const out = [];
  for (const sub of ['new', 'cur']) {
    const d = path.join(folderDir, sub);
    let names;
    try {
      names = fs.readdirSync(d);
    } catch (e) {
      continue;
    }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const i = n.indexOf(':2,');
      const flags = sub === 'cur' && i >= 0 ? n.slice(i + 3).replace(/[^A-Z]/g, '') : '';
      out.push({ file: path.join(d, n), name: n, flags });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Archivtauglicher Ordnername (Windows/macOS/Linux), eindeutig pro Sicherung
function safeFolderName(name, used) {
  let s = String(name).split('/').map((p) => p.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim() || '_').join('/');
  if (s === 'INBOX') s = 'Posteingang';
  let cand = s;
  for (let i = 2; used.has(cand.toLowerCase()); i++) cand = `${s} (${i})`;
  used.add(cand.toLowerCase());
  return cand;
}

// ----------------------------------------------------------------- tar (ustar + PAX)
function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader(name, size, mtime, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(Math.max(0, Math.floor(mtime)), 12), 136);
  h.fill(' ', 148, 156);
  h.write(type || '0', 156);
  h.write('ustar\u000000', 257, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148);
  return h;
}

function pad(size) {
  const r = size % 512;
  return r ? Buffer.alloc(512 - r) : Buffer.alloc(0);
}

// Einträge für einen Dateinamen; lange/Nicht-ASCII-Namen über einen PAX-Header
function* tarEntry(name, data, mtime) {
  if (Buffer.byteLength(name) > 99 || /[^\x20-\x7e]/.test(name)) {
    // Datensatz "<Länge> path=<Name>\n" - die Länge zählt ihre eigenen Ziffern mit
    const rec = (k, v) => {
      const body = ` ${k}=${v}\n`;
      const b = Buffer.byteLength(body);
      let len = b + String(b).length;
      while (b + String(len).length !== len) len = b + String(len).length;
      return `${len}${body}`;
    };
    const pax = Buffer.from(rec('path', name), 'utf8');
    yield tarHeader('PaxHeader/' + name.replace(/[^\x20-\x7e]/g, '_').slice(-80), pax.length, mtime, 'x');
    yield pax;
    yield pad(pax.length);
  }
  yield tarHeader(name.replace(/[^\x20-\x7e]/g, '_').slice(-99), data.length, mtime, '0');
  yield data;
  yield pad(data.length);
}

// Ganze Sicherung eines Postfachs als .tar.gz nach `outFile` schreiben
async function writeBackup(maildir, address, outFile, onProgress) {
  const folders = listFolders(maildir);
  const used = new Set();
  const manifest = { format: FORMAT, mailbox: address, created: new Date().toISOString(), folders: [], messages: 0 };
  for (const f of folders) {
    f.archive = safeFolderName(f.name, used);
    f.messages = listMessages(f.dir);
    manifest.folders.push({ raw: f.raw, name: f.name, path: f.archive, messages: f.messages.length });
    manifest.messages += f.messages.length;
  }
  let done = 0;
  async function* entries() {
    yield* tarEntry('backup.json', Buffer.from(JSON.stringify(manifest, null, 2)), Date.now() / 1000);
    for (const f of folders) {
      let n = 0;
      for (const m of f.messages) {
        let data;
        let st;
        try {
          [data, st] = await Promise.all([fs.promises.readFile(m.file), fs.promises.stat(m.file)]);
        } catch (e) {
          if (e.code === 'ENOENT') continue; // inzwischen verschoben/gelöscht
          throw e;
        }
        n++;
        const file = `${f.archive}/${String(n).padStart(6, '0')}${m.flags ? '_' + m.flags : ''}.eml`;
        yield* tarEntry(file, data, st.mtimeMs / 1000);
        done++;
        if (onProgress && done % 200 === 0) onProgress(done, manifest.messages);
      }
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(entries()), zlib.createGzip({ level: 6 }), fs.createWriteStream(outFile, { mode: 0o600 }));
  return { messages: done, folders: manifest.folders.length };
}

// ----------------------------------------------------------------- tar lesen
function parseOctal(buf, off, len) {
  const s = buf.toString('latin1', off, off + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString('utf8', i, sp), 10);
    if (!len) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// Ruft onEntry(name, data, mtime) für jede Datei im .tar.gz auf (sequenziell)
async function readBackup(file, onEntry) {
  let buf = Buffer.alloc(0);
  let cur = null; // { name, size, mtime, type, chunks, got }
  let paxPath = null;
  let ended = false;
  async function consume() {
    for (;;) {
      if (ended) return;
      if (!cur) {
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((b) => b === 0)) {
          ended = true;
          return;
        }
        const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
        cur = {
          name: paxPath || (prefix ? `${prefix}/${name}` : name),
          size: parseOctal(h, 124, 12),
          mtime: parseOctal(h, 136, 12),
          type: String.fromCharCode(h[156] || 48),
          chunks: [],
          got: 0,
        };
        paxPath = null;
      }
      const need = cur.size - cur.got;
      const padded = cur.size + ((512 - (cur.size % 512)) % 512);
      if (need > 0) {
        if (!buf.length) return;
        const take = buf.subarray(0, Math.min(need, buf.length));
        cur.chunks.push(Buffer.from(take));
        cur.got += take.length;
        buf = buf.subarray(take.length);
        if (cur.got < cur.size) return;
      }
      const skip = padded - cur.size;
      if (buf.length < skip) return;
      buf = buf.subarray(skip);
      const data = Buffer.concat(cur.chunks);
      if (cur.type === 'x') paxPath = parsePax(data).path || null;
      else if (cur.type === '0' || cur.type === '\0') await onEntry(cur.name, data, cur.mtime);
      cur = null;
    }
  }
  await pipeline(
    fs.createReadStream(file),
    zlib.createGunzip(),
    new Writable({
      write(chunk, enc, cb) {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        consume().then(() => cb(), cb);
      },
    })
  );
}

// Sicherung in einen frischen Maildir++-Baum unter `target` entpacken
// (Quelle für "doveadm import"). Liefert die Anzahl Nachrichten.
async function extractToMaildir(file, targetDir) {
  const target = path.resolve(targetDir);
  let manifest = null;
  const byPath = new Map();
  let count = 0;
  const mk = (d) => {
    for (const s of ['cur', 'new', 'tmp']) fs.mkdirSync(path.join(d, s), { recursive: true, mode: 0o700 });
  };
  mk(target);
  await readBackup(file, async (name, data, mtime) => {
    if (name === 'backup.json') {
      manifest = JSON.parse(data.toString('utf8'));
      if (manifest.format !== FORMAT || !Array.isArray(manifest.folders)) throw new ValidationError('Unbekanntes Sicherungsformat.');
      for (const f of manifest.folders) byPath.set(f.path, f.raw);
      return;
    }
    if (!manifest) throw new ValidationError('Sicherung ohne backup.json.');
    const slash = name.lastIndexOf('/');
    const raw = byPath.get(name.slice(0, slash));
    const base = name.slice(slash + 1);
    const m = /^(\d{1,9})(?:_([A-Z]*))?\.eml$/.exec(base);
    if (raw === undefined || !m) return; // fremde Datei - ignorieren
    if (raw !== 'INBOX' && !/^[^/\\\0]+$/.test(raw)) throw new ValidationError('Ungültiger Ordnername in der Sicherung.');
    const dir = raw === 'INBOX' ? target : path.join(target, '.' + raw);
    if (path.dirname(dir) !== target && dir !== target) throw new ValidationError('Ungültiger Ordnername in der Sicherung.');
    mk(dir);
    const flags = (m[2] || '').split('').sort().join('');
    const out = path.join(dir, 'cur', `${Math.floor(mtime) || 0}.R${m[1]}.restore:2,${flags}`);
    fs.writeFileSync(out, data, { mode: 0o600 });
    if (mtime) fs.utimesSync(out, mtime, mtime);
    count++;
  });
  if (!manifest) throw new ValidationError('Sicherung ohne backup.json.');
  return { messages: count, manifest };
}

module.exports = {
  VMAIL_ROOT, decodeMutf7, encodeMutf7, mailboxDir, listFolders, listMessages,
  writeBackup, readBackup, extractToMaildir, safeFolderName,
};
