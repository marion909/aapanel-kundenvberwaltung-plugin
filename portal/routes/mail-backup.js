'use strict';
// Postfach-Sicherungen im Kundenportal: anlegen, herunterladen, wiederherstellen, löschen.
const fs = require('fs');
const { ValidationError } = require('../lib/validate');
const { fmtBytes } = require('../lib/stats');

module.exports = function registerMailBackupRoutes(app, { loginRequired, ownedAssignment, asyncHandler, flash, HttpError, backups }) {
  function base(req) {
    return `/mail/boxes/${Number(req.params.id)}/backups`;
  }

  // Sicherung, die zum (eigenen) Postfach der URL gehört
  function ownedBackup(req, box) {
    const row = backups.get(req.customer.id, Number(req.params.bid));
    if (!row || row.mailbox !== box.ref_name) throw new HttpError(404);
    return row;
  }

  function action(fn) {
    return [
      loginRequired,
      asyncHandler(async (req, res) => {
        const box = ownedAssignment(req, Number(req.params.id), 'mailbox');
        try {
          const msg = await fn(req, box);
          if (msg) flash(req, msg);
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          flash(req, e.message, 'error');
        }
        res.redirect(base(req));
      }),
    ];
  }

  app.get(
    '/mail/boxes/:id/backups',
    loginRequired,
    (req, res) => {
      const box = ownedAssignment(req, Number(req.params.id), 'mailbox');
      const list = backups.list(req.customer.id, box.ref_name);
      const busy = list.some((b) => ['queued', 'running'].includes(b.status) || ['queued', 'running'].includes(b.restore_status));
      res.render('mail-backups', { title: `Sicherungen – ${box.ref_name}`, box, list, busy, fmtBytes });
    }
  );

  app.post('/mail/boxes/:id/backups', ...action(async (req, box) => {
    backups.request(req.customer, box.ref_name, 'manual');
    return 'Die Sicherung wurde gestartet. Diese Seite aktualisiert sich, bis sie fertig ist.';
  }));

  app.post('/mail/boxes/:id/backups/:bid/restore', ...action(async (req, box) => {
    const row = ownedBackup(req, box);
    backups.requestRestore(req.customer, row.id);
    return 'Die Wiederherstellung wurde gestartet. Die Nachrichten erscheinen in einem eigenen Ordner „Wiederhergestellt-…“.';
  }));

  app.post('/mail/boxes/:id/backups/:bid/delete', ...action(async (req, box) => {
    const row = ownedBackup(req, box);
    backups.remove(req.customer.id, row.id);
    return 'Sicherung gelöscht.';
  }));

  app.get(
    '/mail/boxes/:id/backups/:bid/download',
    loginRequired,
    (req, res) => {
      const box = ownedAssignment(req, Number(req.params.id), 'mailbox');
      const row = ownedBackup(req, box);
      if (row.status !== 'done') throw new HttpError(404);
      let file;
      let st;
      try {
        file = backups.filePath(row);
        st = fs.statSync(file);
      } catch (e) {
        flash(req, 'Die Sicherungsdatei ist nicht mehr vorhanden.', 'error');
        return res.redirect(base(req));
      }
      res.set('Content-Type', 'application/gzip');
      res.set('Content-Length', String(st.size));
      res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.file)}`);
      res.set('Cache-Control', 'no-store');
      fs.createReadStream(file).pipe(res);
    }
  );
};
