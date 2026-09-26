(function () {
  'use strict';

  // Mobiles Menü auf- und zuklappen
  var toggle = document.querySelector('.menu-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var side = toggle.closest('.side');
      var open = side.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function checked(form) {
    return Array.prototype.slice.call(form.querySelectorAll('input[name="paths"]:checked'));
  }

  function field(form, name) {
    // form.target/form.action sind DOM-Eigenschaften - Felder deshalb über elements holen
    return form.elements.namedItem(name);
  }

  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    var btn = ev.submitter || form.querySelector('button[type="submit"]');
    var msg = form.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) {
      ev.preventDefault();
      return;
    }

    // Dateimanager: Aktionen mit Auswahl/Eingabe
    if (form.id === 'fm-form' && btn) {
      var target = btn.getAttribute('data-target') || '';
      if (field(form, 'target')) field(form, 'target').value = target;
      if (field(form, 'overwrite')) field(form, 'overwrite').value = '';
      if (btn.hasAttribute('data-need-selection') && !target && !checked(form).length) {
        ev.preventDefault();
        window.alert('Bitte zuerst Dateien oder Ordner auswählen.');
        return;
      }
      var cs = btn.getAttribute('data-confirm-selection');
      if (cs && !window.confirm(cs + ' (' + checked(form).length + ')')) {
        ev.preventDefault();
        return;
      }
      if (btn.hasAttribute('data-confirm-extract')) {
        field(form, 'overwrite').value = window.confirm('Bereits vorhandene Dateien beim Entpacken überschreiben?\n\nOK = überschreiben, Abbrechen = vorhandene behalten') ? '1' : '';
      }
      var p = btn.getAttribute('data-prompt');
      if (p) {
        var val = window.prompt(p, btn.getAttribute('data-default') || '');
        if (val === null || val.trim() === '') {
          ev.preventDefault();
          return;
        }
        field(form, 'arg').value = val.trim();
      } else if (field(form, 'arg')) {
        field(form, 'arg').value = '';
      }
    }

    var busy = form.getAttribute('data-busy');
    if (busy) showBusy(busy);
    if (btn) {
      // erst nach dem Absenden deaktivieren, sonst fehlt der Button-Wert
      setTimeout(function () { btn.disabled = true; }, 0);
    }
  });

  function showBusy(text) {
    var el = document.createElement('div');
    el.className = 'busy';
    el.textContent = text;
    document.body.appendChild(el);
  }

  // Alle auswählen
  var all = document.getElementById('fm-all');
  if (all) {
    all.addEventListener('change', function () {
      document.querySelectorAll('#fm-form input[name="paths"]').forEach(function (c) { c.checked = all.checked; });
    });
  }

  // Editor: Strg/Cmd+S speichert, Tab rückt ein
  var editor = document.querySelector('textarea.editor');
  if (editor) {
    editor.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
        ev.preventDefault();
        editor.form.requestSubmit();
      } else if (ev.key === 'Tab' && !ev.shiftKey) {
        ev.preventDefault();
        var s = editor.selectionStart;
        editor.setRangeText('\t', s, editor.selectionEnd, 'end');
      }
    });
  }

  // ------------------------------------------------------------ Upload
  var fm = document.getElementById('fm');
  if (!fm) return;
  var url = fm.getAttribute('data-upload-url');
  var dir = fm.getAttribute('data-dir');
  var csrf = fm.getAttribute('data-csrf');
  var maxBytes = Number(fm.getAttribute('data-max-mb')) * 1024 * 1024;
  var CHUNK = 4 * 1024 * 1024;
  var list = document.getElementById('fm-uploads');
  var queue = [];
  var running = false;
  var failed = 0;

  function row(name) {
    var el = document.createElement('div');
    el.className = 'upload-item';
    var n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    var bar = document.createElement('span');
    bar.className = 'bar';
    var fill = document.createElement('span');
    bar.appendChild(fill);
    var st = document.createElement('span');
    st.className = 'st';
    st.textContent = 'wartet';
    el.appendChild(n);
    el.appendChild(bar);
    el.appendChild(st);
    list.appendChild(el);
    return {
      set: function (pct, text) {
        fill.style.width = pct + '%';
        st.textContent = text;
      },
      fail: function (text) {
        el.classList.add('failed');
        st.textContent = text;
      },
    };
  }

  function send(file, name, offset, overwrite) {
    var qs = new URLSearchParams({ dir: dir, name: name, offset: String(offset), total: String(file.size), overwrite: overwrite ? '1' : '' });
    return fetch(url + '?' + qs.toString(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' },
      body: file.slice(offset, Math.min(offset + CHUNK, file.size)),
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, msg: 'HTTP ' + res.status }; }).then(function (j) {
        j.status = res.status;
        return j;
      });
    });
  }

  async function upload(item) {
    var file = item.file;
    var ui = item.ui;
    if (file.size > maxBytes) {
      ui.fail('zu groß');
      failed++;
      return;
    }
    var offset = 0;
    var overwrite = false;
    for (var tries = 0; tries < 10000; tries++) {
      var r;
      try {
        r = await send(file, item.name, offset, overwrite);
      } catch (e) {
        ui.fail('Netzwerkfehler');
        failed++;
        return;
      }
      if (r.status === 409 && r.exists) {
        if (!window.confirm('„' + item.name + '“ existiert bereits. Überschreiben?')) {
          ui.set(0, 'übersprungen');
          return;
        }
        overwrite = true;
        offset = 0;
        continue;
      }
      if (!r.ok) {
        ui.fail(r.msg || 'Fehler');
        failed++;
        return;
      }
      offset = r.received;
      var pct = file.size ? Math.round((offset / file.size) * 100) : 100;
      ui.set(pct, r.done ? 'fertig' : pct + ' %');
      if (r.done) return;
    }
  }

  async function run() {
    if (running) return;
    running = true;
    while (queue.length) await upload(queue.shift());
    running = false;
    if (!failed) {
      window.location.reload();
    } else {
      var again = document.createElement('p');
      again.className = 'hint';
      again.textContent = 'Einige Dateien konnten nicht hochgeladen werden. ';
      var a = document.createElement('a');
      a.href = window.location.href;
      a.textContent = 'Ansicht aktualisieren';
      again.appendChild(a);
      list.appendChild(again);
    }
  }

  function enqueue(file, name) {
    queue.push({ file: file, name: name, ui: row(name) });
  }

  function onInput(input) {
    input.addEventListener('change', function () {
      Array.prototype.forEach.call(input.files, function (f) {
        enqueue(f, f.webkitRelativePath || f.name);
      });
      input.value = '';
      run();
    });
  }
  onInput(document.getElementById('fm-upload'));
  onInput(document.getElementById('fm-upload-dir'));

  // Drag & Drop inkl. Ordnern
  var drop = document.getElementById('fm-drop');
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (ev) {
      ev.preventDefault();
      drop.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (ev) {
      ev.preventDefault();
      if (t === 'dragleave' && drop.contains(ev.relatedTarget)) return;
      drop.classList.remove('over');
    });
  });

  function walk(entry, prefix) {
    return new Promise(function (resolve) {
      if (entry.isFile) {
        entry.file(function (f) {
          enqueue(f, prefix + f.name);
          resolve();
        }, function () { resolve(); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        (function more() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              Promise.all(all.map(function (e) { return walk(e, prefix + entry.name + '/'); })).then(resolve);
              return;
            }
            all = all.concat(Array.prototype.slice.call(batch));
            more();
          }, function () { resolve(); });
        })();
      } else {
        resolve();
      }
    });
  }

  drop.addEventListener('drop', function (ev) {
    var items = ev.dataTransfer && ev.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      var entries = Array.prototype.map.call(items, function (i) { return i.webkitGetAsEntry(); }).filter(Boolean);
      Promise.all(entries.map(function (e) { return walk(e, ''); })).then(run);
    } else if (ev.dataTransfer) {
      Array.prototype.forEach.call(ev.dataTransfer.files, function (f) { enqueue(f, f.name); });
      run();
    }
  });
})();
