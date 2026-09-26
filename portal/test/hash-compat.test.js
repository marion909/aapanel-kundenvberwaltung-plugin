'use strict';
// Kritischster Test in diesem Umbau: Passwörter werden ausschließlich über
// das (weiterhin Python-basierte) Admin-Plugin gesetzt. Das Node-Portal muss
// von cm_store.py erzeugte Hashes verifizieren können, sonst kann sich nie
// jemand einloggen. Fixture wurde real mit `python3 -c "import cm_store; ..."`
// erzeugt (siehe Kommentar), nicht von Hand konstruiert.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../lib/store');

const PYTHON_PASSWORD = 'KundenPasswort!2026';
const PYTHON_HASH = 'pbkdf2_sha256$600000$97zLoqrTJJ2d70LyteoRow==$WIWf7Fbpl2pceIcvbtV+WJdO+t9tUVFhGJUH13tR2B0=';

test('Node verifiziert einen von Python (cm_store.hash_password) erzeugten Hash', () => {
  assert.equal(verifyPassword(PYTHON_PASSWORD, PYTHON_HASH), true);
});

test('Node lehnt ein falsches Passwort gegen den Python-Hash ab', () => {
  assert.equal(verifyPassword('falsches-passwort', PYTHON_HASH), false);
});

test('Node-eigener Hash lässt sich selbst wieder verifizieren (Rundreise)', () => {
  const h = hashPassword('ein anderes Passwort 123');
  assert.equal(verifyPassword('ein anderes Passwort 123', h), true);
  assert.equal(verifyPassword('falsch', h), false);
});

test('verifyPassword wirft nie, auch bei kaputten/leeren Werten', () => {
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', null), false);
  assert.equal(verifyPassword('x', undefined), false);
  assert.equal(verifyPassword('x', 'not-a-valid-hash'), false);
  assert.equal(verifyPassword('x', 'pbkdf2_sha256$abc$def'), false);
});
