/**
 * The review UI: three static files served under /review. No framework, no inline script or
 * style (the CSP forbids both), and every value from the API is written with textContent.
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verification review</title>
<link rel="stylesheet" href="/review/app.css">
</head>
<body>
<header><h1>Verification review</h1><div id="who" hidden><span id="who-name"></span> <button id="security" type="button">Security</button> <button id="logout" type="button">Sign out</button></div></header>
<main id="app"></main>
<script src="/review/app.js"></script>
</body>
</html>`;

export const APP_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15181d;--card:#fff;--line:#d9dde3;--muted:#5b6471;--accent:#1d4ed8;--ok:#15803d;--bad:#b91c1c;--warn:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e8eaee;--card:#1a1e24;--line:#2d333b;--muted:#9aa4b2;--accent:#6d9bff;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
h1{font-size:17px;margin:0}h2{font-size:16px;margin:0 0 8px}main{max-width:1100px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px}
button{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{background:var(--bad);color:#fff;border-color:var(--bad)}
button:disabled{opacity:.5;cursor:default}
input,textarea{font:inherit;width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
label{display:block;margin:10px 0 4px;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line)}tr.row{cursor:pointer}tr.row:hover{background:var(--bg)}
.tag{display:inline-block;padding:1px 8px;margin:1px 4px 1px 0;border-radius:10px;background:var(--bg);border:1px solid var(--line);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.grid figure{margin:0}
.grid img{width:100%;max-height:420px;object-fit:contain;border:1px solid var(--line);border-radius:6px;background:#000}
figcaption{color:var(--muted);font-size:13px;margin-bottom:4px}.codes{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;font-family:ui-monospace,monospace;font-size:15px;padding:10px;border:1px dashed var(--line);border-radius:6px;margin:8px 0}.secret{font-family:ui-monospace,monospace;word-break:break-all;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);margin:6px 0}.muted{color:var(--muted)}.err{color:var(--bad)}.login{max-width:380px;margin:40px auto}.sp{margin-top:12px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
@media (max-width:600px){main{padding:12px}}
`;

export const APP_JS = `
(function () {
  'use strict';
  var app = document.getElementById('app');
  var who = document.getElementById('who');
  // Bumped on every navigation and sign-out; a response that arrives for an older view is dropped,
  // so a case can never render after the reviewer has signed out or moved on.
  var gen = 0;
  function nav() { return ++gen; }

  var ISSUES = {
    ID_BACK_MISSING: 'ID back was not uploaded',
    MRZ_NOT_FOUND: 'Machine-readable zone could not be found',
    OCR_UNAVAILABLE: 'Text recognition was unavailable',
    PIPELINE_ERROR: 'Automated checks failed repeatedly',
    SURNAME_MISMATCH: 'Surname differs from what was provided',
    GIVEN_NAMES_MISMATCH: 'Given names differ from what was provided',
    BIRTH_DATE_MISMATCH: 'Date of birth differs from what was provided',
    EXPECTED_IDENTITY_MISSING: 'No name or date of birth was provided to compare',
    DOCUMENT_EXPIRED: 'Document is expired',
    CHECK_DIGIT_MISMATCH: 'A check digit in the machine-readable zone is wrong',
    OCR_REPAIRED: 'Characters had to be corrected after text recognition',
    OPTIONAL_DATA_PRESENT: 'Unexpected data in an optional field',
    FACE_BELOW_THRESHOLD: 'Selfie does not match the ID photo closely enough',
    FACE_NOT_DETECTED: 'No face could be found',
    FACE_MULTIPLE_FACES: 'More than one face in the selfie',
    FACE_IMAGE_UNUSABLE: 'A photo could not be used for the face comparison',
    FACE_UNAVAILABLE: 'Face matching was unavailable',
    FACE_NOT_BOUND_TO_LIVENESS: 'Face match was not made against the liveness capture',
    LIVENESS_NOT_PERFORMED: 'No liveness check was done',
    LIVENESS_FAILED: 'Liveness check failed',
    LIVENESS_INCOMPLETE: 'Liveness check was not completed',
    LIVENESS_UNAVAILABLE: 'Liveness check was unavailable',
    ID_FRONT_MISSING: 'ID front was not uploaded',
    SELFIE_MISSING: 'Selfie was not uploaded',
    LICENCE_FRONT_MISSING: 'Driving licence front was not uploaded',
    LICENCE_NOT_CHECKED: 'A driving licence was required but could not be checked',
    LICENCE_NOT_READABLE: 'Nothing could be read from the driving licence',
    LICENCE_FIELDS_INCOMPLETE: 'Some driving licence fields could not be read',
    LICENCE_OCR_REPAIRED: 'Driving licence characters had to be corrected after text recognition',
    LICENCE_EXPIRED: 'Driving licence is expired',
    LICENCE_DATES_IMPLAUSIBLE: 'Driving licence dates are not plausible',
    LICENCE_CROSSCHECK_UNAVAILABLE: 'The ID could not be read, so the licence could not be compared with it',
    LICENCE_PERSONAL_NUMBER_MISMATCH: 'Personal number on the licence differs from the ID',
    LICENCE_SURNAME_MISMATCH: 'Surname on the licence differs from the ID',
    LICENCE_GIVEN_NAMES_MISMATCH: 'Given names on the licence differ from the ID',
    LICENCE_BIRTH_DATE_MISMATCH: 'Date of birth on the licence differs from the ID'
  };

  function el(tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') n.textContent = props[k];
      else if (k === 'class') n.className = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function clear() { while (app.firstChild) app.removeChild(app.firstChild); }

  // Thrown after the screen has already been replaced (signed out, or two-factor setup required): callers must not write into the old one
  var HANDLED = 'signed-out';

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/review/api' + path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return {}; }).then(function (data) {
        // Only "not signed in" means the session is gone. A 401 for a wrong password or code does not:
        // it must reach the form that asked, so one typo does not throw the person back to the start.
        if (res.status === 401 && data.message === 'Not signed in') { showLogin(); throw new Error(HANDLED); }
        // The organisation started requiring two-factor while this person was signed in
        if (res.status === 403 && data.code === 'two_factor_setup_required') { showSecurity(true); throw new Error(HANDLED); }
        if (!res.ok) { var e = new Error(data.message || 'Request failed'); e.status = res.status; e.code = data.code; throw e; }
        return data;
      });
    });
  }

  function showLogin(message) {
    nav();
    who.hidden = true;
    clear();
    var email = el('input', { type: 'email', id: 'email', autocomplete: 'username', required: '' });
    var pw = el('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: '' });
    var msg = el('p', { class: 'err', role: 'alert', text: message || '' });
    var form = el('form', { class: 'card login' }, [
      el('h2', { text: 'Sign in' }),
      el('label', { for: 'email', text: 'Email' }), email,
      el('label', { for: 'password', text: 'Password' }), pw,
      msg,
      el('button', { class: 'primary', type: 'submit', text: 'Sign in' })
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      api('POST', '/login', { email: email.value, password: pw.value })
        .then(function (res) {
          pw.value = '';
          // The password was right but a second factor is needed: no session yet, only a short-lived challenge
          if (res && res.twoFactorRequired) return showSecondFactor(res.challenge);
          start();
        })
        .catch(function () { msg.textContent = 'Invalid email or password.'; });
    });
    app.appendChild(form);
  }

  function showSecondFactor(challenge, message) {
    nav();
    who.hidden = true;
    clear();
    var code = el('input', { type: 'text', id: 'code', autocomplete: 'one-time-code', inputmode: 'text', required: '', maxlength: '32' });
    var msg = el('p', { class: 'err', role: 'alert', text: message || '' });
    var form = el('form', { class: 'card login' }, [
      el('h2', { text: 'Two-factor sign-in' }),
      el('p', { class: 'muted', text: 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.' }),
      el('label', { for: 'code', text: 'Code' }), code,
      msg,
      el('button', { class: 'primary', type: 'submit', text: 'Verify' }),
      el('button', { type: 'button', text: 'Back', onclick: function () { showLogin(); } })
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      api('POST', '/login/2fa', { challenge: challenge, code: code.value })
        .then(function () { start(); })
        .catch(function () { code.value = ''; msg.textContent = 'That code did not work, or it expired. Go back and sign in again if it keeps failing.'; });
    });
    app.appendChild(form);
    code.focus();
  }

  // Two-factor settings. With forced = true the organisation requires it and nothing else is open until it is set up.
  function showSecurity(forced) {
    var my = nav();
    clear();
    var card = el('div', { class: 'card' }, [el('h2', { text: 'Two-factor sign-in' })]);
    var body = el('div', { class: 'muted', text: 'Loading…' });
    card.appendChild(body);
    if (!forced) app.appendChild(el('button', { text: '← Back to queue', onclick: function () { location.hash = '#/'; start(); } }));
    app.appendChild(card);

    function field(id, label, type) { return [el('label', { for: id, text: label }), el('input', { type: type, id: id, autocomplete: type === 'password' ? 'current-password' : 'one-time-code' })]; }
    function value(id) { return document.getElementById(id).value; }
    function fail(msg, e) { msg.textContent = e && e.status === 401 ? 'The password or code was not right.' : e && e.status === 403 ? e.message : 'Something went wrong. Try again.'; }

    function showCodes(codes) {
      body.textContent = '';
      body.className = '';
      body.appendChild(el('p', { text: 'Two-factor sign-in is on. Save these recovery codes somewhere safe: each works once if you lose your phone. They are shown only now.' }));
      body.appendChild(el('div', { class: 'codes' }, codes.map(function (c) { return el('span', { text: c }); })));
      body.appendChild(el('button', { class: 'primary', type: 'button', text: 'I have saved them', onclick: function () { location.hash = '#/'; start(); } }));
    }

    api('GET', '/2fa').then(function (st) {
      if (my !== gen) return;
      body.textContent = '';
      body.className = '';
      if (!st.enabled) {
        if (st.required) body.appendChild(el('p', { text: 'Your organisation requires two-factor sign-in. Set it up to continue.' }));
        else body.appendChild(el('p', { class: 'muted', text: 'Adds a code from an authenticator app to your sign-in, so a stolen password is not enough.' }));
        var msg = el('p', { class: 'err', role: 'alert' });
        var start1 = el('div', {}, field('pw1', 'Your password', 'password').concat([
          el('button', { class: 'primary', type: 'button', text: 'Set up', onclick: function () {
            msg.textContent = '';
            api('POST', '/2fa/setup', { password: value('pw1') }).then(function (s) {
              if (my !== gen) return;
              start1.remove();
              body.appendChild(el('p', { text: 'In your authenticator app, add an account using this setup key (choose "enter a setup key", time-based):' }));
              body.appendChild(el('div', { class: 'secret', text: s.secret }));
              body.appendChild(el('p', { class: 'muted', text: 'Then enter the 6-digit code it shows to confirm.' }));
              var m2 = el('p', { class: 'err', role: 'alert' });
              var confirm = el('div', {}, field('code1', 'Code', 'text').concat([
                el('button', { class: 'primary', type: 'button', text: 'Turn on', onclick: function () {
                  m2.textContent = '';
                  api('POST', '/2fa/enable', { code: value('code1') }).then(function (r) { if (my === gen) showCodes(r.recoveryCodes); }).catch(function (e) { fail(m2, e); });
                } }), m2
              ]));
              body.appendChild(confirm);
            }).catch(function (e) { fail(msg, e); });
          } }), msg
        ]));
        body.appendChild(start1);
      } else {
        body.appendChild(el('p', { text: 'Two-factor sign-in is on. Recovery codes left: ' + st.recoveryCodesLeft + '.' }));
        var m3 = el('p', { class: 'err', role: 'alert' });
        var manage = el('div', {}, field('pw2', 'Your password', 'password').concat(field('code2', 'Current code (or a recovery code)', 'text'), [
          el('button', { type: 'button', text: 'Get new recovery codes', onclick: function () {
            m3.textContent = '';
            api('POST', '/2fa/recovery-codes', { password: value('pw2'), code: value('code2') }).then(function (r) { if (my === gen) showCodes(r.recoveryCodes); }).catch(function (e) { fail(m3, e); });
          } }),
          st.required ? el('p', { class: 'muted', text: 'Your organisation requires two-factor sign-in, so it cannot be turned off.' }) : el('button', { class: 'danger', type: 'button', text: 'Turn off', onclick: function () {
            m3.textContent = '';
            api('POST', '/2fa/disable', { password: value('pw2'), code: value('code2') }).then(function () { if (my === gen) showSecurity(false); }).catch(function (e) { fail(m3, e); });
          } }),
          m3
        ]));
        body.appendChild(manage);
      }
    }).catch(function (e) { if (e.message !== 'signed-out') body.textContent = 'Could not load your settings.'; });
  }

  function showQueue() {
    var my = nav();
    clear();
    var card = el('div', { class: 'card' }, [el('h2', { text: 'Waiting for review' })]);
    var body = el('div', { class: 'muted', text: 'Loading…' });
    card.appendChild(body);
    app.appendChild(card);
    load(null);

    function load(cursor) {
      api('GET', '/sessions' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')).then(function (data) {
        if (my !== gen) return;
        if (!cursor) body.textContent = '';
        if (!data.items.length && !cursor) { body.textContent = 'Nothing is waiting for review.'; return; }
        var table = body.querySelector('table');
        if (!table) {
          table = el('table', {}, [el('thead', {}, [el('tr', {}, ['Reference', 'Submitted', 'Why it needs review'].map(function (h) { return el('th', { text: h }); }))]), el('tbody')]);
          body.appendChild(table);
        }
        data.items.forEach(function (s) {
          var tags = el('td');
          (s.issues.length ? s.issues : ['NO_AUTOMATED_RESULT']).forEach(function (c) { tags.appendChild(el('span', { class: 'tag', text: ISSUES[c] || c })); });
          var row = el('tr', { class: 'row', tabindex: '0' }, [el('td', { text: s.externalRef }), el('td', { text: new Date(s.createdAt).toLocaleString() }), tags]);
          var open = function () { location.hash = '#/s/' + s.id; };
          row.addEventListener('click', open);
          row.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
          table.querySelector('tbody').appendChild(row);
        });
        var more = body.querySelector('.more');
        if (more) more.remove();
        if (data.nextCursor) body.appendChild(el('button', { class: 'more', text: 'Load more', onclick: function () { load(data.nextCursor); } }));
      }).catch(function (e) { if (my === gen && e.message !== 'signed-out') body.textContent = 'Could not load the queue.'; });
    }
  }

  function yesNo(v) { return v === true ? ['yes', 'ok'] : v === false ? ['no', 'bad'] : ['not checked', 'muted']; }
  function row(dl, k, v, cls) { dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v, class: cls || '' })); }

  function showDetail(id) {
    var my = nav();
    clear();
    var back = el('button', { text: '← Back to queue', onclick: function () { location.hash = '#/'; } });
    app.appendChild(back);
    var holder = el('div', { class: 'muted', text: 'Loading…' });
    app.appendChild(holder);
    api('GET', '/sessions/' + encodeURIComponent(id)).then(function (s) {
      if (my !== gen) return;
      holder.remove();
      var base = '/review/api/sessions/' + encodeURIComponent(s.id) + '/documents/';
      var kinds = ['ID_FRONT', 'ID_BACK', 'SELFIE'].concat(['LICENCE_FRONT', 'LICENCE_BACK'].filter(function (k) { return s.documents.indexOf(k) >= 0; }));
      var figs = kinds.map(function (k) {
        if (s.documents.indexOf(k) < 0) return el('figure', {}, [el('figcaption', { text: k.replace('_', ' ') + ' — not uploaded' })]);
        return el('figure', {}, [el('figcaption', { text: k.replace('_', ' ') }), el('img', { src: base + k, alt: k.replace('_', ' ') + ' photo' })]);
      });
      app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'Documents' }), el('div', { class: 'grid' }, figs)]));

      var exp = el('dl');
      row(exp, 'Reference', s.externalRef);
      row(exp, 'First name', s.expected.firstName || 'not provided', s.expected.firstName ? '' : 'muted');
      row(exp, 'Last name', s.expected.lastName || 'not provided', s.expected.lastName ? '' : 'muted');
      row(exp, 'Date of birth', s.expected.birthDate || 'not provided', s.expected.birthDate ? '' : 'muted');
      app.appendChild(el('div', { class: 'card' }, [el('h2', { text: 'What was provided' }), exp]));

      var v = s.verification;
      var res = el('div', { class: 'card' }, [el('h2', { text: 'Automated checks' })]);
      if (!v) res.appendChild(el('p', { class: 'muted', text: 'No automated result is available.' }));
      else {
        var dl = el('dl');
        row(dl, 'ID text found', yesNo(v.mrz.found)[0], yesNo(v.mrz.found)[1]);
        row(dl, 'ID check digits valid', yesNo(v.mrz.valid)[0], yesNo(v.mrz.valid)[1]);
        row(dl, 'Surname matches', v.identity.surname || 'not checked');
        row(dl, 'Given names match', v.identity.givenNames || 'not checked');
        row(dl, 'Date of birth matches', v.identity.birthDate || 'not checked');
        row(dl, 'Expired', v.expired === null ? 'not checked' : v.expired ? 'yes' : 'no', v.expired ? 'bad' : '');
        row(dl, 'Face match', v.face.status ? v.face.status + (v.face.similarity !== null ? ' (' + v.face.similarity.toFixed(1) + ')' : '') : 'not checked');
        row(dl, 'Liveness', v.liveness.status ? v.liveness.status + (v.liveness.confidence !== null ? ' (' + v.liveness.confidence.toFixed(1) + ')' : '') : 'not checked');
        if (v.licence) {
          var lc = v.licence;
          row(dl, 'Licence fields read', lc.found ? 'all (' + lc.fields.join(', ') + ')' : (lc.fields.length ? 'only ' + lc.fields.join(', ') : 'none'), lc.found ? 'ok' : 'bad');
          row(dl, 'Licence expired', lc.expired === null ? 'not checked' : lc.expired ? 'yes' : 'no', lc.expired ? 'bad' : '');
          row(dl, 'Licence dates plausible', lc.datesValid === null ? 'not checked' : lc.datesValid ? 'yes' : 'no', lc.datesValid === false ? 'bad' : '');
          row(dl, 'Licence personal number matches ID', lc.crossCheck.personalNumber || 'not checked');
          row(dl, 'Licence surname matches ID', lc.crossCheck.surname || 'not checked');
          row(dl, 'Licence given names match ID', lc.crossCheck.givenNames || 'not checked');
          row(dl, 'Licence date of birth matches ID', lc.crossCheck.birthDate || 'not checked');
        }
        res.appendChild(dl);
        var tags = el('p');
        v.issues.forEach(function (c) { tags.appendChild(el('span', { class: 'tag', text: ISSUES[c] || c })); });
        res.appendChild(el('h2', { class: 'sp', text: 'Issues' }));
        res.appendChild(v.issues.length ? tags : el('p', { class: 'muted', text: 'None.' }));
      }
      app.appendChild(res);

      var box = el('div', { class: 'card' }, [el('h2', { text: 'Decision' })]);
      if (s.status !== 'NEEDS_REVIEW') {
        box.appendChild(el('p', { text: 'This session is ' + s.status.toLowerCase().replace('_', ' ') + '.' + (s.review && s.review.reason ? ' Reason: ' + s.review.reason : '') }));
      } else {
        var reason = el('textarea', { id: 'reason', rows: '3', maxlength: '500' });
        var msg = el('p', { class: 'err', role: 'alert' });
        var approve = el('button', { class: 'primary', type: 'button', text: 'Approve' });
        var reject = el('button', { class: 'danger', type: 'button', text: 'Reject' });
        function decide(decision) {
          if (decision === 'REJECTED' && reason.value.trim().length < 3) { msg.textContent = 'Give a reason for rejecting.'; return; }
          approve.disabled = reject.disabled = true;
          api('POST', '/sessions/' + encodeURIComponent(s.id) + '/decision', { decision: decision, reason: reason.value.trim() || undefined })
            .then(function () { if (my === gen) location.hash = '#/'; })
            .catch(function (e) {
              if (my !== gen) return;
              msg.textContent = e.status === 409 ? 'Someone else already decided this session.' : 'Could not save the decision.';
              approve.disabled = reject.disabled = false;
            });
        }
        approve.addEventListener('click', function () { decide('APPROVED'); });
        reject.addEventListener('click', function () { decide('REJECTED'); });
        box.appendChild(el('label', { for: 'reason', text: 'Reason (required to reject; shared with the customer)' }));
        box.appendChild(reason);
        box.appendChild(msg);
        box.appendChild(el('div', { class: 'actions' }, [approve, reject]));
      }
      app.appendChild(box);
    }).catch(function (e) { if (my === gen && e.message !== 'signed-out') { holder.className = 'err'; holder.textContent = 'Session not found.'; } });
  }

  function route() {
    var m = location.hash.match(/^#\\/s\\/([0-9a-f-]{36})$/);
    if (location.hash === '#/security') return showSecurity(false);
    if (m) showDetail(m[1]); else showQueue();
  }

  function start() {
    var at = gen;
    api('GET', '/me').then(function (me) {
      if (at !== gen) return;
      document.getElementById('who-name').textContent = me.name || me.email;
      who.hidden = false;
      // The organisation requires two-factor sign-in and this person has not set it up: nothing else is open yet
      if (me.twoFactorSetupRequired) return showSecurity(true);
      route();
    }).catch(function () { /* showLogin already ran */ });
  }

  document.getElementById('security').addEventListener('click', function () { location.hash = '#/security'; });
  document.getElementById('logout').addEventListener('click', function () {
    nav();
    api('POST', '/logout').then(function () { showLogin(); }).catch(function () { showLogin(); });
  });
  window.addEventListener('hashchange', function () { if (!who.hidden) route(); });
  start();
})();
`;
