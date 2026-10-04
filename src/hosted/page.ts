/**
 * The hosted capture page served at /verify: three static files, no framework, no inline script or
 * style (the CSP forbids both) and nothing loaded from elsewhere. The one-time token arrives in the
 * URL fragment, which browsers never send to a server; the page moves it into sessionStorage and
 * removes it from the address bar.
 *
 * Every string from the server is written with textContent. Photos are shrunk and re-encoded as
 * JPEG in the browser before upload (phone photos are large, and this also turns HEIC/WebP into
 * something the service accepts); if the browser cannot, the original is sent when it is small enough.
 */
export const VERIFY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Identity verification</title>
<link rel="stylesheet" href="/verify/app.css">
</head>
<body>
<main id="app" aria-live="polite"></main>
<noscript><p class="wrap">This page needs JavaScript to take and send your photos.</p></noscript>
<script src="/verify/app.js"></script>
</body>
</html>`;

export const VERIFY_CSS = `
:root{color-scheme:light dark;--bg:#f5f6f8;--fg:#14171c;--card:#fff;--line:#d8dce2;--muted:#586170;--accent:#1d4ed8;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8eaee;--card:#181c22;--line:#2b313a;--muted:#98a2b0;--accent:#6d9bff;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:560px;margin:0 auto;padding:16px 16px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
h1{font-size:22px;margin:8px 0 12px}h2{font-size:18px;margin:0 0 8px}p{margin:0 0 12px}.muted{color:var(--muted)}
ul.plain{padding-left:20px;margin:0 0 12px}
.progress{display:flex;gap:6px;margin:4px 0 0}.progress span{flex:1;height:6px;border-radius:3px;background:var(--line)}
.progress span.done{background:var(--ok)}.progress span.now{background:var(--accent)}
button,label.btn{display:block;width:100%;font:inherit;font-weight:600;text-align:center;padding:14px 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;margin-top:10px}
button.primary,label.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.55;cursor:default}
button:focus-visible,label.btn:focus-within{outline:3px solid var(--accent);outline-offset:2px}
input[type=file]{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}
.preview{width:100%;max-height:360px;object-fit:contain;border-radius:8px;border:1px solid var(--line);background:#000;margin:8px 0}
.err{color:var(--bad);margin-top:12px}.ok{color:var(--ok)}
.status{margin-top:12px;color:var(--muted)}
.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}
.lang{display:flex;gap:8px;justify-content:flex-end}.lang button{width:auto;margin:0;padding:6px 10px;font-weight:400}
`;

export const VERIFY_JS = `
(function () {
  'use strict';

  var STRINGS = {
    en: {
      title: 'Verify your identity', intro: 'We need a few photos to confirm who you are. It takes about two minutes.',
      need: 'Have these ready:', needId: 'Your identity card', needLicence: 'Your driving licence', needSelfie: 'Good light for a photo of your face',
      privacy: 'Your photos are encrypted, used only to verify you, and deleted after the retention period set by the company asking you.',
      start: 'Start', step: 'Step', of: 'of', optional: 'Optional', skip: 'Skip this step',
      ID_FRONT: 'Front of your identity card', ID_BACK: 'Back of your identity card', LICENCE_FRONT: 'Front of your driving licence', LICENCE_BACK: 'Back of your driving licence', SELFIE: 'A selfie',
      ID_FRONT_HINT: 'Lay the card flat in good light. Keep all four corners in view and avoid glare.',
      ID_BACK_HINT: 'Show the whole back, including the three lines of letters and numbers at the bottom.',
      LICENCE_FRONT_HINT: 'Lay the licence flat in good light with every corner in view and no glare.',
      LICENCE_BACK_HINT: 'Show the whole back of the licence.',
      SELFIE_HINT: 'Look straight at the camera in good light. Only your face should be in the picture, with no hat or sunglasses.',
      takePhoto: 'Take a photo', choosePhoto: 'Choose a photo', useThis: 'Use this photo', retake: 'Choose another',
      uploading: 'Sending…', uploaded: 'Sent', review: 'Almost done', reviewText: 'Check that everything below was sent, then submit.', submit: 'Submit for verification', submitting: 'Submitting…',
      doneTitle: 'Thank you', doneText: 'Your photos were sent for verification. You can close this page now.',
      closedTitle: 'This link cannot be used', closed: 'It has expired or was already used. Ask the company that sent it for a new link.',
      invalidTitle: 'Link not found', invalid: 'Open the link exactly as you received it, or ask for a new one.',
      tooLarge: 'That photo is too large. Try a different one.', notImage: 'We could not read that file as a photo. Try taking a new photo.',
      network: 'The connection failed. Check your internet and try again.', rate: 'Too many attempts. Wait a minute and try again.', generic: 'Something went wrong. Please try again.',
      missing: 'Some required photos are missing.', language: 'Language', alreadySent: 'Already sent ✓ — continue'
    },
    sq: {
      title: 'Verifikoni identitetin tuaj', intro: 'Na duhen disa fotografi për të konfirmuar kush jeni. Zgjat rreth dy minuta.',
      need: 'Përgatitni këto:', needId: 'Letërnjoftimin tuaj', needLicence: 'Patentë-shoferin tuaj', needSelfie: 'Dritë të mirë për një foto të fytyrës',
      privacy: 'Fotografitë tuaja janë të enkriptuara, përdoren vetëm për verifikimin tuaj dhe fshihen pas periudhës së ruajtjes që ka caktuar kompania që po ju kërkon.',
      start: 'Fillo', step: 'Hapi', of: 'nga', optional: 'Opsionale', skip: 'Kapërce këtë hap',
      ID_FRONT: 'Pjesa e përparme e letërnjoftimit', ID_BACK: 'Pjesa e pasme e letërnjoftimit', LICENCE_FRONT: 'Pjesa e përparme e patentë-shoferit', LICENCE_BACK: 'Pjesa e pasme e patentë-shoferit', SELFIE: 'Një selfi',
      ID_FRONT_HINT: 'Vendoseni kartën të shtrirë në dritë të mirë. Mbani të katër këndet në pamje dhe shmangni reflektimin.',
      ID_BACK_HINT: 'Tregoni pjesën e pasme të plotë, përfshirë tri rreshtat me shkronja dhe numra në fund.',
      LICENCE_FRONT_HINT: 'Vendoseni patentën e shtrirë në dritë të mirë, me të gjitha këndet në pamje dhe pa reflektim.',
      LICENCE_BACK_HINT: 'Tregoni pjesën e pasme të plotë të patentës.',
      SELFIE_HINT: 'Shikoni drejt kamerës në dritë të mirë. Në foto duhet të jetë vetëm fytyra juaj, pa kapelë apo syze dielli.',
      takePhoto: 'Bëj një foto', choosePhoto: 'Zgjidh një foto', useThis: 'Përdor këtë foto', retake: 'Zgjidh një tjetër',
      uploading: 'Po dërgohet…', uploaded: 'U dërgua', review: 'Pothuajse mbaruam', reviewText: 'Kontrolloni që gjithçka më poshtë u dërgua, pastaj dërgoni.', submit: 'Dërgo për verifikim', submitting: 'Po dërgohet…',
      doneTitle: 'Faleminderit', doneText: 'Fotografitë tuaja u dërguan për verifikim. Tani mund ta mbyllni këtë faqe.',
      closedTitle: 'Kjo lidhje nuk mund të përdoret', closed: 'Ka skaduar ose është përdorur tashmë. Kërkoni një lidhje të re nga kompania që ju e dërgoi.',
      invalidTitle: 'Lidhja nuk u gjet', invalid: 'Hapeni lidhjen saktësisht ashtu siç e morët, ose kërkoni një të re.',
      tooLarge: 'Ajo foto është shumë e madhe. Provoni një tjetër.', notImage: 'Nuk e lexuam atë skedar si foto. Provoni të bëni një foto të re.',
      network: 'Lidhja dështoi. Kontrolloni internetin dhe provoni përsëri.', rate: 'Shumë përpjekje. Prisni një minutë dhe provoni përsëri.', generic: 'Diçka shkoi keq. Ju lutemi provoni përsëri.',
      missing: 'Mungojnë disa fotografi të detyrueshme.', language: 'Gjuha', alreadySent: 'Tashmë u dërgua ✓ — vazhdo'
    },
    sr: {
      title: 'Potvrdite svoj identitet', intro: 'Potrebno je nekoliko fotografija da potvrdimo ko ste. Traje oko dva minuta.',
      need: 'Pripremite:', needId: 'Vašu ličnu kartu', needLicence: 'Vašu vozačku dozvolu', needSelfie: 'Dobro svetlo za fotografiju lica',
      privacy: 'Vaše fotografije su šifrovane, koriste se samo za vašu proveru i brišu se nakon perioda čuvanja koji je odredila kompanija koja to traži.',
      start: 'Počni', step: 'Korak', of: 'od', optional: 'Opciono', skip: 'Preskoči ovaj korak',
      ID_FRONT: 'Prednja strana lične karte', ID_BACK: 'Zadnja strana lične karte', LICENCE_FRONT: 'Prednja strana vozačke dozvole', LICENCE_BACK: 'Zadnja strana vozačke dozvole', SELFIE: 'Selfi',
      ID_FRONT_HINT: 'Stavite kartu ravno na dobro osvetljenje. Neka sva četiri ugla budu u kadru i izbegavajte odsjaj.',
      ID_BACK_HINT: 'Pokažite celu zadnju stranu, uključujući tri reda slova i brojeva pri dnu.',
      LICENCE_FRONT_HINT: 'Stavite dozvolu ravno na dobro svetlo, sa svim uglovima u kadru i bez odsjaja.',
      LICENCE_BACK_HINT: 'Pokažite celu zadnju stranu dozvole.',
      SELFIE_HINT: 'Gledajte pravo u kameru na dobrom svetlu. Na slici treba da bude samo vaše lice, bez šešira i sunčanih naočara.',
      takePhoto: 'Slikaj', choosePhoto: 'Izaberi fotografiju', useThis: 'Koristi ovu fotografiju', retake: 'Izaberi drugu',
      uploading: 'Šalje se…', uploaded: 'Poslato', review: 'Skoro gotovo', reviewText: 'Proverite da je sve ispod poslato, pa pošaljite.', submit: 'Pošalji na proveru', submitting: 'Šalje se…',
      doneTitle: 'Hvala', doneText: 'Vaše fotografije su poslate na proveru. Sada možete zatvoriti ovu stranicu.',
      closedTitle: 'Ova veza se ne može koristiti', closed: 'Istekla je ili je već iskorišćena. Zatražite novu vezu od kompanije koja vam je poslala.',
      invalidTitle: 'Veza nije pronađena', invalid: 'Otvorite vezu tačno onako kako ste je dobili ili zatražite novu.',
      tooLarge: 'Ta fotografija je prevelika. Pokušajte drugu.', notImage: 'Nismo mogli da pročitamo taj fajl kao fotografiju. Pokušajte da napravite novu.',
      network: 'Veza je pala. Proverite internet i pokušajte ponovo.', rate: 'Previše pokušaja. Sačekajte minut i pokušajte ponovo.', generic: 'Nešto nije u redu. Pokušajte ponovo.',
      missing: 'Nedostaju neke obavezne fotografije.', language: 'Jezik', alreadySent: 'Već poslato ✓ — nastavi'
    }
  };

  var MAX_EDGE = 2000;
  var MAX_BYTES = 7 * 1024 * 1024; // the service accepts 8 MB
  var app = document.getElementById('app');
  var lang = pickLanguage();
  var state = { token: null, steps: [], index: 0, uploaded: {}, picked: null, busy: false };

  function t(key) { return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key; }

  function pickLanguage() {
    var q = /[?&]lang=(en|sq|sr)\\b/.exec(location.search);
    if (q) return q[1];
    try { var saved = sessionStorage.getItem('verify-lang'); if (saved && STRINGS[saved]) return saved; } catch (e) { /* storage blocked */ }
    var nav = ((navigator.languages && navigator.languages[0]) || navigator.language || 'en').toLowerCase();
    if (nav.indexOf('sq') === 0) return 'sq';
    if (nav.indexOf('sr') === 0 || nav.indexOf('bs') === 0 || nav.indexOf('hr') === 0) return 'sr';
    return 'en';
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
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function render(nodes) {
    clear();
    var lg = el('div', { class: 'lang', role: 'group', 'aria-label': t('language') }, ['en', 'sq', 'sr'].map(function (code) {
      return el('button', { type: 'button', text: code.toUpperCase(), 'aria-pressed': String(code === lang), onclick: function () {
        lang = code; document.documentElement.lang = code;
        try { sessionStorage.setItem('verify-lang', code); } catch (e) { /* ignore */ }
        show();
      } });
    }));
    app.appendChild(lg);
    nodes.forEach(function (n) { app.appendChild(n); });
    var h = app.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  // ---- talking to the service (same origin) -------------------------------------------------
  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body) opts.body = body;
    return fetch('/v1/upload/' + encodeURIComponent(state.token) + path, opts).then(function (res) {
      if (res.status === 204) return { status: 204, data: null };
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    });
  }

  // Retries only what is safe to retry: a dropped connection, a busy or failing server.
  function withRetry(fn) {
    var attempt = 0;
    function go() {
      return fn().then(function (r) {
        if ((r.status >= 500 || r.status === 429) && attempt < 3) { attempt++; return wait(400 * Math.pow(2, attempt)).then(go); }
        return r;
      }, function (err) {
        if (attempt < 3) { attempt++; return wait(400 * Math.pow(2, attempt)).then(go); }
        throw err;
      });
    }
    return go();
  }

  function messageFor(status) {
    if (status === 413) return t('tooLarge');
    if (status === 400) return t('notImage');
    if (status === 429) return t('rate');
    return t('generic');
  }

  // ---- photo preparation ----------------------------------------------------------------------
  function prepare(file) {
    if (!window.createImageBitmap) return Promise.resolve(fallback(file));
    var bitmapPromise;
    try { bitmapPromise = createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bitmapPromise = createImageBitmap(file); }
    return bitmapPromise.then(function (bmp) {
      var scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) { if (bmp.close) bmp.close(); return fallback(file); }
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
      return toJpeg(canvas, 0.85).then(function (blob) {
        if (blob && blob.size > MAX_BYTES) return toJpeg(canvas, 0.6);
        return blob;
      }).then(function (blob) { return blob || fallback(file); });
    }, function () { return fallback(file); });
  }
  function toJpeg(canvas, quality) {
    return new Promise(function (resolve) { canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality); });
  }
  // The browser could not re-encode it: send the original only if the service would take it
  function fallback(file) {
    if (file.size > MAX_BYTES) throw Object.assign(new Error('too large'), { userMessage: t('tooLarge') });
    if (!/^image\\/(jpeg|png|webp)$/.test(file.type)) throw Object.assign(new Error('not an image'), { userMessage: t('notImage') });
    return file;
  }

  // ---- screens ---------------------------------------------------------------------------------
  function show() {
    var steps = state.steps;
    if (state.screen === 'fatal') return showFatal(state.fatal[0], state.fatal[1]);
    if (state.screen === 'done') return showDone();
    if (state.screen === 'review') return showReview();
    if (state.screen === 'step' && state.index < steps.length) return showStep();
    return showIntro();
  }

  // Keys, not text, so switching language re-renders the same message in the new language
  function showFatal(titleKey, textKey) {
    state.screen = 'fatal';
    state.fatal = [titleKey, textKey];
    render([el('div', { class: 'card' }, [el('h1', { text: t(titleKey) }), textKey ? el('p', { text: t(textKey) }) : null])]);
  }

  function showIntro() {
    var needs = [t('needId')];
    if (state.steps.some(function (s) { return s.kind === 'LICENCE_FRONT'; })) needs.push(t('needLicence'));
    needs.push(t('needSelfie'));
    render([el('div', { class: 'card' }, [
      el('h1', { text: t('title') }),
      el('p', { text: t('intro') }),
      el('p', { class: 'muted', text: t('need') }),
      el('ul', { class: 'plain' }, needs.map(function (n) { return el('li', { text: n }); })),
      el('p', { class: 'muted', text: t('privacy') }),
      el('button', { class: 'primary', type: 'button', text: t('start'), onclick: function () { state.screen = 'step'; state.index = firstOpen(); show(); } })
    ])]);
  }

  function firstOpen() {
    for (var i = 0; i < state.steps.length; i++) if (!state.uploaded[state.steps[i].kind]) return i;
    return state.steps.length;
  }

  function showStep() {
    var step = state.steps[state.index];
    var kind = step.kind;
    var err = el('p', { class: 'err', role: 'alert' });
    var status = el('p', { class: 'status' });
    var preview = el('img', { class: 'preview', alt: '', hidden: '' });
    var useBtn = el('button', { class: 'primary', type: 'button', text: t('useThis'), hidden: '' });
    var capture = kind === 'SELFIE' ? 'user' : 'environment';

    function picker(label, withCapture, primary) {
      var input = el('input', { type: 'file', accept: 'image/*' });
      if (withCapture) input.setAttribute('capture', capture);
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        err.textContent = '';
        state.picked = file;
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(file);
        preview.hidden = false;
        useBtn.hidden = false;
        input.value = '';
      });
      return el('label', { class: 'btn' + (primary ? ' primary' : '') }, [document.createTextNode(label), input]);
    }

    useBtn.addEventListener('click', function () {
      if (state.busy || !state.picked) return;
      state.busy = true; useBtn.disabled = true; err.textContent = ''; status.textContent = t('uploading');
      // Through a promise, so a synchronous failure inside prepare() is caught like any other
      Promise.resolve().then(function () { return prepare(state.picked); }).then(function (blob) {
        var fd = new FormData();
        fd.append('file', blob, kind.toLowerCase() + '.jpg');
        return withRetry(function () { return api('POST', '/' + kind, fd); });
      }).then(function (r) {
        if (r.status === 204) { state.uploaded[kind] = true; state.picked = null; state.busy = false; next(); return; }
        if (r.status === 404) return showFatal('invalidTitle', 'invalid');
        if (r.status === 410) return showFatal('closedTitle', 'closed');
        throw Object.assign(new Error('rejected'), { userMessage: messageFor(r.status) });
      }).catch(function (e) {
        state.busy = false; useBtn.disabled = false; status.textContent = '';
        err.textContent = e && e.userMessage ? e.userMessage : t('network');
      });
    });

    var pos = state.index + 1;
    var bar = el('div', { class: 'progress', 'aria-hidden': 'true' }, state.steps.map(function (s, i) {
      return el('span', { class: state.uploaded[s.kind] ? 'done' : (i === state.index ? 'now' : '') });
    }));
    render([el('div', { class: 'card' }, [
      el('p', { class: 'muted', text: t('step') + ' ' + pos + ' ' + t('of') + ' ' + state.steps.length + (step.required ? '' : ' · ' + t('optional')) }),
      bar,
      el('h1', { text: t(kind) }),
      el('p', { text: t(kind + '_HINT') }),
      preview,
      useBtn,
      picker(t('takePhoto'), true, true),
      picker(t('choosePhoto'), false, false),
      state.uploaded[kind] ? el('button', { type: 'button', text: t('alreadySent'), onclick: next }) : null,
      step.required ? null : el('button', { type: 'button', text: t('skip'), onclick: next }),
      status, err
    ])]);
  }

  function next() { state.index++; if (state.index >= state.steps.length) { state.screen = 'review'; } else { state.screen = 'step'; } show(); }

  function showReview() {
    var missing = state.steps.some(function (s) { return s.required && !state.uploaded[s.kind]; });
    var err = el('p', { class: 'err', role: 'alert', text: missing ? t('missing') : '' });
    var btn = el('button', { class: 'primary', type: 'button', text: t('submit') });
    btn.disabled = missing;
    btn.addEventListener('click', function () {
      if (state.busy) return;
      state.busy = true; btn.disabled = true; btn.textContent = t('submitting'); err.textContent = '';
      withRetry(function () { return api('POST', '/submit'); }).then(function (r) {
        state.busy = false;
        if (r.status === 200) { state.screen = 'done'; return show(); }
        if (r.status === 404) return showFatal('invalidTitle', 'invalid');
        if (r.status === 410) return showFatal('closedTitle', 'closed');
        btn.disabled = false; btn.textContent = t('submit');
        err.textContent = r.status === 400 ? t('missing') : messageFor(r.status);
      }).catch(function () { state.busy = false; btn.disabled = false; btn.textContent = t('submit'); err.textContent = t('network'); });
    });
    render([el('div', { class: 'card' }, [
      el('h1', { text: t('review') }),
      el('p', { text: t('reviewText') }),
      el('div', {}, state.steps.map(function (s) {
        return el('div', { class: 'row' }, [el('span', { text: t(s.kind) }), el('span', { class: state.uploaded[s.kind] ? 'ok' : 'muted', text: state.uploaded[s.kind] ? '✓ ' + t('uploaded') : (s.required ? '—' : t('optional')) })]);
      })),
      btn, err,
      el('button', { type: 'button', text: t('retake'), onclick: function () { state.screen = 'step'; state.index = 0; show(); } })
    ])]);
  }

  function showDone() {
    state.screen = 'done';
    try { sessionStorage.removeItem('verify-token'); } catch (e) { /* ignore */ }
    render([el('div', { class: 'card' }, [el('h1', { text: t('doneTitle') }), el('p', { text: t('doneText') })])]);
  }

  // ---- start -----------------------------------------------------------------------------------
  function readToken() {
    var fromHash = location.hash.replace(/^#/, '');
    if (/^[A-Za-z0-9_-]{20,120}$/.test(fromHash)) {
      try { sessionStorage.setItem('verify-token', fromHash); } catch (e) { /* ignore */ }
      // Remove the token from the address bar, history and anything that copies the URL
      history.replaceState(null, '', location.pathname + location.search);
      return fromHash;
    }
    try { return sessionStorage.getItem('verify-token'); } catch (e) { return null; }
  }

  function start() {
    state.token = readToken();
    document.documentElement.lang = lang;
    if (!state.token) return showFatal('invalidTitle', 'invalid');
    api('GET', '').then(function (r) {
      if (r.status === 404) return showFatal('invalidTitle', 'invalid');
      if (r.status === 410) return showFatal('closedTitle', 'closed');
      if (r.status !== 200) return showFatal('invalidTitle', 'generic');
      state.steps = r.data.steps;
      (r.data.uploaded || []).forEach(function (k) { state.uploaded[k] = true; });
      state.screen = 'intro';
      show();
    }).catch(function () { showFatal('network', null); });
  }

  start();
})();
`;
