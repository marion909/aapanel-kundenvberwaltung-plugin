'use strict';
// Dateimanager für das Kundenportal - strikt auf das Verzeichnis EINER Website
// beschränkt. Alle Pfade aus dem Browser sind relativ zum Website-Verzeichnis;
// jede Operation löst den Pfad per realpath auf und lehnt alles ab, was außerhalb
// liegt (auch Symlinks, die nach draußen zeigen). Neue Dateien/Ordner bekommen
// den Besitzer des Website-Verzeichnisses (z. B. www oder der aaPanel-Benutzer).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { ValidationError } = require('./validate');

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const PROTECTED = new Set(['.user.ini']);
const PART_SUFFIX = '.cmpart';
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

class FileManager {
  constructor(root, maxUploadBytes) {
    let real;
    try {
      real = fs.realpathSync(root);
    } catch (e) {
      throw new ValidationError('Website-Verzeichnis existiert nicht.');
    }
    if (!fs.statSync(real).isDirectory()) throw new ValidationError('Website-Verzeichnis existiert nicht.');
    this.root = real;
    const st = fs.statSync(real);
    this.uid = st.uid;
    this.gid = st.gid;
    this.maxUploadBytes = maxUploadBytes || 512 * 1024 * 1024;
  }

  // ---------------------------------------------------------------- Pfade
  static cleanParts(rel) {
    const s = String(rel || '').replace(/\\/g, '/');
    if (s.includes('\0')) throw new ValidationError('Ungültiger Pfad.');
    const parts = s.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.some((p) => p === '..')) throw new ValidationError('Ungültiger Pfad.');
    return parts;
  }

  static checkName(name) {
    const n = String(name || '').trim();
    if (!n || n === '.' || n === '..' || /[/\\\0]/.test(n) || Buffer.byteLength(n) > 255) {
      throw new ValidationError('Ungültiger Dateiname.');
    }
    return n;
  }

  inside(real) {
    return real === this.root || real.startsWith(this.root + path.sep);
  }

  rel(real) {
    const r = path.relative(this.root, real).split(path.sep).join('/');
    return '/' + (r === '' ? '' : r);
  }

  // existierender Pfad, Symlinks aufgelöst
  resolve(rel) {
    const full = path.join(this.root, ...FileManager.cleanParts(rel));
    let real;
    try {
      real = fs.realpathSync(full);
    } catch (e) {
      throw new ValidationError('Datei oder Ordner nicht gefunden.');
    }
    if (!this.inside(real)) throw new ValidationError('Zugriff verweigert.');
    return real;
  }

  resolveDir(rel) {
    const p = this.resolve(rel);
    if (!fs.statSync(p).isDirectory()) throw new ValidationError('Kein Ordner.');
    return p;
  }

  // Der Eintrag selbst (nicht das Symlink-Ziel); Elternordner muss innerhalb liegen
  entry(rel) {
    const parts = FileManager.cleanParts(rel);
    if (!parts.length) throw new ValidationError('Das Website-Verzeichnis selbst kann nicht verändert werden.');
    const parent = this.resolveDir(parts.slice(0, -1).join('/'));
    const p = path.join(parent, parts[parts.length - 1]);
    if (!exists(p)) throw new ValidationError('Datei oder Ordner nicht gefunden.');
    if (PROTECTED.has(path.basename(p))) throw new ValidationError(`${path.basename(p)} ist geschützt.`);
    return p;
  }

  // neuer Eintrag `name` in Ordner `relDir`
  target(relDir, name) {
    const n = FileManager.checkName(name);
    const p = path.join(this.resolveDir(relDir), n);
    if (isLink(p)) throw new ValidationError('Symlinks können nicht überschrieben werden.');
    return p;
  }

  chown(p) {
    try {
      fs.lchownSync(p, this.uid, this.gid);
    } catch (e) {
      // ohne root-Rechte nicht möglich - dann bleibt der Prozess-Benutzer Besitzer
    }
  }

  chownTree(top) {
    this.chown(top);
    if (!isLink(top) && fs.statSync(top).isDirectory()) {
      for (const n of fs.readdirSync(top)) this.chownTree(path.join(top, n));
    }
  }

  // ----------------------------------------------------------------- Liste
  list(rel) {
    const dir = this.resolveDir(rel);
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(PART_SUFFIX)) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (e) {
        continue;
      }
      const link = st.isSymbolicLink();
      let isDir = st.isDirectory();
      if (link) {
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch (e) {
          isDir = false;
        }
      }
      entries.push({
        name,
        dir: isDir,
        size: isDir ? 0 : st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
        mode: (st.mode & 0o777).toString(8),
        link,
        protected: PROTECTED.has(name),
        zip: !isDir && /\.zip$/i.test(name),
        editable: !isDir && st.size <= MAX_EDIT_BYTES,
      });
    }
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }) : a.dir ? -1 : 1));
    return { path: this.rel(dir), entries };
  }

  // ------------------------------------------------------- Lesen/Schreiben
  readText(rel) {
    const p = this.resolve(rel);
    const st = fs.statSync(p);
    if (!st.isFile()) throw new ValidationError('Keine Datei.');
    if (st.size > MAX_EDIT_BYTES) throw new ValidationError('Datei ist zu groß für den Editor (max. 2 MB).');
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) throw new ValidationError('Binärdateien können nicht bearbeitet werden.');
    const utf8 = buf.toString('utf8');
    const encoding = Buffer.from(utf8, 'utf8').equals(buf) ? 'utf8' : 'latin1';
    return { content: encoding === 'utf8' ? utf8 : buf.toString('latin1'), encoding, path: this.rel(p) };
  }

  writeBytes(p, data, mode) {
    const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW, mode || 0o644);
    try {
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    this.chown(p);
  }

  writeText(rel, content, encoding) {
    const p = this.entry(rel);
    if (isLink(p) || !fs.statSync(p).isFile()) throw new ValidationError('Datei kann nicht gespeichert werden.');
    const data = Buffer.from(String(content), encoding === 'latin1' ? 'latin1' : 'utf8');
    if (data.length > MAX_EDIT_BYTES) throw new ValidationError('Inhalt ist zu groß (max. 2 MB).');
    this.writeBytes(p, data, fs.statSync(p).mode & 0o777);
  }

  createFile(relDir, name) {
    const p = this.target(relDir, name);
    if (exists(p)) throw new ValidationError('Existiert bereits.');
    this.writeBytes(p, Buffer.alloc(0));
  }

  mkdir(relDir, name) {
    const p = this.target(relDir, name);
    if (exists(p)) throw new ValidationError('Existiert bereits.');
    fs.mkdirSync(p, 0o755);
    this.chown(p);
  }

  // ------------------------------------------ Umbenennen/Verschieben/Löschen
  rename(rel, newName) {
    const src = this.entry(rel);
    const dst = this.target(this.rel(path.dirname(src)), newName);
    if (PROTECTED.has(path.basename(dst))) throw new ValidationError(`${path.basename(dst)} ist geschützt.`);
    if (exists(dst)) throw new ValidationError('Ziel existiert bereits.');
    fs.renameSync(src, dst);
  }

  move(rels, relDest, copy) {
    const dest = this.resolveDir(relDest);
    for (const rel of rels) {
      const src = this.entry(rel);
      const dst = path.join(dest, path.basename(src));
      if (exists(dst)) throw new ValidationError(`${path.basename(src)} existiert im Ziel bereits.`);
      const srcIsDir = !isLink(src) && fs.statSync(src).isDirectory();
      if (srcIsDir && (dest + path.sep).startsWith(src + path.sep)) {
        throw new ValidationError('Ein Ordner kann nicht in sich selbst verschoben werden.');
      }
      if (copy) {
        fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        this.chownTree(dst);
      } else {
        fs.renameSync(src, dst);
      }
    }
  }

  delete(rels) {
    for (const rel of rels) {
      const p = this.entry(rel);
      if (!isLink(p) && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
    }
  }

  chmod(rel, mode) {
    const p = this.entry(rel);
    if (isLink(p)) throw new ValidationError('Rechte von Symlinks können nicht geändert werden.');
    if (!/^[0-7]{3}$/.test(String(mode || ''))) throw new ValidationError('Ungültige Rechte (z. B. 644 oder 755).');
    fs.chmodSync(p, parseInt(mode, 8));
  }

  // ---------------------------------------------------------------- Upload
  // Der Browser schickt Dateien in Stücken (wie der aaPanel-Dateimanager):
  // offset/total pro Stück. `name` darf Unterordner enthalten (Ordner-Upload),
  // diese werden bei offset 0 sicher angelegt.
  uploadChunk(relDir, name, offset, total, data, overwrite) {
    offset = Number(offset);
    total = Number(total);
    if (!Number.isInteger(offset) || !Number.isInteger(total) || offset < 0 || total < 0) {
      throw new ValidationError('Ungültiger Upload.');
    }
    if (total > this.maxUploadBytes) {
      throw new ValidationError(`Datei ist zu groß (max. ${Math.floor(this.maxUploadBytes / 1048576)} MB).`);
    }
    const parts = FileManager.cleanParts(name);
    if (!parts.length) throw new ValidationError('Ungültiger Dateiname.');
    parts.forEach((p) => FileManager.checkName(p));
    let dir = this.resolveDir(relDir);
    for (const sub of parts.slice(0, -1)) {
      const next = path.join(dir, sub);
      if (isLink(next)) throw new ValidationError(`${sub} ist ein Symlink.`);
      if (!exists(next)) {
        if (offset !== 0) throw new ValidationError('Upload-Ordner fehlt.');
        fs.mkdirSync(next, 0o755);
        this.chown(next);
      } else if (!fs.statSync(next).isDirectory()) {
        throw new ValidationError(`${sub} ist kein Ordner.`);
      }
      dir = next;
    }
    const fileName = parts[parts.length - 1];
    const finalPath = path.join(dir, fileName);
    if (!this.inside(fs.realpathSync(dir))) throw new ValidationError('Zugriff verweigert.');
    if (PROTECTED.has(fileName)) throw new ValidationError(`${fileName} ist geschützt.`);
    if (isLink(finalPath)) throw new ValidationError('Symlinks können nicht überschrieben werden.');
    if (exists(finalPath) && fs.statSync(finalPath).isDirectory()) {
      throw new ValidationError('Es existiert bereits ein Ordner mit diesem Namen.');
    }
    if (offset === 0 && exists(finalPath) && !overwrite) {
      const e = new ValidationError('Datei existiert bereits.');
      e.exists = true;
      throw e;
    }
    const key = crypto.createHash('sha1').update(`${fileName}:${total}`).digest('hex').slice(0, 12);
    const part = path.join(dir, `.${fileName.slice(0, 100)}.${key}${PART_SUFFIX}`);
    if (isLink(part)) throw new ValidationError('Ungültige Upload-Datei.');
    const current = offset === 0 ? 0 : exists(part) ? fs.statSync(part).size : 0;
    if (offset !== current) return { done: false, received: current };
    if (offset + data.length > total) throw new ValidationError('Upload ist größer als angekündigt.');
    let flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | O_NOFOLLOW;
    if (offset === 0) flags |= fs.constants.O_TRUNC;
    const fd = fs.openSync(part, flags, 0o644);
    try {
      let written = 0;
      while (written < data.length) written += fs.writeSync(fd, data, written, data.length - written, offset + written);
    } finally {
      fs.closeSync(fd);
    }
    const received = offset + data.length;
    if (received >= total) {
      fs.renameSync(part, finalPath);
      this.chown(finalPath);
      return { done: true, received, path: this.rel(finalPath) };
    }
    return { done: false, received };
  }

  // -------------------------------------------------------------- Download
  openDownload(rel) {
    const p = this.resolve(rel);
    const st = fs.statSync(p);
    if (!st.isFile()) throw new ValidationError('Keine Datei.');
    return { path: p, size: st.size, name: path.basename(p) };
  }

  // ------------------------------------------------------------ ZIP/Entpacken
  extract(relZip, relDest, overwrite) {
    const src = this.resolve(relZip);
    if (!fs.statSync(src).isFile()) throw new ValidationError('Keine Datei.');
    const dest = relDest ? this.resolveDir(relDest) : path.dirname(src);
    let zip;
    try {
      zip = new AdmZip(src);
    } catch (e) {
      throw new ValidationError('Nur ZIP-Archive können entpackt werden.');
    }
    const entries = zip.getEntries();
    const limit = Math.max(this.maxUploadBytes * 10, 1 << 30);
    if (entries.reduce((s, e) => s + (e.header.size || 0), 0) > limit) {
      throw new ValidationError('Entpackter Inhalt ist zu groß.');
    }
    let count = 0;
    for (const e of entries) {
      const name = e.entryName.replace(/\\/g, '/');
      if (name.startsWith('/')) continue;
      let parts;
      try {
        parts = FileManager.cleanParts(name);
      } catch (err) {
        continue; // "../" o. Ä. - Zip-Slip
      }
      if (!parts.length) continue;
      const unixMode = (e.attr >>> 16) & 0o170000;
      if (unixMode === 0o120000) continue; // keine Symlinks aus Archiven
      const dirParts = e.isDirectory ? parts : parts.slice(0, -1);
      let dir = dest;
      let ok = true;
      for (const sub of dirParts) {
        dir = path.join(dir, sub);
        if (isLink(dir) || (exists(dir) && !fs.statSync(dir).isDirectory())) {
          ok = false;
          break;
        }
        if (!exists(dir)) {
          fs.mkdirSync(dir, 0o755);
          this.chown(dir);
        }
      }
      if (!ok || e.isDirectory) continue;
      if (!this.inside(fs.realpathSync(dir))) continue;
      const target = path.join(dir, parts[parts.length - 1]);
      if (exists(target)) {
        if (!overwrite || isLink(target) || fs.statSync(target).isDirectory() || PROTECTED.has(path.basename(target))) continue;
      }
      this.writeBytes(target, e.getData());
      count++;
    }
    return count;
  }

  compress(rels, relDir, name) {
    let n = FileManager.checkName(name || 'archiv.zip');
    if (!/\.zip$/i.test(n)) n += '.zip';
    const out = this.target(relDir, n);
    if (exists(out)) throw new ValidationError('Archiv existiert bereits.');
    const zip = new AdmZip();
    let total = 0;
    const add = (p, zipPath) => {
      if (isLink(p) || p.endsWith(PART_SUFFIX)) return;
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        for (const c of fs.readdirSync(p)) add(path.join(p, c), zipPath + '/' + c);
      } else if (st.isFile()) {
        total += st.size;
        if (total > this.maxUploadBytes) throw new ValidationError('Zu viele Daten für ein ZIP im Portal.');
        zip.addFile(zipPath, fs.readFileSync(p), '', 0o644 << 16);
      }
    };
    for (const rel of rels) {
      const src = this.entry(rel);
      add(src, path.basename(src));
    }
    this.writeBytes(out, zip.toBuffer());
    return this.rel(out);
  }
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (e) {
    return false;
  }
}

module.exports = { FileManager, MAX_EDIT_BYTES, PART_SUFFIX };
