'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { FileManager } = require('../lib/files');
const { ValidationError } = require('../lib/validate');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-files-'));
  const root = path.join(base, 'site');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'geheim');
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(root, '.user.ini'), 'open_basedir=...');
  fs.mkdirSync(path.join(root, 'sub'));
  return { base, root, outside, fm: new FileManager(root, 10 * 1024 * 1024) };
}

test('Liste enthält Dateien, Ordner zuerst, .user.ini als geschützt markiert', () => {
  const { fm, base } = setup();
  const l = fm.list('/');
  assert.equal(l.path, '/');
  assert.equal(l.entries[0].name, 'sub');
  assert.ok(l.entries.find((e) => e.name === '.user.ini').protected);
  fs.rmSync(base, { recursive: true });
});

test('Pfade mit .. und absolute Ausbrüche werden abgelehnt', () => {
  const { fm, base } = setup();
  assert.throws(() => fm.list('../outside'), ValidationError);
  assert.throws(() => fm.readText('/../outside/secret.txt'), ValidationError);
  assert.throws(() => fm.delete(['sub/../../outside/secret.txt']), ValidationError);
  // absoluter Pfad wird relativ zur Website interpretiert, nicht zum System-Root
  assert.throws(() => fm.readText('/etc/passwd'), /nicht gefunden/);
  fs.rmSync(base, { recursive: true });
});

test('Symlink nach außen: Lesen, Auflisten und Hochladen hinein werden verweigert', () => {
  const { fm, base, root, outside } = setup();
  fs.symlinkSync(outside, path.join(root, 'evil'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'secret-link.txt'));
  assert.throws(() => fm.list('/evil'), /Zugriff verweigert/);
  assert.throws(() => fm.readText('/secret-link.txt'), /Zugriff verweigert/);
  assert.throws(() => fm.uploadChunk('/evil', 'x.txt', 0, 1, Buffer.from('x')), /Zugriff verweigert/);
  assert.throws(() => fm.uploadChunk('/', 'secret-link.txt', 0, 1, Buffer.from('x'), true), /Symlink/);
  // Löschen des Links selbst ist erlaubt und lässt das Ziel unangetastet
  fm.delete(['/evil']);
  assert.ok(fs.existsSync(path.join(outside, 'secret.txt')));
  fs.rmSync(base, { recursive: true });
});

test('Upload in Stücken inkl. Fortsetzen und Überschreib-Schutz', () => {
  const { fm, base, root } = setup();
  const data = Buffer.from('0123456789abcdef');
  let r = fm.uploadChunk('/sub', 'a.bin', 0, data.length, data.subarray(0, 6));
  assert.deepEqual(r, { done: false, received: 6 });
  // falscher Offset -> Server meldet aktuellen Stand
  r = fm.uploadChunk('/sub', 'a.bin', 10, data.length, data.subarray(10));
  assert.deepEqual(r, { done: false, received: 6 });
  r = fm.uploadChunk('/sub', 'a.bin', 6, data.length, data.subarray(6));
  assert.equal(r.done, true);
  assert.equal(r.path, '/sub/a.bin');
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'a.bin')).toString(), data.toString());
  // keine Teil-Dateien übrig
  assert.deepEqual(fs.readdirSync(path.join(root, 'sub')), ['a.bin']);
  // existiert -> Fehler mit exists-Flag, mit overwrite ok
  assert.throws(() => fm.uploadChunk('/sub', 'a.bin', 0, 1, Buffer.from('x')), (e) => e.exists === true);
  assert.equal(fm.uploadChunk('/sub', 'a.bin', 0, 1, Buffer.from('x'), true).done, true);
  fs.rmSync(base, { recursive: true });
});

test('Ordner-Upload legt Unterordner an, geschützte Namen und Übergröße werden abgelehnt', () => {
  const { base, root } = setup();
  const fm = new FileManager(root, 10);
  assert.equal(fm.uploadChunk('/', 'neu/css/app.css', 0, 3, Buffer.from('a{}')).done, true);
  assert.ok(fs.existsSync(path.join(root, 'neu', 'css', 'app.css')));
  assert.throws(() => fm.uploadChunk('/', '.user.ini', 0, 1, Buffer.from('x'), true), /geschützt/);
  assert.throws(() => fm.uploadChunk('/', 'big.bin', 0, 11, Buffer.alloc(11)), /zu groß/);
  assert.throws(() => fm.uploadChunk('/', '../x.txt', 0, 1, Buffer.from('x')), ValidationError);
  fs.rmSync(base, { recursive: true });
});

test('Bearbeiten, Anlegen, Umbenennen, Verschieben, Kopieren, Rechte, Löschen', () => {
  const { fm, base, root } = setup();
  assert.equal(fm.readText('/index.html').content, '<h1>hi</h1>');
  fm.writeText('/index.html', '<h1>neu</h1>');
  assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), '<h1>neu</h1>');
  fm.mkdir('/', 'img');
  fm.createFile('/img', 'a.txt');
  fm.rename('/img/a.txt', 'b.txt');
  fm.move(['/img/b.txt'], '/sub');
  assert.ok(fs.existsSync(path.join(root, 'sub', 'b.txt')));
  fm.move(['/sub'], '/img', true);
  assert.ok(fs.existsSync(path.join(root, 'img', 'sub', 'b.txt')));
  assert.throws(() => fm.move(['/img'], '/img/sub'), /in sich selbst/);
  fm.chmod('/index.html', '600');
  assert.equal(fs.statSync(path.join(root, 'index.html')).mode & 0o777, 0o600);
  assert.throws(() => fm.chmod('/index.html', '7777'), ValidationError);
  assert.throws(() => fm.delete(['/.user.ini']), /geschützt/);
  assert.throws(() => fm.delete(['/']), ValidationError);
  assert.throws(() => fm.rename('/index.html', '../x'), ValidationError);
  fm.delete(['/img', '/sub']);
  assert.ok(!fs.existsSync(path.join(root, 'img')));
  fs.rmSync(base, { recursive: true });
});

test('ZIP: Entpacken ignoriert Zip-Slip-Pfade, Packen erzeugt lesbares Archiv', () => {
  const { fm, base, root, outside } = setup();
  const zip = new AdmZip();
  zip.addFile('ok/hello.txt', Buffer.from('hallo'));
  zip.addFile('root.txt', Buffer.from('r'));
  zip.addFile('../../outside/pwned.txt', Buffer.from('böse'));
  // adm-zip normalisiert "../" beim Hinzufügen - Eintragsnamen danach manuell setzen
  zip.getEntries().find((e) => e.entryName.endsWith('pwned.txt')).entryName = '../../outside/pwned.txt';
  fs.writeFileSync(path.join(root, 'upload.zip'), zip.toBuffer());
  const n = fm.extract('/upload.zip', '/sub');
  assert.equal(n, 2);
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'ok', 'hello.txt'), 'utf8'), 'hallo');
  assert.ok(!fs.existsSync(path.join(outside, 'pwned.txt')));
  assert.ok(!fs.existsSync(path.join(base, 'pwned.txt')));
  // ohne overwrite bleiben vorhandene Dateien erhalten
  fs.writeFileSync(path.join(root, 'sub', 'root.txt'), 'lokal');
  fm.extract('/upload.zip', '/sub');
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'root.txt'), 'utf8'), 'lokal');
  fm.extract('/upload.zip', '/sub', true);
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'root.txt'), 'utf8'), 'r');

  const out = fm.compress(['/sub'], '/', 'backup');
  assert.equal(out, '/backup.zip');
  const names = new AdmZip(path.join(root, 'backup.zip')).getEntries().map((e) => e.entryName).sort();
  assert.deepEqual(names, ['sub/ok/hello.txt', 'sub/root.txt']);
  fs.rmSync(base, { recursive: true });
});

test('ZIP: Symlinks aus Archiven werden nicht angelegt', () => {
  const { fm, base, root } = setup();
  const zip = new AdmZip();
  zip.addFile('link', Buffer.from('/etc'));
  zip.getEntries()[0].attr = (0o120777 << 16) >>> 0;
  zip.addFile('link/passwd', Buffer.from('x'));
  fs.writeFileSync(path.join(root, 'l.zip'), zip.toBuffer());
  fm.extract('/l.zip', '/sub');
  assert.ok(!fs.lstatSync(path.join(root, 'sub', 'link')).isSymbolicLink());
  fs.rmSync(base, { recursive: true });
});
