(function () {
  'use strict';

  // ---------- Grundlagen ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TYPE_LABEL = { site: 'Website', mail_domain: 'Mail-Domain', mailbox: 'Postfach', domain: 'Domain-Bereich', ftp: 'FTP-Zugang' };

  async function api(fun, params = {}) {
    const body = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) =>
      body.append(k, typeof v === 'object' ? JSON.stringify(v) : v));
    let res;
    try {
      res = await fetch('/customer_mgr/' + fun + '.json', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-http-token': window.CM_TOKEN || '' },
        body
      });
    } catch (e) {
      throw new Error('Panel nicht erreichbar: ' + e.message);
    }
    let json;
    try { json = await res.json(); } catch (e) {
      throw new Error('Unerwartete Antwort vom Panel (HTTP ' + res.status + '). Sitzung abgelaufen? Seite neu laden.');
    }
    if (json && json.status === false) throw new Error(json.msg || 'Fehler');
    return json;
  }

  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, bad ? 6000 : 3000);
  }

  const fmtTime = (ts) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString('de-AT') + ' ' + d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });
  };
  const custName = (c) => c.company || [c.first_name, c.last_name].filter(Boolean).join(' ') || '(ohne Namen)';
  const domainOf = (type, name, info) => {
    if (type === 'mailbox') return name.split('@').pop();
    // FTP-Konten gehören zur Website, in deren Verzeichnis sie liegen
    if (type === 'ftp') return info && info.site ? info.site.replace(/^www\./, '') : 'FTP (ohne Website)';
    if (type === 'site') return name.replace(/^www\./, '');
    return name;
  };

  // ---------- Ansichten ----------
  const state = { customers: [], current: null, detail: null, tab: 'resources', resources: null };

  $$('.views button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  function showView(v) {
    $$('.views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    $$('.view').forEach((s) => { s.hidden = s.id !== 'view-' + v; });
    if (v === 'resources') loadResources(false);
    if (v === 'settings') { loadSettings(); loadMonitor(); }
    if (v === 'packages') loadPackages();
  }

  $$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ---------- Kundenliste ----------
  let searchTimer;
  $('#q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCustomers, 250);
  });

  async function loadCustomers() {
    try {
      const r = await api('get_customers', { search: $('#q').value.trim() });
      state.customers = r.data || [];
      renderCustomers();
    } catch (e) { toast(e.message, true); }
  }

  function renderCustomers() {
    const ul = $('#customer-list');
    if (!state.customers.length) {
      ul.innerHTML = '<li class="none">' + ($('#q').value ? 'Keine Treffer.' : 'Noch keine Kunden angelegt.') + '</li>';
      return;
    }
    ul.innerHTML = state.customers.map((c) => `
      <li class="${c.status === 'inactive' ? 'off' : ''}">
        <button type="button" data-id="${c.id}" class="${state.current === c.id ? 'on' : ''}">
          <span class="n">${esc(custName(c))}</span>
          <span class="sub"><span>${esc(c.customer_no)}${c.package_name ? ' · ' + esc(c.package_name) : ''}</span>
            <span>${c.sites} Web · ${c.mail_domains} Mail · ${c.mailboxes} Postf.</span></span>
        </button>
      </li>`).join('');
    $$('button', ul).forEach((b) => b.addEventListener('click', () => openCustomer(+b.dataset.id)));
  }

  // ---------- Kundendetail ----------
  async function openCustomer(id, keepTab) {
    state.current = id;
    if (!keepTab) state.tab = 'resources';
    renderCustomers();
    $('#detail').innerHTML = '<div class="loading">Lade Kunde …</div>';
    try {
      const r = await api('get_customer', { id });
      state.detail = r.data;
      renderDetail();
    } catch (e) {
      $('#detail').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    }
  }

  function renderDetail() {
    const { customer: c, assignments, log, warning, package: pinfo } = state.detail;
    const tab = state.tab;
    $('#detail').innerHTML = `
      <div class="chead">
        <div>
          <h2>${esc(custName(c))}<span class="badge ${c.status}">${c.status === 'active' ? 'Aktiv' : 'Inaktiv'}</span>${pinfo && pinfo.package ? '<span class="badge pkg">' + esc(pinfo.package.name) + '</span>' : ''}</h2>
          <div class="no">${esc(c.customer_no)}${c.email ? ' · ' + esc(c.email) : ''}</div>
        </div>
        <div class="btns">
          <button type="button" class="primary" id="btn-assign">Ressourcen zuordnen</button>
          <button type="button" id="btn-domain">Domain-Bereich</button>
          <button type="button" id="btn-edit">Bearbeiten</button>
        </div>
      </div>
      <div class="tabs" role="tablist">
        <button type="button" data-tab="resources" class="${tab === 'resources' ? 'on' : ''}">Ressourcen (${assignments.length})</button>
        <button type="button" data-tab="data" class="${tab === 'data' ? 'on' : ''}">Stammdaten</button>
        <button type="button" data-tab="log" class="${tab === 'log' ? 'on' : ''}">Verlauf</button>
      </div>
      <div id="tab-body"></div>`;
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; renderDetail(); }));
    $('#btn-edit').addEventListener('click', () => openCustomerForm(c));
    $('#btn-assign').addEventListener('click', openAssign);
    $('#btn-domain').addEventListener('click', openDomainDialog);

    const body = $('#tab-body');
    if (tab === 'resources') {
      let html = warning ? `<div class="warn">Live-Status nicht verfügbar: ${esc(warning)}</div>` : '';
      html += usageHtml(pinfo);
      if (!assignments.length) {
        html += '<div class="empty"><p>Diesem Kunden sind noch keine Websites, Mail-Domains oder Postfächer zugeordnet.</p></div>';
      } else {
        const groups = {};
        assignments.forEach((a) => {
          const d = domainOf(a.type, a.ref_name, a.info);
          (groups[d] = groups[d] || []).push(a);
        });
        html += '<div class="domains">' + Object.keys(groups).sort().map((d) => domainCard(d, groups[d], 'customer')).join('') + '</div>';
      }
      body.innerHTML = html;
      $$('.chip .x', body).forEach((x) => x.addEventListener('click', () => unassign(+x.dataset.id, x.dataset.name)));
    } else if (tab === 'data') {
      const f = (label, v, cls) => `<div class="${cls || ''}"><dt>${label}</dt><dd class="${cls === 'wide' ? 'pre' : ''}">${esc(v) || '–'}</dd></div>`;
      body.innerHTML = `<div class="panel"><dl class="facts">
        ${f('Firma', c.company)}${f('Name', [c.first_name, c.last_name].filter(Boolean).join(' '))}
        ${f('E-Mail', c.email)}${f('Telefon', c.phone)}
        ${f('Adresse', [c.street, [c.zip, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', '))}
        ${f('UID-Nummer', c.vat_id)}${f('Kundennummer', c.customer_no)}
        ${f('Hosting-Paket', pinfo && pinfo.package ? pinfo.package.name : 'kein Paket')}
        ${f('Max. Websites', c.max_sites === -1 || c.max_sites == null ? 'laut Paket' : (c.max_sites === 0 ? 'unbegrenzt' : c.max_sites))}
        ${f('Angelegt', c.created_at ? fmtTime(c.created_at) : '')}
        ${f('Notiz', c.note, 'wide')}
        </dl>
        <div class="actions"><button type="button" class="danger" id="btn-del">Kunde löschen</button></div></div>
        <div class="panel">
        <h3>Kundenportal</h3>
        <p class="hint">Zugang: <strong>${c.portal_enabled ? 'aktiv' : 'inaktiv'}</strong>${c.portal_last_login ? ' · letzte Anmeldung ' + fmtTime(c.portal_last_login) : ''}</p>
        <div class="actions">
          <button type="button" id="btn-portal-toggle">${c.portal_enabled ? 'Portal-Zugang deaktivieren' : 'Portal-Zugang aktivieren'}</button>
          <button type="button" id="btn-portal-pw">Passwort setzen/zurücksetzen</button>
        </div></div>`;
      $('#btn-del').addEventListener('click', () => deleteCustomer(c));
      $('#btn-portal-toggle').addEventListener('click', () => togglePortalAccess(c));
      $('#btn-portal-pw').addEventListener('click', () => openPortalPasswordDialog(c));
    } else {
      const labels = { customer_add: 'Angelegt', customer_edit: 'Bearbeitet', assign: 'Zugeordnet', unassign: 'Zuordnung gelöst', customer_delete: 'Gelöscht' };
      body.innerHTML = '<div class="panel">' + (log.length ? '<ul class="log">' + log.map((l) => {
        let d = l.detail || '';
        try { const j = JSON.parse(d); if (Array.isArray(j)) d = j.map((x) => x.ref_name).join(', '); } catch (e) { /* Klartext */ }
        return `<li><time>${fmtTime(l.ts)}</time><span>${esc(labels[l.action] || l.action)}</span><span class="d">${esc(d)}</span></li>`;
      }).join('') + '</ul>' : '<p class="hint">Noch keine Einträge.</p>') + '</div>';
    }
  }

  // Eine Domain mit ihren Ressourcen, nach Art getrennt
  function domainCard(domain, items, mode, owners) {
    const lanes = [['domain', 'Bereich'], ['site', 'Web'], ['mail_domain', 'Mail'], ['mailbox', 'Postfächer'], ['ftp', 'FTP']];
    const lanesHtml = lanes.map(([t, label]) => {
      const list = items.filter((i) => i.type === t);
      if (!list.length) return '';
      return `<div class="lane"><span class="k">${label}</span><span class="chips">${list.map((i) => chip(i, mode)).join('')}</span></div>`;
    }).join('');
    let right = '';
    if (mode === 'overview') {
      const own = Object.values(owners || {});
      right = `<div class="owner">${own.length === 0 ? '<span class="free">nicht zugeordnet</span>'
        : own.map((o) => `<a href="#" data-cid="${o.customer_id}">${esc(o.label)}</a>`).join('<br>')}</div>`;
    }
    const head = mode === 'pick'
      ? `<label class="dn check"><input type="checkbox" data-domain="${esc(domain)}"> ${esc(domain)}</label>`
      : `<div class="dn">${esc(domain)}</div>`;
    return `<div class="dom" data-group="${esc(domain)}">${head}<div class="lanes">${lanesHtml}</div>${right}</div>`;
  }

  function chip(i, mode) {
    const name = i.ref_name;
    const info = i.info || {};
    let cls = 'chip ' + i.type;
    let extra = '';
    if (i.type === 'site' && info.project_type && info.project_type !== 'PHP') extra = `<span class="t">${esc(info.project_type)}</span>`;
    if (i.type === 'site' && info.status === '0') cls += ' stopped';
    if (i.type === 'ftp' && info.status === '0') cls += ' stopped';
    if (mode === 'customer') {
      let title = TYPE_LABEL[i.type];
      if (i.state === 'missing') { cls += ' missing'; title += ' – im Panel nicht mehr vorhanden'; }
      if (i.type === 'site' && info.status === '0') title += ' – gestoppt';
      return `<span class="${cls}" title="${esc(title)}">${esc(name)}${extra}
        <button type="button" class="x" data-id="${i.id}" data-name="${esc(name)}" aria-label="Zuordnung lösen: ${esc(name)}">×</button></span>`;
    }
    if (mode === 'pick') {
      return `<label class="${cls}"><input type="checkbox" data-type="${i.type}" data-name="${esc(name)}"> ${esc(name)}${extra}</label>`;
    }
    const title = i.owner ? 'Gehört ' + i.owner.label + ' (' + i.owner.customer_no + ')' : 'nicht zugeordnet';
    return `<span class="${cls}${i.owner ? '' : ''}" title="${esc(title)}">${esc(name)}${extra}</span>`;
  }

  async function unassign(id, name) {
    if (!confirm('Zuordnung von „' + name + '“ lösen? Die Ressource selbst bleibt im Panel unverändert.')) return;
    try {
      const r = await api('unassign', { id });
      toast(r.msg);
      openCustomer(state.current, true);
      loadCustomers();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Kunde anlegen/bearbeiten ----------
  $('#btn-new').addEventListener('click', () => openCustomerForm(null));

  async function openCustomerForm(c) {
    const f = $('#customer-form');
    f.reset();
    try { await fetchPackages(); } catch (e) { /* Liste bleibt leer */ }
    f.elements.package_id.innerHTML = '<option value="">– kein Paket –</option>' +
      state.packages.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('#cf-err').textContent = '';
    $('#cf-title').textContent = c ? 'Kunde bearbeiten' : 'Neuer Kunde';
    if (c) Object.keys(c).forEach((k) => { if (f.elements[k]) f.elements[k].value = c[k] == null ? '' : c[k]; });
    else f.elements.id.value = '';
    $('#dlg-customer').showModal();
    f.elements.company.focus();
  }

  $('#cf-save').addEventListener('click', async () => {
    const f = $('#customer-form');
    const data = Object.fromEntries(new FormData(f).entries());
    if (!data.id) delete data.id;
    try {
      const r = await api('save_customer', { payload: data });
      $('#dlg-customer').close();
      toast(r.msg);
      await loadCustomers();
      openCustomer(r.data.id, !!data.id);
    } catch (e) { $('#cf-err').textContent = e.message; }
  });

  async function deleteCustomer(c) {
    if (!confirm('Kunde „' + custName(c) + '“ wirklich löschen?')) return;
    try {
      await api('delete_customer', { id: c.id });
    } catch (e) {
      if (!/Zuordnung/.test(e.message)) return toast(e.message, true);
      if (!confirm(e.message + '\n\nKunde samt Zuordnungen löschen? Websites und Postfächer im Panel bleiben unverändert.')) return;
      try { await api('delete_customer', { id: c.id, force: 1 }); } catch (e2) { return toast(e2.message, true); }
    }
    toast('Kunde gelöscht');
    state.current = null;
    $('#detail').innerHTML = '<div class="empty"><p>Wähle links einen Kunden oder lege einen neuen an.</p></div>';
    loadCustomers();
  }

  // Paket-Limit überschritten -> Admin fragen, ob trotzdem zugeordnet werden soll
  async function withLimitOverride(call) {
    try {
      return await call(false);
    } catch (e) {
      if (!/^Paket-Limit/.test(e.message)) throw e;
      if (!confirm(e.message + '\n\nTrotzdem zuordnen? (Das Limit gilt weiterhin für Aktionen des Kunden im Portal.)')) throw new Error('Abgebrochen');
      return call(true);
    }
  }

  // ---------- Domain-Bereich ----------
  function openDomainDialog() {
    const f = $('#domain-form');
    f.reset();
    $('#df-err').textContent = '';
    $('#dlg-domain').showModal();
    f.elements.domain.focus();
  }

  $('#df-save').addEventListener('click', async () => {
    const f = $('#domain-form');
    try {
      const r = await withLimitOverride((force) => api('assign_domain', { payload: { customer_id: state.current, domain: f.elements.domain.value.trim(), force } }));
      $('#dlg-domain').close();
      toast(r.msg);
      state.tab = 'resources';
      openCustomer(state.current, true);
    } catch (e) { $('#df-err').textContent = e.message; }
  });

  // ---------- Portal-Zugang ----------
  async function togglePortalAccess(c) {
    try {
      const r = await api('set_portal_access', { payload: { id: c.id, enabled: !c.portal_enabled } });
      toast(r.msg);
      openCustomer(state.current, true);
    } catch (e) { toast(e.message, true); }
  }

  function openPortalPasswordDialog(c) {
    const f = $('#portal-password-form');
    f.reset();
    $('#pf-err').textContent = '';
    $('#dlg-portal-password').showModal();
    f.elements.password.focus();
    $('#pf-save').onclick = async () => {
      try {
        const r = await api('set_portal_password', { payload: { id: c.id, password: f.elements.password.value } });
        $('#dlg-portal-password').close();
        toast(r.msg);
        openCustomer(state.current, true);
      } catch (e) { $('#pf-err').textContent = e.message; }
    };
  }

  // ---------- Ressourcen laden ----------
  async function fetchResources(refresh) {
    const r = await api('get_resources', { refresh: refresh ? 1 : 0 });
    state.resources = r.data;
    return r.data;
  }

  function flatten(res) {
    const out = [];
    res.sites.forEach((s) => out.push({ type: 'site', ref_name: s.name, owner: s.owner, info: s }));
    res.mail_domains.forEach((d) => out.push({ type: 'mail_domain', ref_name: d.domain, owner: d.owner, info: d }));
    res.mailboxes.forEach((b) => out.push({ type: 'mailbox', ref_name: b.username, owner: b.owner, info: b }));
    (res.ftps || []).forEach((f) => out.push({ type: 'ftp', ref_name: f.name, owner: f.owner, info: f }));
    return out;
  }

  function groupByDomain(items) {
    const g = {};
    items.forEach((i) => { const d = domainOf(i.type, i.ref_name, i.info); (g[d] = g[d] || []).push(i); });
    return g;
  }

  // ---------- Zuordnen-Dialog ----------
  async function openAssign() {
    const dlg = $('#dlg-assign');
    $('#assign-list').innerHTML = '<div class="loading">Lade Ressourcen aus dem Panel …</div>';
    $('#aq').value = '';
    updateCount();
    dlg.showModal();
    try {
      const res = await fetchResources(false);
      const free = flatten(res).filter((i) => !i.owner);
      const groups = groupByDomain(free);
      const keys = Object.keys(groups).sort();
      let html = res.warnings.length ? '<div class="warn">' + res.warnings.map(esc).join('<br>') + '</div>' : '';
      html += keys.length ? keys.map((d) => domainCard(d, groups[d], 'pick')).join('')
        : '<div class="empty"><p>Alle Ressourcen im Panel sind bereits Kunden zugeordnet.</p></div>';
      $('#assign-list').innerHTML = html;
      $$('#assign-list input[data-domain]').forEach((cb) => cb.addEventListener('change', () => {
        $$('input[data-type]', cb.closest('.dom')).forEach((x) => { x.checked = cb.checked; });
        updateCount();
      }));
      $$('#assign-list input[data-type]').forEach((cb) => cb.addEventListener('change', () => {
        const dom = cb.closest('.dom');
        const all = $$('input[data-type]', dom);
        const head = $('input[data-domain]', dom);
        head.checked = all.every((x) => x.checked);
        head.indeterminate = !head.checked && all.some((x) => x.checked);
        updateCount();
      }));
    } catch (e) {
      $('#assign-list').innerHTML = '<div class="err">' + esc(e.message) + '</div><p class="hint">API-Verbindung unter Einstellungen prüfen.</p>';
    }
  }

  function updateCount() {
    const n = $$('#assign-list input[data-type]:checked').length;
    $('#assign-count').textContent = n + ' ausgewählt';
    $('#assign-save').disabled = n === 0;
  }

  $('#aq').addEventListener('input', () => {
    const q = $('#aq').value.trim().toLowerCase();
    $$('#assign-list .dom').forEach((d) => { d.hidden = q && !d.dataset.group.includes(q) && !d.textContent.toLowerCase().includes(q); });
  });

  $('#assign-save').addEventListener('click', async () => {
    const items = $$('#assign-list input[data-type]:checked').map((x) => ({ type: x.dataset.type, ref_name: x.dataset.name }));
    if (!items.length) return;
    $('#assign-save').disabled = true;
    try {
      const r = await withLimitOverride((force) => api('assign', { payload: { customer_id: state.current, items, force } }));
      $('#dlg-assign').close();
      toast(r.msg);
      state.tab = 'resources';
      openCustomer(state.current, true);
      loadCustomers();
    } catch (e) { toast(e.message, true); updateCount(); }
  });

  // ---------- Pakete ----------
  state.packages = [];
  async function fetchPackages() {
    const r = await api('get_packages');
    state.packages = r.data || [];
    return state.packages;
  }

  const lim = (v) => (Number(v) ? String(v) : '∞');

  function usageHtml(pinfo) {
    if (!pinfo) return '';
    const L = pinfo.limits || {};
    const U = pinfo.usage || {};
    const rows = [['site', 'Websites'], ['domain', 'Domain-Bereiche'], ['mail_domain', 'Mail-Domains'], ['mailbox', 'Postfächer']];
    const items = rows.map(([k, label]) => {
      const max = Number(L[k]) || 0;
      const used = Number(U[k]) || 0;
      const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
      const cls = max && used > max ? 'over' : max && used >= max ? 'full' : '';
      return `<div class="use ${cls}"><span class="k">${label}</span><strong>${used}<small> / ${lim(max)}</small></strong>
        <span class="ubar"><span style="width:${max ? Math.max(pct, used ? 4 : 0) : 0}%"></span></span></div>`;
    }).join('');
    const extra = [];
    if (L.mailbox_quota_mb) extra.push('Postfach-Größe ' + L.mailbox_quota_mb + ' MB');
    if (L.upload_mb) extra.push('Upload bis ' + L.upload_mb + ' MB');
    extra.push(L.ssl === false ? 'SSL: nur durch Admin' : 'SSL: durch Kunden');
    const head = pinfo.package ? 'Paket <strong>' + esc(pinfo.package.name) + '</strong>' : 'Kein Paket zugewiesen – nur das Website-Standardlimit gilt';
    const over = (pinfo.over || []).length ? `<div class="warn">Limits überschritten: ${pinfo.over.map(esc).join('; ')}</div>` : '';
    return `<div class="usage"><div class="usage-head">${head}<span class="meta">${extra.map(esc).join(' · ')}</span></div>
      <div class="usage-grid">${items}</div>${over}</div>`;
  }

  async function loadPackages() {
    const out = $('#package-list');
    out.innerHTML = '<div class="loading">Lade Pakete …</div>';
    try {
      const list = await fetchPackages();
      if (!list.length) {
        out.innerHTML = '<div class="empty"><p>Noch keine Pakete angelegt. Lege z. B. „Starter“, „Business“ und „Pro“ an und weise sie den Kunden unter „Bearbeiten“ zu.</p></div>';
        return;
      }
      out.innerHTML = '<div class="pkg-grid">' + list.map((p) => `
        <div class="pkg-card">
          <div class="pkg-head"><h3>${esc(p.name)}</h3><span class="meta">${p.customers} Kunde${p.customers === 1 ? '' : 'n'}</span></div>
          ${p.description ? '<p class="hint">' + esc(p.description) + '</p>' : ''}
          <dl class="pkg-limits">
            <dt>Websites</dt><dd>${lim(p.max_sites)}</dd>
            <dt>Domain-Bereiche</dt><dd>${lim(p.max_domains)}</dd>
            <dt>Mail-Domains</dt><dd>${lim(p.max_mail_domains)}</dd>
            <dt>Postfächer</dt><dd>${lim(p.max_mailboxes)}</dd>
            <dt>Postfach-Größe</dt><dd>${p.mailbox_quota_mb ? p.mailbox_quota_mb + ' MB' : 'Standard'}</dd>
            <dt>Upload pro Datei</dt><dd>${p.max_upload_mb ? p.max_upload_mb + ' MB' : 'Standard'}</dd>
            <dt>SSL durch Kunden</dt><dd>${p.ssl_allowed ? 'ja' : 'nein'}</dd>
            <dt>FTP-Zugänge</dt><dd>${p.ftp_allowed ? lim(p.max_ftp) : 'nein'}</dd>
          </dl>
          <div class="actions"><button type="button" data-edit="${p.id}">Bearbeiten</button>
            <button type="button" class="danger" data-del="${p.id}">Löschen</button></div>
        </div>`).join('') + '</div>';
      $$('button[data-edit]', out).forEach((b) => b.addEventListener('click', () =>
        openPackageForm(state.packages.find((p) => p.id === +b.dataset.edit))));
      $$('button[data-del]', out).forEach((b) => b.addEventListener('click', async () => {
        const p = state.packages.find((x) => x.id === +b.dataset.del);
        if (!confirm('Paket „' + p.name + '“ löschen?')) return;
        try { const r = await api('delete_package', { id: p.id }); toast(r.msg); loadPackages(); }
        catch (e) { toast(e.message, true); }
      }));
    } catch (e) { out.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
  }

  function openPackageForm(p) {
    const f = $('#package-form');
    f.reset();
    $('#pk-err').textContent = '';
    $('#pk-title').textContent = p ? 'Paket bearbeiten' : 'Neues Paket';
    f.elements.id.value = p ? p.id : '';
    if (p) {
      ['name', 'description', 'max_sites', 'max_domains', 'max_mail_domains', 'max_mailboxes', 'mailbox_quota_mb', 'max_upload_mb', 'max_ftp']
        .forEach((k) => { f.elements[k].value = p[k] == null ? '' : p[k]; });
      f.elements.ssl_allowed.checked = !!p.ssl_allowed;
      f.elements.ftp_allowed.checked = p.ftp_allowed === undefined ? true : !!p.ftp_allowed;
    }
    $('#dlg-package').showModal();
    f.elements.name.focus();
  }

  $('#btn-new-package').addEventListener('click', () => openPackageForm(null));
  $('#pk-save').addEventListener('click', async () => {
    const f = $('#package-form');
    const data = Object.fromEntries(new FormData(f).entries());
    data.ssl_allowed = f.elements.ssl_allowed.checked;
    data.ftp_allowed = f.elements.ftp_allowed.checked;
    if (!data.id) delete data.id;
    try {
      const r = await api('save_package', { payload: data });
      $('#dlg-package').close();
      toast(r.msg);
      loadPackages();
    } catch (e) { $('#pk-err').textContent = e.message; }
  });

  // ---------- Alle Ressourcen ----------
  $('#btn-refresh').addEventListener('click', () => loadResources(true));
  $('#rq').addEventListener('input', renderResources);
  $('#only-free').addEventListener('change', renderResources);

  async function loadResources(refresh) {
    $('#res-list').innerHTML = '<div class="loading">Lade Ressourcen aus dem Panel …</div>';
    $('#res-warn').innerHTML = '';
    try {
      await fetchResources(refresh);
      renderResources();
    } catch (e) {
      $('#res-list').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
    }
  }

  function renderResources() {
    const res = state.resources;
    if (!res) return;
    $('#res-meta').textContent = `Stand ${res.fetched_at} · Websites: ${res.sources.sites} · Mail: ${res.sources.mail}`;
    $('#res-warn').innerHTML = res.warnings.length ? '<div class="warn">' + res.warnings.map(esc).join('<br>') + '</div>' : '';
    const q = $('#rq').value.trim().toLowerCase();
    const onlyFree = $('#only-free').checked;
    let items = flatten(res);
    if (onlyFree) items = items.filter((i) => !i.owner);
    const groups = groupByDomain(items);
    const keys = Object.keys(groups).sort().filter((d) => !q || d.includes(q) || groups[d].some((i) => i.ref_name.includes(q)));
    if (!keys.length) {
      $('#res-list').innerHTML = '<div class="empty"><p>Keine passenden Ressourcen.</p></div>';
      return;
    }
    $('#res-list').innerHTML = keys.map((d) => {
      const owners = {};
      groups[d].forEach((i) => { if (i.owner) owners[i.owner.customer_id] = i.owner; });
      return domainCard(d, groups[d], 'overview', owners);
    }).join('');
    $$('#res-list a[data-cid]').forEach((a) => a.addEventListener('click', (ev) => {
      ev.preventDefault();
      showView('customers');
      openCustomer(+a.dataset.cid);
    }));
  }

  // ---------- Prüfung ----------
  $('#btn-orphans').addEventListener('click', async () => {
    const out = $('#orphan-list');
    out.innerHTML = '<div class="loading">Gleiche Zuordnungen mit dem Panel ab …</div>';
    try {
      const r = await api('get_orphans');
      const rows = r.data || [];
      if (!rows.length) { out.innerHTML = '<div class="empty"><p>Alles in Ordnung: Jede Zuordnung zeigt auf eine existierende Ressource.</p></div>'; return; }
      out.innerHTML = `<table class="orph"><thead><tr><th>Kunde</th><th>Art</th><th>Ressource</th><th></th></tr></thead><tbody>
        ${rows.map((a) => `<tr><td><a href="#" data-cid="${a.customer_id}">${esc(a.customer_label)}</a> <span class="meta">${esc(a.customer_no)}</span></td>
          <td>${TYPE_LABEL[a.type]}</td><td>${esc(a.ref_name)}</td>
          <td><button type="button" class="link" data-id="${a.id}">Zuordnung lösen</button></td></tr>`).join('')}
        </tbody></table>`;
      $$('button[data-id]', out).forEach((b) => b.addEventListener('click', async () => {
        try { await api('unassign', { id: b.dataset.id }); b.closest('tr').remove(); toast('Zuordnung gelöst'); loadCustomers(); }
        catch (e) { toast(e.message, true); }
      }));
      $$('a[data-cid]', out).forEach((a) => a.addEventListener('click', (ev) => {
        ev.preventDefault(); showView('customers'); openCustomer(+a.dataset.cid);
      }));
    } catch (e) { out.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
  });

  // ---------- Einstellungen ----------
  async function loadSettings() {
    try {
      const r = await api('get_settings');
      const s = r.data;
      const f = $('#settings-form');
      ['base_url', 'data_path', 'site_project_types', 'mail_plugin_paths', 'mail_domains_method', 'mail_boxes_method',
       'mail_box_create_method', 'mail_box_setpw_method', 'mail_box_delete_method', 'mail_box_default_quota', 'customer_prefix',
       'site_path_template', 'site_api_prefixes', 'cf_email', 'server_ipv4', 'server_ipv6', 'portal_name', 'ftp_host']
        .forEach((k) => { f.elements[k].value = s[k] || ''; });
      ['site_default_max_sites', 'portal_max_upload_mb'].forEach((k) => { f.elements[k].value = s[k] == null ? '' : s[k]; });
      f.elements.cf_proxied.checked = !!s.cf_proxied;
      renderLogo(s.logo_data_url);
      f.elements.cf_api_key.value = '';
      $('#cf-key-hint').textContent = s.cf_api_key_set ? 'Hinterlegt. Nur ausfüllen, um ihn zu ändern.' : 'Kein Key hinterlegt – DNS-Einträge müssen dann manuell gesetzt werden.';
      $('#mailbox-methods-warn').innerHTML = s.mail_box_actions_configured ? '' :
        '<div class="warn">Ohne alle drei Aktionsnamen kann das Kundenportal keine Postfächer anlegen, Passwörter ändern oder löschen.</div>';
      f.elements.mail_db_fallback.checked = !!s.mail_db_fallback;
      f.elements.api_key.value = '';
      $('#key-hint').textContent = s.api_key_set ? 'Hinterlegt (' + s.api_key_hint + '). Nur ausfüllen, um ihn zu ändern.' : 'Noch kein Key hinterlegt.';
      f.elements.base_url.placeholder = s.detected_base_url;
      $('#base-hint').textContent = 'Leer lassen für automatisch: ' + s.detected_base_url;
      const pa = s.panel_api;
      if (!pa.open || !pa.localhost_allowed) {
        $('#test-out').innerHTML = '<div class="warn">' + (!pa.open ? 'Die API ist im Panel nicht aktiviert. ' : '') +
          (!pa.localhost_allowed ? '127.0.0.1 steht nicht in der API-IP-Whitelist.' : '') + '</div>';
      } else { $('#test-out').innerHTML = ''; }
    } catch (e) { toast(e.message, true); }
  }

  $('#settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const data = Object.fromEntries(new FormData(f).entries());
    data.mail_db_fallback = f.elements.mail_db_fallback.checked;
    data.cf_proxied = f.elements.cf_proxied.checked;
    try { const r = await api('save_settings', { payload: data }); toast(r.msg); loadSettings(); }
    catch (e) { toast(e.message, true); }
  });

  // ---------- Logo fürs Kundenportal ----------
  function renderLogo(url) {
    const box = $('#logo-preview');
    box.innerHTML = '';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Logo';
      box.appendChild(img);
    } else {
      box.innerHTML = '<span class="hint">Kein Logo hinterlegt</span>';
    }
    $('#logo-remove').hidden = !url;
  }

  $('#logo-file').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) return toast('Logo ist zu groß (max. 1 MB)', true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await api('save_logo', { payload: { data: reader.result } });
        toast(r.msg);
        renderLogo(reader.result);
      } catch (e) { toast(e.message, true); }
    };
    reader.readAsDataURL(file);
  });

  $('#logo-remove').addEventListener('click', async () => {
    if (!confirm('Logo wirklich entfernen? Im Kundenportal wird dann wieder der Portal-Name angezeigt.')) return;
    try { const r = await api('remove_logo'); toast(r.msg); renderLogo(''); }
    catch (e) { toast(e.message, true); }
  });

  $('#btn-test').addEventListener('click', async () => {
    const out = $('#test-out');
    out.innerHTML = '<div class="loading">Teste Verbindung …</div>';
    try {
      const r = await api('test_connection');
      const d = r.data;
      out.innerHTML = `<ul class="checks">${d.checks.map((c) =>
        `<li class="${c.ok ? 'ok' : 'no'}">${esc(c.label)}${c.detail ? '<small>' + esc(c.detail) + '</small>' : ''}</li>`).join('')}</ul>
        <p class="hint">${esc(d.summary)}</p>
        ${(d.warnings || []).length ? '<div class="warn">' + d.warnings.map(esc).join('<br>') + '</div>' : ''}`;
    } catch (e) { out.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; }
  });

  $('#btn-raw').addEventListener('click', async () => {
    const out = $('#raw-out');
    let params;
    try { params = JSON.parse($('#raw-params').value || '{}'); } catch (e) { out.textContent = 'Parameter sind kein gültiges JSON.'; return; }
    out.textContent = 'Rufe auf …';
    try {
      const r = await api('raw_call', { payload: { path: $('#raw-path').value.trim(), params } });
      out.textContent = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
    } catch (e) { out.textContent = 'Fehler: ' + e.message; }
  });

  // ---------- Mail-Monitoring ----------
  const monForm = $('#monitor-form');
  $$('.mon-acc', monForm).forEach((box) => {
    const a = box.dataset.acc;
    const sec = (n) => `<select name="${a}.${n}"><option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">keine</option></select>`;
    box.innerHTML = `<div class="grid">
      <label>E-Mail-Adresse <input name="${a}.address" type="email"></label>
      <label>Passwort <input name="${a}.password" type="password" placeholder="unverändert lassen" autocomplete="new-password"><small data-secret="${a}.password"></small></label>
      <label>SMTP-Server <input name="${a}.smtp_host"></label>
      <label>SMTP-Verschlüsselung / Port ${sec('smtp_security')}<input name="${a}.smtp_port" type="number" min="1" max="65535" placeholder="Standard (587 / 465)"></label>
      <label>IMAP-Server <input name="${a}.imap_host" placeholder="leer = wie SMTP-Server"></label>
      <label>IMAP-Verschlüsselung / Port ${sec('imap_security')}<input name="${a}.imap_port" type="number" min="1" max="65535" placeholder="Standard (993)"></label>
      <label>Benutzername <input name="${a}.user" placeholder="leer = E-Mail-Adresse"></label>
      <label>Ordner <input name="${a}.folders" placeholder="INBOX"></label>
      ${a === 'external' ? `<label class="wide">Spam-Ordner <input name="${a}.spam_folders" placeholder="z. B. Spamverdacht, Junk, [Gmail]/Spam"><small>Landet die Testmail dort, gibt es eine Warnung (Reputation, SPF/DKIM prüfen).</small></label>` : ''}
    </div>`;
  });

  const MON_ICON = { ok: 'ok', warn: 'wn', fail: 'no' };
  let monPoll = null;

  function renderMonitorStatus(st, enabled) {
    const box = $('#mon-status');
    let html = '';
    if (!st.script_exists) html += '<div class="err">Prüfskript <code>mail_monitor/mail_monitor.py</code> fehlt im Plugin-Ordner – Plugin neu installieren.</div>';
    if (enabled && st.stale) html += '<div class="warn">Die letzte Prüfung ist schon länger her – läuft der Cron-Dienst? (<code>systemctl status cron</code>)</div>';
    if (st.legacy_ini) html += '<div class="warn">Es gibt noch eine alte Konfiguration <code>/etc/mail_monitor.ini</code>. Nach dem Speichern hier einen selbst angelegten Cron-Job für <code>mail_monitor.py</code> (z. B. in aaPanel → Cron) löschen, sonst wird doppelt geprüft.</div>';
    if (st.running) {
      html += '<div class="mon-box"><strong>Prüfung läuft …</strong> <span class="hint">Warte auf die Testmails.</span></div>';
    } else if (st.last_run) {
      const cls = { ok: 'ok', warn: 'warn-s', fail: 'fail' }[st.last_status] || '';
      const word = { ok: 'Alles in Ordnung', warn: 'Warnung', fail: 'Störung' }[st.last_status] || st.last_status;
      html += `<div class="mon-box ${cls}"><strong>${esc(word)}</strong> <span class="hint">– letzte Prüfung ${esc(fmtTime(st.last_run))}${st.failures > 1 ? ', ' + st.failures + '× in Folge' : ''}${st.alerted ? ', Discord benachrichtigt' : ''}</span>
        <ul class="checks">${st.results.map((r) => `<li class="${MON_ICON[r.status] || 'no'}"><span><strong>${esc(r.name)}</strong> – ${esc(r.message)}</span></li>`).join('')}</ul></div>`;
    } else if (enabled) {
      html += '<div class="mon-box"><span class="hint">Noch keine Prüfung gelaufen.</span></div>';
    }
    box.innerHTML = html;
    $('#mon-log').textContent = st.log || '';
    $('#mon-log-box').hidden = !st.log;
  }

  async function loadMonitor() {
    try {
      const d = (await api('get_monitor')).data;
      Object.entries(d.values).forEach(([k, v]) => {
        const el = monForm.elements[k];
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
      });
      Object.entries(d.secrets).forEach(([k, set]) => {
        const el = monForm.elements[k];
        if (el) el.value = '';
        const hint = monForm.querySelector(`[data-secret="${k}"]`);
        if (hint) hint.textContent = set ? 'Hinterlegt. Nur ausfüllen, um es zu ändern.' : '';
      });
      $('#mon-webhook-hint').textContent = d.secrets['discord.webhook_url']
        ? 'Hinterlegt. Nur ausfüllen, um die URL zu ändern.'
        : 'Discord: Kanal bearbeiten → Integrationen → Webhooks → Neuer Webhook → URL kopieren.';
      renderMonitorStatus(d.status, d.values['admin.enabled']);
      if (d.legacy_import) toast('Werte aus /etc/mail_monitor.ini übernommen – bitte prüfen und speichern');
    } catch (e) { toast(e.message, true); }
  }

  function monitorPayload() {
    const data = Object.fromEntries(new FormData(monForm).entries());
    $$('input[type=checkbox]', monForm).forEach((c) => { data[c.name] = c.checked; });
    return data;
  }

  monForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try { const r = await api('save_monitor', { payload: monitorPayload() }); toast(r.msg); loadMonitor(); }
    catch (e) { toast(e.message, true); }
  });

  $('#mon-webhook').addEventListener('click', async (ev) => {
    const b = ev.target;
    b.disabled = true;
    try { const r = await api('monitor_test_webhook'); toast(r.msg); }
    catch (e) { toast(e.message, true); }
    finally { b.disabled = false; }
  });

  $('#mon-run').addEventListener('click', async (ev) => {
    const b = ev.target;
    b.disabled = true;
    let before = null;
    try {
      before = (await api('monitor_status')).data.last_run;
      const r = await api('monitor_run');
      toast(r.msg);
    } catch (e) { toast(e.message, true); b.disabled = false; return; }
    const started = Date.now();
    clearInterval(monPoll);
    monPoll = setInterval(async () => {
      try {
        const st = (await api('monitor_status')).data;
        const done = st.last_run && st.last_run !== before && !st.running;
        renderMonitorStatus(done || Date.now() - started > 3000 ? st : Object.assign({}, st, { running: true }),
          monForm.elements['admin.enabled'].checked);
        if (done || Date.now() - started > 16 * 60 * 1000 || (!st.running && Date.now() - started > 15000 && st.log && /Konfigurationsfehler|Traceback/.test(st.log))) {
          clearInterval(monPoll);
          b.disabled = false;
          if (done) toast('Prüfung abgeschlossen', st.last_status === 'fail');
        }
      } catch (e) { clearInterval(monPoll); b.disabled = false; toast(e.message, true); }
    }, 4000);
  });

  // ---------- Start ----------
  loadCustomers();
})();
