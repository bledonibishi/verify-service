/**
 * The review UI: static files served under /review. No framework, no inline script or style (the
 * CSP forbids both), and every value from the API is written with textContent. Styled with
 * Tailwind: the classes below are built, together with the hosted page's, into the stylesheet the
 * service serves at /review/app.css (see src/hosted/tailwind.css).
 */
export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verification review</title>
<link rel="stylesheet" href="/review/app.css">
</head>
<body class="min-h-screen">
<header class="sticky top-0 z-10 border-b border-line bg-card">
<div class="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
<h1 class="flex items-center gap-2 text-base font-bold tracking-tight"><svg class="size-6 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z"/><path d="M9 12l2 2 4-4.5"/></svg>Verification review</h1>
<div id="who" class="flex items-center gap-2" hidden><span id="who-name" class="hidden rounded-full bg-soft px-3 py-1 text-sm font-medium text-muted sm:inline"></span> <button id="security" class="cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-semibold hover:border-muted" type="button">Security</button> <button id="logout" class="cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-semibold hover:border-muted" type="button">Sign out</button></div>
</div>
</header>
<main id="app" class="mx-auto max-w-6xl px-4 py-6"></main>
<script src="/review/app.js"></script>
</body>
</html>`;

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
  // Red: evidence against the person or the document. Everything else is amber: something to look at.
  var SERIOUS = ['MRZ_NOT_FOUND', 'CHECK_DIGIT_MISMATCH', 'SURNAME_MISMATCH', 'GIVEN_NAMES_MISMATCH', 'BIRTH_DATE_MISMATCH',
    'DOCUMENT_EXPIRED', 'FACE_BELOW_THRESHOLD', 'FACE_MULTIPLE_FACES', 'FACE_NOT_BOUND_TO_LIVENESS', 'LIVENESS_FAILED',
    'PIPELINE_ERROR', 'LICENCE_EXPIRED', 'LICENCE_DATES_IMPLAUSIBLE', 'LICENCE_PERSONAL_NUMBER_MISMATCH',
    'LICENCE_SURNAME_MISMATCH', 'LICENCE_GIVEN_NAMES_MISMATCH', 'LICENCE_BIRTH_DATE_MISMATCH'];
  function serious(code) { return SERIOUS.indexOf(code) >= 0; }

  // Tailwind classes, as whole literal strings so the build finds them
  var C = {
    h2: 'text-2xl font-bold tracking-tight',
    h3: 'mb-3 text-base font-semibold',
    card: 'rounded-2xl border border-line bg-card p-5 shadow-card sm:p-6',
    muted: 'text-muted',
    small: 'text-sm text-muted',
    err: 'mt-3 text-sm font-medium text-bad empty:hidden',
    label: 'mt-4 mb-1.5 block text-sm font-medium text-muted',
    labelTop: 'mb-1.5 block text-sm font-medium text-muted',
    input: 'w-full rounded-xl border border-line bg-bg px-3.5 py-2.5 text-fg placeholder:text-muted focus:border-accent focus:outline-2 focus:outline-offset-0 focus:outline-accent',
    primary: 'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-4 py-2.5 font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-default disabled:opacity-50',
    secondary: 'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-card px-4 py-2.5 font-semibold text-fg hover:border-muted disabled:cursor-default disabled:opacity-50',
    approve: 'inline-flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-ok bg-ok px-4 py-3 font-semibold text-on-strong hover:opacity-90 disabled:cursor-default disabled:opacity-50 [&_svg]:size-5',
    dangerSmall: 'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-bad bg-bad px-4 py-2.5 font-semibold text-on-strong hover:opacity-90 disabled:cursor-default disabled:opacity-50',
    danger: 'inline-flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border border-bad bg-bad px-4 py-3 font-semibold text-on-strong hover:opacity-90 disabled:cursor-default disabled:opacity-50 [&_svg]:size-5',
    back: 'mb-4 inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-semibold text-accent hover:underline [&_svg]:size-4',
    chipBad: 'inline-flex items-center rounded-full bg-bad-weak px-2.5 py-0.5 text-xs font-semibold text-bad',
    chipWarn: 'inline-flex items-center rounded-full bg-warn-weak px-2.5 py-0.5 text-xs font-semibold text-warn',
    chipMuted: 'inline-flex items-center rounded-full border border-line bg-soft px-2.5 py-0.5 text-xs font-semibold text-muted',
    stat: 'rounded-2xl border border-line bg-card px-3 py-3 shadow-card sm:px-5 sm:py-4',
    statLabel: 'text-xs font-medium text-muted sm:text-sm',
    statValue: 'mt-1 text-lg font-bold tracking-tight sm:text-2xl',
    list: 'divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card shadow-card',
    item: 'flex items-center gap-4 px-5 py-4 text-fg no-underline hover:bg-soft focus-visible:bg-soft focus-visible:outline-none',
    itemIcon: 'flex size-10 flex-none items-center justify-center rounded-full bg-accent-weak text-accent [&_svg]:size-5',
    itemIconBad: 'flex size-10 flex-none items-center justify-center rounded-full bg-bad-weak text-bad [&_svg]:size-5',
    chevron: 'flex-none text-muted [&_svg]:size-5',
    empty: 'flex flex-col items-center rounded-2xl border border-line bg-card px-6 py-14 text-center shadow-card',
    emptyIcon: 'mb-4 flex size-16 items-center justify-center rounded-full bg-ok-weak text-ok [&_svg]:size-8',
    pillReview: 'inline-flex items-center gap-1.5 rounded-full bg-warn-weak px-3 py-1 text-sm font-semibold text-warn',
    pillOk: 'inline-flex items-center gap-1.5 rounded-full bg-ok-weak px-3 py-1 text-sm font-semibold text-ok',
    pillBad: 'inline-flex items-center gap-1.5 rounded-full bg-bad-weak px-3 py-1 text-sm font-semibold text-bad',
    docs: 'grid gap-4 sm:grid-cols-2',
    figure: 'm-0',
    caption: 'mb-2 flex items-center justify-between text-sm font-semibold',
    photo: 'block h-64 w-full rounded-xl border border-line bg-[#0b0f15] object-contain',
    missing: 'flex h-64 items-center justify-center rounded-xl border border-dashed border-line bg-soft text-sm text-muted',
    faceSlot: 'flex h-64 flex-col items-center justify-center gap-2 rounded-xl border border-line bg-soft px-4 text-center',
    faceSlotIcon: 'mb-1 flex size-12 items-center justify-center rounded-full bg-accent-weak text-accent [&_svg]:size-6',
    faceLineOk: 'text-sm font-semibold text-ok',
    faceLineBad: 'text-sm font-semibold text-bad',
    faceLineNone: 'text-sm font-semibold text-muted',
    open: 'text-xs font-semibold text-accent hover:underline',
    checkRow: 'flex items-start gap-3 py-2.5',
    checkPass: 'mt-0.5 flex-none text-ok [&_svg]:size-5',
    checkFail: 'mt-0.5 flex-none text-bad [&_svg]:size-5',
    checkNone: 'mt-0.5 flex-none text-muted [&_svg]:size-5',
    checkLabel: 'flex-1',
    checkValue: 'text-sm font-semibold',
    bar: 'mt-2 h-1.5 w-full overflow-hidden rounded-full bg-soft',
    barFillOk: 'block h-full rounded-full bg-ok',
    barFillBad: 'block h-full rounded-full bg-bad',
    dl: 'grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm',
    dt: 'text-muted',
    dd: 'm-0 font-medium',
    textarea: 'w-full rounded-xl border border-line bg-bg px-3.5 py-2.5 text-fg focus:border-accent focus:outline-2 focus:outline-accent',
    codes: 'my-3 grid grid-cols-2 gap-2 rounded-xl border border-dashed border-line p-3 font-mono text-sm sm:grid-cols-3',
    secret: 'my-2 rounded-xl border border-line bg-soft p-3 font-mono text-sm break-all',
    login: 'mx-auto mt-10 max-w-sm',
    loginCard: 'rounded-2xl border border-line bg-card p-6 shadow-card sm:p-8',
    loginIcon: 'mb-5 flex size-12 items-center justify-center rounded-2xl bg-accent-weak text-accent [&_svg]:size-7',
    stack: 'mt-6 grid gap-3'
  };

  var ICONS = {
    shield: [['path', { d: 'M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z' }]],
    lock: [['rect', { x: 5, y: 10.5, width: 14, height: 9.5, rx: 2 }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]],
    pass: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.6 2.6L16 9.6' }]],
    fail: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9 9l6 6M15 9l-6 6' }]],
    none: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8.5 12h7' }]],
    chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
    back: [['path', { d: 'M15 6l-6 6 6 6' }]],
    doc: [['rect', { x: 3, y: 6, width: 18, height: 12, rx: 2.5 }], ['circle', { cx: 8.5, cy: 11, r: 1.8 }], ['path', { d: 'M13 10h4.5M13 13.5h3M6 15.5h5' }]],
    alert: [['path', { d: 'M12 4l9 16H3z' }], ['path', { d: 'M12 10v4.5M12 17.2v.3' }]],
    done: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.6 2.6L16 9.6' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
    cross: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
    face: [['circle', { cx: 12, cy: 10, r: 4 }], ['path', { d: 'M4.5 20c1.6-3.2 4.3-4.8 7.5-4.8s5.9 1.6 7.5 4.8' }]]
  };
  function icon(name) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    (ICONS[name] || []).forEach(function (part) {
      var n = document.createElementNS(NS, part[0]);
      Object.keys(part[1]).forEach(function (k) { n.setAttribute(k, String(part[1][k])); });
      svg.appendChild(n);
    });
    return svg;
  }

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
  function chip(code) { return el('span', { class: serious(code) ? C.chipBad : code === 'NO_AUTOMATED_RESULT' ? C.chipMuted : C.chipWarn, text: ISSUES[code] || code }); }

  // "3 hours ago", for scanning a queue; the exact time is shown next to it
  function ago(iso) {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    var d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }

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

  function field(id, label, type) {
    return [el('label', { class: C.label, for: id, text: label }), el('input', { class: C.input, type: type, id: id, autocomplete: type === 'password' ? 'current-password' : type === 'email' ? 'username' : 'one-time-code' })];
  }

  function showLogin(message) {
    nav();
    who.hidden = true;
    clear();
    var email = el('input', { class: C.input, type: 'email', id: 'email', autocomplete: 'username', required: '' });
    var pw = el('input', { class: C.input, type: 'password', id: 'password', autocomplete: 'current-password', required: '' });
    var msg = el('p', { class: C.err, role: 'alert', text: message || '' });
    var form = el('form', { class: C.loginCard }, [
      el('div', { class: C.loginIcon }, [icon('shield')]),
      el('h2', { class: C.h2, text: 'Sign in' }),
      el('p', { class: 'mt-1 ' + C.small, text: 'Review identity checks for your organisation.' }),
      el('label', { class: C.label, for: 'email', text: 'Email' }), email,
      el('label', { class: C.label, for: 'password', text: 'Password' }), pw,
      msg,
      el('div', { class: C.stack }, [el('button', { class: C.primary, type: 'submit', text: 'Sign in' })])
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
    app.appendChild(el('div', { class: C.login }, [form]));
  }

  function showSecondFactor(challenge, message) {
    nav();
    who.hidden = true;
    clear();
    var code = el('input', { class: C.input + ' font-mono tracking-widest', type: 'text', id: 'code', autocomplete: 'one-time-code', inputmode: 'text', required: '', maxlength: '32' });
    var msg = el('p', { class: C.err, role: 'alert', text: message || '' });
    var form = el('form', { class: C.loginCard }, [
      el('div', { class: C.loginIcon }, [icon('lock')]),
      el('h2', { class: C.h2, text: 'Two-factor sign-in' }),
      el('p', { class: 'mt-1 ' + C.small, text: 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.' }),
      el('label', { class: C.label, for: 'code', text: 'Code' }), code,
      msg,
      el('div', { class: C.stack }, [
        el('button', { class: C.primary, type: 'submit', text: 'Verify' }),
        el('button', { class: C.secondary, type: 'button', text: 'Back', onclick: function () { showLogin(); } })
      ])
    ]);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      api('POST', '/login/2fa', { challenge: challenge, code: code.value })
        .then(function () { start(); })
        .catch(function () { code.value = ''; msg.textContent = 'That code did not work, or it expired. Go back and sign in again if it keeps failing.'; });
    });
    app.appendChild(el('div', { class: C.login }, [form]));
    code.focus();
  }

  // Two-factor settings. With forced = true the organisation requires it and nothing else is open until it is set up.
  function showSecurity(forced) {
    var my = nav();
    clear();
    if (!forced) app.appendChild(el('button', { class: C.back, type: 'button', onclick: function () { location.hash = '#/'; start(); } }, [icon('back'), el('span', { text: 'Back to queue' })]));
    var card = el('div', { class: C.card + ' max-w-2xl' }, [el('h2', { class: C.h2 + ' mb-2', text: 'Two-factor sign-in' })]);
    var body = el('div', { class: C.muted, text: 'Loading…' });
    card.appendChild(body);
    app.appendChild(card);

    function value(id) { return document.getElementById(id).value; }
    function fail(msg, e) { msg.textContent = e && e.status === 401 ? 'The password or code was not right.' : e && e.status === 403 ? e.message : 'Something went wrong. Try again.'; }

    function showCodes(codes) {
      body.textContent = '';
      body.className = '';
      body.appendChild(el('p', { text: 'Two-factor sign-in is on. Save these recovery codes somewhere safe: each works once if you lose your phone. They are shown only now.' }));
      body.appendChild(el('div', { class: C.codes }, codes.map(function (c) { return el('span', { text: c }); })));
      body.appendChild(el('button', { class: C.primary, type: 'button', text: 'I have saved them', onclick: function () { location.hash = '#/'; start(); } }));
    }

    api('GET', '/2fa').then(function (st) {
      if (my !== gen) return;
      body.textContent = '';
      body.className = '';
      if (!st.enabled) {
        if (st.required) body.appendChild(el('p', { text: 'Your organisation requires two-factor sign-in. Set it up to continue.' }));
        else body.appendChild(el('p', { class: C.muted, text: 'Adds a code from an authenticator app to your sign-in, so a stolen password is not enough.' }));
        var msg = el('p', { class: C.err, role: 'alert' });
        var start1 = el('div', {}, field('pw1', 'Your password', 'password').concat([
          el('div', { class: 'mt-4' }, [el('button', { class: C.primary, type: 'button', text: 'Set up', onclick: function () {
            msg.textContent = '';
            api('POST', '/2fa/setup', { password: value('pw1') }).then(function (s) {
              if (my !== gen) return;
              start1.remove();
              body.appendChild(el('p', { class: 'mt-2', text: 'In your authenticator app, add an account using this setup key (choose "enter a setup key", time-based):' }));
              body.appendChild(el('div', { class: C.secret, text: s.secret }));
              body.appendChild(el('p', { class: C.small, text: 'Then enter the 6-digit code it shows to confirm.' }));
              var m2 = el('p', { class: C.err, role: 'alert' });
              var confirm = el('div', {}, field('code1', 'Code', 'text').concat([
                el('div', { class: 'mt-4' }, [el('button', { class: C.primary, type: 'button', text: 'Turn on', onclick: function () {
                  m2.textContent = '';
                  api('POST', '/2fa/enable', { code: value('code1') }).then(function (r) { if (my === gen) showCodes(r.recoveryCodes); }).catch(function (e) { fail(m2, e); });
                } })]), m2
              ]));
              body.appendChild(confirm);
            }).catch(function (e) { fail(msg, e); });
          } })]), msg
        ]));
        body.appendChild(start1);
      } else {
        body.appendChild(el('p', { text: 'Two-factor sign-in is on. Recovery codes left: ' + st.recoveryCodesLeft + '.' }));
        var m3 = el('p', { class: C.err, role: 'alert' });
        var manage = el('div', {}, field('pw2', 'Your password', 'password').concat(field('code2', 'Current code (or a recovery code)', 'text'), [
          el('div', { class: 'mt-4 flex flex-wrap gap-2' }, [
            el('button', { class: C.secondary, type: 'button', text: 'Get new recovery codes', onclick: function () {
              m3.textContent = '';
              api('POST', '/2fa/recovery-codes', { password: value('pw2'), code: value('code2') }).then(function (r) { if (my === gen) showCodes(r.recoveryCodes); }).catch(function (e) { fail(m3, e); });
            } }),
            st.required ? null : el('button', { class: C.dangerSmall, type: 'button', text: 'Turn off', onclick: function () {
              m3.textContent = '';
              api('POST', '/2fa/disable', { password: value('pw2'), code: value('code2') }).then(function () { if (my === gen) showSecurity(false); }).catch(function (e) { fail(m3, e); });
            } })
          ]),
          st.required ? el('p', { class: 'mt-3 ' + C.small, text: 'Your organisation requires two-factor sign-in, so it cannot be turned off.' }) : null,
          m3
        ]));
        body.appendChild(manage);
      }
    }).catch(function (e) { if (e.message !== 'signed-out') body.textContent = 'Could not load your settings.'; });
  }

  function showQueue() {
    var my = nav();
    clear();
    var count = el('span', { class: C.chipMuted });
    var head = el('div', { class: 'mb-5 flex items-center gap-3' }, [el('h2', { class: C.h2, text: 'Waiting for review' }), count]);
    var stats = el('div', { class: 'mb-5 grid grid-cols-3 gap-2 sm:gap-3', hidden: '' });
    var body = el('div', { class: C.muted, text: 'Loading…' });
    app.appendChild(head);
    app.appendChild(stats);
    app.appendChild(body);
    var shown = [];
    var hasMore = false;
    load(null);

    function stat(label, value) { return el('div', { class: C.stat }, [el('div', { class: C.statLabel, text: label }), el('div', { class: C.statValue, text: value })]); }
    function summarise() {
      while (stats.firstChild) stats.removeChild(stats.firstChild);
      var oldest = shown.reduce(function (a, s) { return !a || s.createdAt < a ? s.createdAt : a; }, null);
      var flagged = shown.filter(function (s) { return s.issues.some(serious); }).length;
      count.textContent = shown.length + (hasMore ? '+' : '');
      stats.appendChild(stat('Waiting', shown.length + (hasMore ? '+' : '')));
      stats.appendChild(stat('Oldest waiting', oldest ? ago(oldest) : '–'));
      stats.appendChild(stat('With serious issues', String(flagged)));
      stats.hidden = false;
    }

    function load(cursor) {
      api('GET', '/sessions' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')).then(function (data) {
        if (my !== gen) return;
        if (!cursor) { body.textContent = ''; body.className = ''; }
        if (!data.items.length && !cursor) {
          count.textContent = '0';
          body.appendChild(el('div', { class: C.empty }, [
            el('div', { class: C.emptyIcon }, [icon('done')]),
            el('p', { class: 'text-lg font-semibold', text: 'All caught up' }),
            el('p', { class: 'mt-1 ' + C.muted, text: 'Nothing is waiting for review.' })
          ]));
          return;
        }
        var list = body.querySelector('[data-list]');
        if (!list) { list = el('div', { class: C.list, 'data-list': '' }); body.appendChild(list); }
        data.items.forEach(function (s) {
          shown.push(s);
          var codes = s.issues.length ? s.issues : ['NO_AUTOMATED_RESULT'];
          var bad = codes.some(serious);
          var chips = el('div', { class: 'mt-2 flex flex-wrap gap-1.5' }, codes.map(chip));
          list.appendChild(el('a', { class: C.item, href: '#/s/' + s.id }, [
            el('span', { class: bad ? C.itemIconBad : C.itemIcon }, [icon(bad ? 'alert' : 'doc')]),
            el('div', { class: 'min-w-0 flex-1' }, [
              el('div', { class: 'flex flex-wrap items-baseline gap-x-3' }, [
                el('span', { class: 'font-semibold', text: s.externalRef }),
                el('span', { class: C.small, text: ago(s.createdAt) + ' · ' + new Date(s.createdAt).toLocaleString() })
              ]),
              chips
            ]),
            el('span', { class: C.chevron }, [icon('chevron')])
          ]));
        });
        hasMore = !!data.nextCursor;
        summarise();
        var more = body.querySelector('.more');
        if (more) more.remove();
        if (data.nextCursor) body.appendChild(el('div', { class: 'more mt-4 text-center' }, [el('button', { class: C.secondary, type: 'button', text: 'Load more', onclick: function () { load(data.nextCursor); } })]));
      }).catch(function (e) { if (my === gen && e.message !== 'signed-out') { body.className = C.err; body.textContent = 'Could not load the queue.'; } });
    }
  }

  // One line of the checks list: pass, fail, or not checked, with an optional score bar
  function check(label, state, value, score) {
    var mark = el('span', { class: state === 'pass' ? C.checkPass : state === 'fail' ? C.checkFail : C.checkNone }, [icon(state === 'pass' ? 'pass' : state === 'fail' ? 'fail' : 'none')]);
    var right = el('div', { class: C.checkLabel }, [
      el('div', { class: 'flex items-baseline justify-between gap-3' }, [
        el('span', { text: label }),
        el('span', { class: C.checkValue + ' ' + (state === 'pass' ? 'text-ok' : state === 'fail' ? 'text-bad' : 'text-muted'), text: value })
      ])
    ]);
    if (typeof score === 'number') {
      var fill = el('span', { class: state === 'fail' ? C.barFillBad : C.barFillOk });
      fill.style.width = Math.max(2, Math.min(100, score)) + '%'; // set through the DOM, not a style attribute (the CSP blocks those)
      right.appendChild(el('div', { class: C.bar }, [fill]));
    }
    return el('div', { class: C.checkRow }, [mark, right]);
  }
  // The face check replaced the selfie and its image is not kept: show what it found instead of an empty box
  function faceCheckSlot(v) {
    var l = v.liveness, f = v.face;
    var live = l.status ? (l.status === 'live' ? 'Live' : l.status.replace(/_/g, ' ')) + (l.confidence !== null ? ' ' + l.confidence.toFixed(1) + '%' : '') : 'not checked';
    var face = f.status ? (f.status === 'match' ? 'Match' : f.status.replace(/_/g, ' ')) + (f.similarity !== null ? ' ' + f.similarity.toFixed(1) + '%' : '') : 'not checked';
    return el('figure', { class: C.figure }, [
      el('figcaption', { class: C.caption, text: 'Face check' }),
      el('div', { class: C.faceSlot }, [
        el('div', { class: C.faceSlotIcon }, [icon('face')]),
        el('p', { class: l.status === 'live' ? C.faceLineOk : l.status ? C.faceLineBad : C.faceLineNone, text: 'Liveness: ' + live }),
        el('p', { class: f.status === 'match' ? C.faceLineOk : f.status ? C.faceLineBad : C.faceLineNone, text: 'Face match with the ID photo: ' + face }),
        el('p', { class: C.small, text: 'The face image from the check is not kept.' })
      ])
    ]);
  }

  function bool(v, good) { return v === null || v === undefined ? 'none' : v === good ? 'pass' : 'fail'; }
  function match(m) { return m === 'match' ? ['pass', 'Matches'] : m === 'mismatch' ? ['fail', 'Does not match'] : m === 'not_provided' ? ['none', 'Not provided'] : ['none', 'Not checked']; }

  function showDetail(id) {
    var my = nav();
    clear();
    app.appendChild(el('button', { class: C.back, type: 'button', onclick: function () { location.hash = '#/'; } }, [icon('back'), el('span', { text: 'Back to queue' })]));
    var holder = el('div', { class: C.muted, text: 'Loading…' });
    app.appendChild(holder);
    api('GET', '/sessions/' + encodeURIComponent(id)).then(function (s) {
      if (my !== gen) return;
      holder.remove();
      var v = s.verification;
      var issues = v ? v.issues : [];
      var nBad = issues.filter(serious).length;

      // Header: who, when, where the case stands
      var pill = s.status === 'NEEDS_REVIEW' ? el('span', { class: C.pillReview, text: 'Needs review' })
        : s.status === 'APPROVED' ? el('span', { class: C.pillOk, text: 'Approved' })
        : s.status === 'REJECTED' ? el('span', { class: C.pillBad, text: 'Rejected' })
        : el('span', { class: C.chipMuted, text: s.status.toLowerCase().replace('_', ' ') });
      app.appendChild(el('div', { class: C.card + ' mb-6' }, [
        el('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, [
          el('div', {}, [
            el('h2', { class: C.h2, text: s.externalRef }),
            el('p', { class: 'mt-1 ' + C.small, text: 'Submitted ' + ago(s.createdAt) + ' · ' + new Date(s.createdAt).toLocaleString() })
          ]),
          pill
        ]),
        issues.length
          ? el('p', { class: 'mt-3 text-sm font-medium ' + (nBad ? 'text-bad' : 'text-warn'), text: nBad ? nBad + ' serious issue' + (nBad > 1 ? 's' : '') + ' found' + (issues.length > nBad ? ', and ' + (issues.length - nBad) + ' to look at' : '') : issues.length + ' thing' + (issues.length > 1 ? 's' : '') + ' to look at' })
          : el('p', { class: 'mt-3 text-sm font-medium text-ok', text: v ? 'All automated checks passed.' : 'No automated result is available.' })
      ]));

      var grid = el('div', { class: 'grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]' });
      app.appendChild(grid);
      var left = el('div', { class: 'grid gap-6' });
      var right = el('div', { class: 'grid gap-6 lg:sticky lg:top-20' });
      grid.appendChild(left);
      grid.appendChild(right);

      // Documents
      var base = '/review/api/sessions/' + encodeURIComponent(s.id) + '/documents/';
      var kinds = ['ID_FRONT', 'ID_BACK', 'SELFIE'].concat(['LICENCE_FRONT', 'LICENCE_BACK'].filter(function (k) { return s.documents.indexOf(k) >= 0; }));
      var NAMES = { ID_FRONT: 'ID front', ID_BACK: 'ID back', SELFIE: 'Selfie', LICENCE_FRONT: 'Licence front', LICENCE_BACK: 'Licence back' };
      var figs = kinds.map(function (k) {
        if (k === 'SELFIE' && s.documents.indexOf(k) < 0 && v && (v.face.source === 'liveness' || v.liveness.status)) return faceCheckSlot(v);
        if (s.documents.indexOf(k) < 0) return el('figure', { class: C.figure }, [el('figcaption', { class: C.caption, text: NAMES[k] }), el('div', { class: C.missing, text: 'Not uploaded' })]);
        return el('figure', { class: C.figure }, [
          el('figcaption', { class: C.caption }, [el('span', { text: NAMES[k] }), el('a', { class: C.open, href: base + k, target: '_blank', rel: 'noopener', text: 'Open full size' })]),
          el('img', { class: C.photo, src: base + k, alt: NAMES[k] + ' photo' })
        ]);
      });
      left.appendChild(el('section', { class: C.card }, [el('h3', { class: C.h3, text: 'Documents' }), el('div', { class: C.docs }, figs)]));

      // What the company sent, to compare against the photos
      var exp = el('dl', { class: C.dl });
      function pair(k, val) { exp.appendChild(el('dt', { class: C.dt, text: k })); exp.appendChild(el('dd', { class: C.dd + (val ? '' : ' text-muted'), text: val || 'not provided' })); }
      pair('Reference', s.externalRef);
      pair('First name', s.expected.firstName);
      pair('Last name', s.expected.lastName);
      pair('Date of birth', s.expected.birthDate);
      left.appendChild(el('section', { class: C.card }, [el('h3', { class: C.h3, text: 'What was provided' }), exp]));

      // Automated checks
      var checks = el('section', { class: C.card }, [el('h3', { class: C.h3, text: 'Automated checks' })]);
      if (!v) checks.appendChild(el('p', { class: C.muted, text: 'No automated result is available.' }));
      else {
        var list = el('div', { class: 'divide-y divide-line' });
        list.appendChild(check('ID text found', bool(v.mrz.found, true), v.mrz.found ? 'Yes' : 'No'));
        // Without the text there were no check digits to test: not checked, not failed
        list.appendChild(check('ID check digits valid', v.mrz.found ? bool(v.mrz.valid, true) : 'none', v.mrz.found ? (v.mrz.valid ? 'Yes' : 'No') : 'Not checked'));
        var sn = match(v.identity.surname), gn = match(v.identity.givenNames), bd = match(v.identity.birthDate);
        list.appendChild(check('Surname', sn[0], sn[1]));
        list.appendChild(check('Given names', gn[0], gn[1]));
        list.appendChild(check('Date of birth', bd[0], bd[1]));
        list.appendChild(check('Document expiry', bool(v.expired, false), v.expired === null ? 'Not checked' : v.expired ? 'Expired' : 'Valid'));
        var f = v.face;
        list.appendChild(check('Face match' + (f.source === 'liveness' ? ' (face check)' : f.source === 'selfie' ? ' (selfie)' : ''),
          f.status === 'match' ? 'pass' : f.status ? 'fail' : 'none',
          f.status ? (f.status === 'match' ? 'Match' : f.status.replace(/_/g, ' ')) + (f.similarity !== null ? ' · ' + f.similarity.toFixed(1) + '%' : '') : 'Not checked',
          f.similarity !== null ? f.similarity : undefined));
        var l = v.liveness;
        list.appendChild(check('Liveness', l.status === 'live' ? 'pass' : l.status ? 'fail' : 'none',
          l.status ? (l.status === 'live' ? 'Live' : l.status.replace(/_/g, ' ')) + (l.confidence !== null ? ' · ' + l.confidence.toFixed(1) + '%' : '') : 'Not checked',
          l.confidence !== null ? l.confidence : undefined));
        if (v.licence) {
          var lc = v.licence;
          list.appendChild(check('Licence read', lc.found ? 'pass' : 'fail', lc.found ? 'All fields' : (lc.fields.length ? 'Only ' + lc.fields.join(', ') : 'Nothing')));
          list.appendChild(check('Licence expiry', bool(lc.expired, false), lc.expired === null ? 'Not checked' : lc.expired ? 'Expired' : 'Valid'));
          list.appendChild(check('Licence dates plausible', bool(lc.datesValid, true), lc.datesValid === null ? 'Not checked' : lc.datesValid ? 'Yes' : 'No'));
          var pn = match(lc.crossCheck.personalNumber), ls = match(lc.crossCheck.surname), lg = match(lc.crossCheck.givenNames), lb = match(lc.crossCheck.birthDate);
          list.appendChild(check('Licence personal number vs ID', pn[0], pn[1]));
          list.appendChild(check('Licence surname vs ID', ls[0], ls[1]));
          list.appendChild(check('Licence given names vs ID', lg[0], lg[1]));
          list.appendChild(check('Licence date of birth vs ID', lb[0], lb[1]));
        }
        checks.appendChild(list);
        if (issues.length) {
          checks.appendChild(el('h3', { class: C.h3 + ' mt-5', text: 'Issues' }));
          checks.appendChild(el('div', { class: 'flex flex-wrap gap-1.5' }, issues.map(chip)));
        }
      }
      right.appendChild(checks);

      // Decision
      var box = el('section', { class: C.card }, [el('h3', { class: C.h3, text: 'Decision' })]);
      if (s.status !== 'NEEDS_REVIEW') {
        box.appendChild(el('p', { text: 'This session is ' + s.status.toLowerCase().replace('_', ' ') + '.' + (s.review && s.review.reason ? ' Reason: ' + s.review.reason : '') }));
      } else {
        var reason = el('textarea', { class: C.textarea, id: 'reason', rows: '3', maxlength: '500', placeholder: 'Why you are rejecting (shared with the customer)' });
        var msg = el('p', { class: C.err, role: 'alert' });
        var approve = el('button', { class: C.approve, type: 'button' }, [icon('check'), el('span', { text: 'Approve' })]);
        var reject = el('button', { class: C.danger, type: 'button' }, [icon('cross'), el('span', { text: 'Reject' })]);
        function decide(decision) {
          if (decision === 'REJECTED' && reason.value.trim().length < 3) { msg.textContent = 'Give a reason for rejecting.'; reason.focus(); return; }
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
        box.appendChild(el('p', { class: C.small + ' mb-3', text: 'Compare the photos with what was provided and the checks above, then decide.' }));
        box.appendChild(el('label', { class: C.labelTop, for: 'reason', text: 'Reason (required to reject; shared with the customer)' }));
        box.appendChild(reason);
        box.appendChild(msg);
        box.appendChild(el('div', { class: 'mt-4 flex gap-3' }, [approve, reject]));
      }
      right.appendChild(box);
    }).catch(function (e) { if (my === gen && e.message !== 'signed-out') { holder.className = C.err; holder.textContent = 'Session not found.'; } });
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
