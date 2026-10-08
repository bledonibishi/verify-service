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
<header class="mx-auto flex max-w-[520px] items-center justify-between gap-3 px-4 pt-4" id="top"></header>
<main class="mx-auto max-w-[520px] px-4 pt-3 pb-8" id="app" aria-live="polite"></main>
<noscript><p class="p-4">This page needs JavaScript to take and send your photos.</p></noscript>
<script src="/verify/app.js"></script>
</body>
</html>`;

// The stylesheet is built by Tailwind from tailwind.css and the class names below (hosted-dist/app.css).

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
      missing: 'Some required photos are missing.', language: 'Language', alreadySent: 'Already sent ✓ — continue', tryAgain: 'Try again', trouble: 'We cannot reach the service',
      LIVENESS: 'Face check', LIVENESS_HINT: 'A short video check that you are really here: look at the camera and follow the instructions. It takes a few seconds. Find good light first.',
      startCheck: 'Start the face check', selfieInstead: 'Cannot do the face check? Send a selfie instead', checkDone: 'Face check done ✓ — continue', needFace: 'A few seconds for a face check with your camera',
      brand: 'Secure identity check', foot: 'Encrypted · used only to verify you', minutes: 'About 2 minutes', takeAnother: 'Take another', chooseAnother: 'Choose another', sent: 'Sent', notSent: 'Not sent yet',
      ID_FRONT_TIPS: ['All four corners in the picture', 'No glare or shadow on the card', 'The text is sharp and readable'],
      ID_BACK_TIPS: ['The whole back in the picture', 'The three lines at the bottom are sharp', 'No glare on the card'],
      LICENCE_FRONT_TIPS: ['All four corners in the picture', 'No glare or shadow', 'The text is sharp and readable'],
      LICENCE_BACK_TIPS: ['The whole back in the picture', 'No glare or shadow'],
      SELFIE_TIPS: ['Face the camera in good light', 'No hat or sunglasses', 'Only your face in the picture'],
      LIVENESS_TIPS: ['Find good, even light', 'Take off sunglasses and hats', 'Move closer when asked, then hold still']
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
      missing: 'Mungojnë disa fotografi të detyrueshme.', language: 'Gjuha', alreadySent: 'Tashmë u dërgua ✓ — vazhdo', tryAgain: 'Provo përsëri', trouble: 'Nuk mund të lidhemi me shërbimin',
      LIVENESS: 'Kontrolli i fytyrës', LIVENESS_HINT: 'Një kontroll i shkurtër me video se jeni vërtet aty: shikoni kamerën dhe ndiqni udhëzimet. Zgjat disa sekonda. Gjeni më parë dritë të mirë.',
      startCheck: 'Fillo kontrollin e fytyrës', selfieInstead: 'Nuk mund ta bëni kontrollin e fytyrës? Dërgoni një selfi', checkDone: 'Kontrolli i fytyrës u krye ✓ — vazhdo', needFace: 'Disa sekonda për një kontroll të fytyrës me kamerën tuaj',
      brand: 'Verifikim i sigurt i identitetit', foot: 'I enkriptuar · përdoret vetëm për verifikimin tuaj', minutes: 'Rreth 2 minuta', takeAnother: 'Bëj një tjetër', chooseAnother: 'Zgjidh një tjetër', sent: 'U dërgua', notSent: 'Ende pa u dërguar',
      ID_FRONT_TIPS: ['Të katër këndet në foto', 'Pa reflektim apo hije mbi kartë', 'Teksti i qartë dhe i lexueshëm'],
      ID_BACK_TIPS: ['E gjithë pjesa e pasme në foto', 'Tri rreshtat në fund të qartë', 'Pa reflektim mbi kartë'],
      LICENCE_FRONT_TIPS: ['Të katër këndet në foto', 'Pa reflektim apo hije', 'Teksti i qartë dhe i lexueshëm'],
      LICENCE_BACK_TIPS: ['E gjithë pjesa e pasme në foto', 'Pa reflektim apo hije'],
      SELFIE_TIPS: ['Shikoni kamerën në dritë të mirë', 'Pa kapelë apo syze dielli', 'Vetëm fytyra juaj në foto'],
      LIVENESS_TIPS: ['Gjeni dritë të mirë e të njëtrajtshme', 'Hiqni syzet e diellit dhe kapelën', 'Afrohuni kur t’ju kërkohet, pastaj rrini pa lëvizur']
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
      missing: 'Nedostaju neke obavezne fotografije.', language: 'Jezik', alreadySent: 'Već poslato ✓ — nastavi', tryAgain: 'Pokušaj ponovo', trouble: 'Ne možemo da se povežemo sa servisom',
      LIVENESS: 'Provera lica', LIVENESS_HINT: 'Kratka video provera da ste zaista tu: gledajte u kameru i pratite uputstva. Traje nekoliko sekundi. Prvo nađite dobro svetlo.',
      startCheck: 'Počni proveru lica', selfieInstead: 'Ne možete da uradite proveru lica? Pošaljite selfi', checkDone: 'Provera lica završena ✓ — nastavi', needFace: 'Nekoliko sekundi za proveru lica kamerom',
      brand: 'Bezbedna provera identiteta', foot: 'Šifrovano · koristi se samo za vašu proveru', minutes: 'Oko 2 minuta', takeAnother: 'Slikaj ponovo', chooseAnother: 'Izaberi drugu', sent: 'Poslato', notSent: 'Još nije poslato',
      ID_FRONT_TIPS: ['Sva četiri ugla na slici', 'Bez odsjaja i senke na karti', 'Tekst je oštar i čitljiv'],
      ID_BACK_TIPS: ['Cela zadnja strana na slici', 'Tri reda pri dnu su oštra', 'Bez odsjaja na karti'],
      LICENCE_FRONT_TIPS: ['Sva četiri ugla na slici', 'Bez odsjaja i senke', 'Tekst je oštar i čitljiv'],
      LICENCE_BACK_TIPS: ['Cela zadnja strana na slici', 'Bez odsjaja i senke'],
      SELFIE_TIPS: ['Gledajte u kameru na dobrom svetlu', 'Bez šešira i sunčanih naočara', 'Samo vaše lice na slici'],
      LIVENESS_TIPS: ['Nađite dobro, ravnomerno svetlo', 'Skinite sunčane naočare i šešir', 'Približite se kada se zatraži, pa se ne pomerajte']
    }
  };


  // Tailwind classes (built into /verify/app.css by the Tailwind CLI; see tailwind.css). Kept as
  // whole literal strings so the build finds them. The first word of some is a plain marker
  // (btn, primary, preview) that the tests and scripts select by.
  var C = {
    card: 'mt-3 rounded-2xl border border-line bg-card p-7 shadow-card max-sm:px-[18px] max-sm:py-[22px]',
    h1: 'mb-2 text-2xl leading-tight font-bold tracking-tight focus:outline-none',
    muted: 'mb-3 text-muted',
    smallMuted: 'mb-3 text-sm text-muted',
    art: 'mb-5 flex h-[132px] items-center justify-center rounded-[14px] bg-accent-weak text-accent [&_svg]:size-28',
    artOk: 'mb-5 flex h-[132px] items-center justify-center rounded-[14px] bg-ok-weak text-ok [&_svg]:size-28',
    artBad: 'mb-5 flex h-[132px] items-center justify-center rounded-[14px] bg-bad-weak text-bad [&_svg]:size-28',
    tips: 'mt-1 mb-5',
    tip: 'flex items-start gap-2.5 py-1.5 [&_svg]:mt-0.5 [&_svg]:size-5 [&_svg]:flex-none [&_svg]:text-ok',
    progress: 'progress mb-[22px] flex gap-1.5',
    seg: 'h-[5px] flex-1 rounded-sm bg-line',
    segDone: 'done h-[5px] flex-1 rounded-sm bg-ok',
    segNow: 'now h-[5px] flex-1 rounded-sm bg-accent',
    stepline: 'mb-2.5 flex items-center justify-between text-[13px] font-semibold tracking-wider text-muted uppercase',
    badge: 'rounded-full border border-line bg-soft px-2.5 py-0.5 text-xs font-semibold tracking-normal normal-case',
    brand: 'flex items-center gap-2 text-[15px] font-semibold text-muted [&_svg]:size-5 [&_svg]:text-accent',
    lang: 'inline-flex rounded-full border border-line bg-card p-[3px]',
    langBtn: 'cursor-pointer rounded-full px-3 py-1 text-[13px] font-semibold text-muted aria-pressed:bg-accent-weak aria-pressed:text-accent-ink',
    foot: 'mt-[18px] flex items-center justify-center gap-1.5 text-[13px] text-muted [&_svg]:size-3.5',
    actions: 'mt-2 grid gap-2.5',
    need: 'mb-[18px] grid gap-2.5',
    needItem: 'flex items-center gap-3 rounded-xl border border-line bg-soft px-3.5 py-3 [&_svg]:size-7 [&_svg]:flex-none [&_svg]:text-accent',
    note: 'mb-[18px] flex items-start gap-2.5 rounded-xl bg-soft px-3.5 py-3 text-sm text-muted [&_svg]:mt-0.5 [&_svg]:size-[18px] [&_svg]:flex-none',
    primary: 'btn primary flex min-h-[52px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-[18px] py-3 text-center font-semibold text-on-accent no-underline transition-colors hover:border-accent-hover hover:bg-accent-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-accent disabled:cursor-default disabled:opacity-50 [&_svg]:size-5',
    secondary: 'btn flex min-h-[52px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-card px-[18px] py-3 text-center font-semibold text-fg no-underline transition-colors hover:border-muted focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-accent disabled:cursor-default disabled:opacity-50 [&_svg]:size-5',
    link: 'link min-h-11 w-full cursor-pointer font-semibold text-accent hover:underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent',
    fileInput: 'sr-only',
    preview: 'preview mb-4 block max-h-[300px] w-full rounded-xl border border-line bg-[#0b0f15] object-contain',
    err: 'mt-3 text-bad empty:hidden',
    status: 'mt-3 text-center text-muted empty:hidden',
    rows: 'mt-2 mb-[18px] divide-y divide-line overflow-hidden rounded-xl border border-line',
    row: 'flex items-center justify-between gap-3 px-4 py-3.5',
    stateOk: 'flex items-center gap-1.5 text-sm font-semibold text-ok [&_svg]:size-[18px]',
    stateTodo: 'flex items-center gap-1.5 text-sm font-semibold text-muted [&_svg]:size-[18px]'
  };

  var MAX_EDGE = 2000;
  var MAX_BYTES = 7 * 1024 * 1024; // the service accepts 8 MB
  var app = document.getElementById('app');
  var lang = pickLanguage();
  var state = { token: null, steps: [], index: 0, uploaded: {}, picked: null, busy: false, liveness: false, selfieInstead: false };

  function t(key) { return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key; }
  function tips(key) { var v = (STRINGS[lang] && STRINGS[lang][key + '_TIPS']) || STRINGS.en[key + '_TIPS']; return Array.isArray(v) ? v : []; }

  // Line drawings built from the DOM (no markup strings): [element, attributes] pairs
  var ICONS = {
    shield: [24, [['path', { d: 'M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z' }]]],
    check: [24, [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.6 2.6L16 9.6' }]]],
    lock: [24, [['rect', { x: 5, y: 10.5, width: 14, height: 9.5, rx: 2 }], ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }]]],
    card: [24, [['rect', { x: 3, y: 6, width: 18, height: 12, rx: 2.5 }], ['circle', { cx: 8.5, cy: 11, r: 1.8 }], ['path', { d: 'M13 10h4.5M13 13.5h3M6 15.5h5' }]]],
    face: [24, [['circle', { cx: 12, cy: 10, r: 4 }], ['path', { d: 'M4.5 20c1.6-3.2 4.3-4.8 7.5-4.8s5.9 1.6 7.5 4.8' }]]],
    camera: [24, [['path', { d: 'M4 8.5h3.2L9 6.5h6l1.8 2H20V18H4z' }], ['circle', { cx: 12, cy: 13, r: 3.2 }]]],
    image: [24, [['rect', { x: 3.5, y: 5, width: 17, height: 14, rx: 2.5 }], ['path', { d: 'M3.5 15.5l4.5-4.5 4 4 2.5-2.5 6 6' }], ['circle', { cx: 15.5, cy: 9.5, r: 1.4 }]]],
    dash: [24, [['path', { d: 'M7 12h10' }]]],
    ID_FRONT: [120, [['rect', { x: 14, y: 28, width: 92, height: 64, rx: 10 }], ['circle', { cx: 40, cy: 54, r: 9 }], ['path', { d: 'M27 79c2.6-7 7.4-10.5 13-10.5S50.4 72 53 79M64 48h28M64 60h20M64 72h26' }]]],
    ID_BACK: [120, [['rect', { x: 14, y: 28, width: 92, height: 64, rx: 10 }], ['path', { d: 'M26 42h40M26 52h26' }], ['path', { d: 'M24 68h72M24 76h72M24 84h52', 'stroke-dasharray': '4 3' }]]],
    LICENCE_FRONT: [120, [['rect', { x: 14, y: 28, width: 92, height: 64, rx: 10 }], ['path', { d: 'M14 42h92' }], ['circle', { cx: 38, cy: 62, r: 8 }], ['path', { d: 'M27 84c2.3-6 6.3-9 11-9s8.7 3 11 9M62 58h30M62 70h22' }]]],
    LICENCE_BACK: [120, [['rect', { x: 14, y: 28, width: 92, height: 64, rx: 10 }], ['path', { d: 'M26 44h68M26 56h68M26 68h68M26 80h40' }]]],
    SELFIE: [120, [['path', { d: 'M32 18h-8a8 8 0 0 0-8 8v8M88 18h8a8 8 0 0 1 8 8v8M32 102h-8a8 8 0 0 1-8-8v-8M88 102h8a8 8 0 0 0 8-8v-8' }], ['ellipse', { cx: 60, cy: 57, rx: 21, ry: 27 }], ['path', { d: 'M51 52v1M69 52v1M53 68c4.5 3.6 9.5 3.6 14 0' }]]],
    LIVENESS: [120, [['path', { d: 'M32 18h-8a8 8 0 0 0-8 8v8M88 18h8a8 8 0 0 1 8 8v8M32 102h-8a8 8 0 0 1-8-8v-8M88 102h8a8 8 0 0 0 8-8v-8' }], ['ellipse', { cx: 60, cy: 57, rx: 21, ry: 27 }], ['path', { d: 'M51 52v1M69 52v1M53 68c4.5 3.6 9.5 3.6 14 0' }], ['path', { d: 'M22 60h10M88 60h10', 'stroke-dasharray': '2 3' }]]],
    START: [120, [['path', { d: 'M60 14l34 14v26c0 24-15 42-34 50-19-8-34-26-34-50V28z' }], ['path', { d: 'M46 59l10 10 20-22' }]]],
    DONE: [120, [['circle', { cx: 60, cy: 60, r: 38 }], ['path', { d: 'M43 61l11 11 23-25' }]]],
    ALERT: [120, [['circle', { cx: 60, cy: 60, r: 38 }], ['path', { d: 'M60 40v26M60 79v1' }]]]
  };
  function icon(name) {
    var spec = ICONS[name] || ICONS.card;
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + spec[0] + ' ' + spec[0]);
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', spec[0] > 24 ? '3' : '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    spec[1].forEach(function (part) {
      var n = document.createElementNS(NS, part[0]);
      Object.keys(part[1]).forEach(function (k) { n.setAttribute(k, String(part[1][k])); });
      svg.appendChild(n);
    });
    return svg;
  }
  function art(name, tone) { return el('div', { class: tone === 'ok' ? C.artOk : tone === 'bad' ? C.artBad : C.art }, [icon(name)]); }
  function tipList(key) {
    var list = tips(key);
    return list.length ? el('ul', { class: C.tips }, list.map(function (x) { return el('li', { class: C.tip }, [icon('check'), el('span', { text: x })]); })) : null;
  }
  function progress(index) {
    return el('div', { class: C.progress, 'aria-hidden': 'true' }, state.steps.map(function (s, i) {
      return el('span', { class: state.uploaded[s.kind] ? C.segDone : (i === index ? C.segNow : C.seg) });
    }));
  }
  function stepLine(index, optional) {
    return el('div', { class: C.stepline }, [
      el('span', { text: t('step') + ' ' + (index + 1) + ' ' + t('of') + ' ' + state.steps.length }),
      optional ? el('span', { class: C.badge, text: t('optional') }) : null
    ]);
  }

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
    var top = document.getElementById('top');
    if (top) {
      while (top.firstChild) top.removeChild(top.firstChild);
      top.appendChild(el('div', { class: C.brand }, [icon('shield'), el('span', { text: t('brand') })]));
      top.appendChild(el('div', { class: C.lang, role: 'group', 'aria-label': t('language') }, ['en', 'sq', 'sr'].map(function (code) {
        return el('button', { class: C.langBtn, type: 'button', text: code.toUpperCase(), 'aria-pressed': String(code === lang), onclick: function () {
          lang = code; document.documentElement.lang = code;
          try { sessionStorage.setItem('verify-lang', code); } catch (e) { /* ignore */ }
          show();
        } });
      })));
    }
    nodes.forEach(function (n) { app.appendChild(n); });
    app.appendChild(el('p', { class: C.foot }, [icon('lock'), el('span', { text: t('foot') })]));
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
    if (state.screen === 'fatal') return showFatal(state.fatal[0], state.fatal[1], state.fatal[2]);
    if (state.screen === 'done') return showDone();
    if (state.screen === 'review') return showReview();
    if (state.screen === 'step' && state.index < steps.length) return showStep();
    return showIntro();
  }

  // Keys, not text, so switching language re-renders the same message in the new language
  function showFatal(titleKey, textKey, retry) {
    state.screen = 'fatal';
    state.fatal = [titleKey, textKey, retry];
    render([el('div', { class: C.card }, [
      art('ALERT', 'bad'),
      el('h1', { class: C.h1, text: t(titleKey) }),
      textKey ? el('p', { class: C.muted, text: t(textKey) }) : null,
      retry ? el('div', { class: C.actions }, [el('button', { class: C.primary, type: 'button', text: t('tryAgain'), onclick: retry })]) : null
    ])]);
  }

  function showIntro() {
    var needs = [['card', t('needId')]];
    if (state.steps.some(function (s) { return s.kind === 'LICENCE_FRONT'; })) needs.push(['card', t('needLicence')]);
    needs.push(['face', state.liveness && !state.selfieInstead ? t('needFace') : t('needSelfie')]);
    render([el('div', { class: C.card }, [
      art('START'),
      el('h1', { class: C.h1, text: t('title') }),
      el('p', { class: C.muted, text: t('intro') }),
      el('p', { class: C.smallMuted, text: t('need') }),
      el('ul', { class: C.need }, needs.map(function (n) { return el('li', { class: C.needItem }, [icon(n[0]), el('span', { text: n[1] })]); })),
      el('div', { class: C.note }, [icon('lock'), el('span', { text: t('privacy') })]),
      el('div', { class: C.actions }, [el('button', { class: C.primary, type: 'button', text: t('start'), onclick: begin })])
    ])]);
  }

  // Everything already uploaded (a reload after the last photo): go straight to the review screen
  function begin() {
    state.index = firstOpen();
    state.screen = state.index >= state.steps.length ? 'review' : 'step';
    show();
  }

  function firstOpen() {
    for (var i = 0; i < state.steps.length; i++) if (!state.uploaded[state.steps[i].kind]) return i;
    return state.steps.length;
  }

  function showStep() {
    var step = state.steps[state.index];
    var kind = step.kind;
    if (kind === 'LIVENESS') return showLiveness(step);
    var err = el('p', { class: C.err, role: 'alert' });
    var status = el('p', { class: C.status });
    var preview = el('img', { class: C.preview, alt: '', hidden: '' });
    var useBtn = el('button', { class: C.primary, type: 'button', text: t('useThis'), hidden: '' });
    var capture = kind === 'SELFIE' ? 'user' : 'environment';
    var takeLabel = el('span', { text: t('takePhoto') });
    var chooseLabel = el('span', { text: t('choosePhoto') });

    function picker(labelNode, iconName, withCapture, primary) {
      var input = el('input', { class: C.fileInput, type: 'file', accept: 'image/*' });
      if (withCapture) input.setAttribute('capture', capture);
      var label = el('label', { class: primary ? C.primary : C.secondary }, [icon(iconName), labelNode, input]);
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        err.textContent = '';
        state.picked = file;
        if (preview.src) URL.revokeObjectURL(preview.src);
        preview.src = URL.createObjectURL(file);
        preview.hidden = false;
        useBtn.hidden = false;
        // With a photo in view, sending it is the main action; the pickers become "another one"
        takeBtn.className = C.secondary;
        takeLabel.textContent = t('takeAnother');
        chooseLabel.textContent = t('chooseAnother');
        input.value = '';
      });
      return label;
    }
    var takeBtn = picker(takeLabel, 'camera', true, true);
    var chooseBtn = picker(chooseLabel, 'image', false, false);

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

    render([el('div', { class: C.card }, [
      stepLine(state.index, !step.required),
      progress(state.index),
      art(kind),
      el('h1', { class: C.h1, text: t(kind) }),
      el('p', { class: C.muted, text: t(kind + '_HINT') }),
      tipList(kind),
      preview,
      el('div', { class: C.actions }, [
        useBtn,
        takeBtn,
        chooseBtn,
        state.uploaded[kind] ? el('button', { class: C.link, type: 'button', text: t('alreadySent'), onclick: next }) : null,
        step.required ? null : el('button', { class: C.link, type: 'button', text: t('skip'), onclick: next })
      ]),
      status, err
    ])]);
  }

  // The challenge runs on its own page (/verify/liveness), which alone is allowed to reach AWS; it
  // comes back here when done. The token stays in this tab's sessionStorage, never in the URL.
  function showLiveness(step) {
    render([el('div', { class: C.card }, [
      stepLine(state.index, false),
      progress(state.index),
      art(state.uploaded.LIVENESS ? 'DONE' : 'LIVENESS', state.uploaded.LIVENESS ? 'ok' : ''),
      el('h1', { class: C.h1, text: t('LIVENESS') }),
      el('p', { class: C.muted, text: t('LIVENESS_HINT') }),
      state.uploaded.LIVENESS ? null : tipList('LIVENESS'),
      el('div', { class: C.actions }, [
        state.uploaded.LIVENESS
          ? el('button', { class: C.primary, type: 'button', text: t('checkDone'), onclick: next })
          : el('a', { class: C.primary, href: livenessLink(), text: t('startCheck') }),
        el('button', { class: C.link, type: 'button', text: t('selfieInstead'), onclick: function () { useSelfieInstead(); show(); } })
      ])
    ])]);
  }

  // A device that cannot run the challenge (no camera permission, an old browser) sends a selfie;
  // such a case is never approved automatically, but it can still be reviewed
  function useSelfieInstead() {
    state.selfieInstead = true;
    try { sessionStorage.setItem('verify-selfie-instead', state.token); } catch (e) { /* ignore */ }
    state.steps = state.steps.map(function (s) { return s.kind === 'LIVENESS' ? { kind: 'SELFIE', required: true } : s; });
  }

  // Server steps are documents; with liveness on, the selfie becomes the face check (or, on request, stays a selfie)
  function pageSteps(serverSteps) {
    if (!state.liveness) return serverSteps;
    return serverSteps.map(function (s) {
      if (s.kind !== 'SELFIE') return s;
      return state.selfieInstead ? { kind: 'SELFIE', required: true } : { kind: 'LIVENESS', required: true };
    });
  }

  function stored(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }

  // Whether this tab can keep the token. Some browsers block storage (private modes, settings);
  // then the token travels to the face check page in the URL fragment, which browsers never send
  // to a server, exactly as it arrived in the link.
  function storageWorks() {
    try { sessionStorage.setItem('verify-probe', '1'); sessionStorage.removeItem('verify-probe'); return true; } catch (e) { return false; }
  }
  function livenessLink() {
    return '/verify/liveness?lang=' + lang + (storageWorks() ? '' : '#' + state.token);
  }

  // The first required step still missing: coming back from the face check must not reopen an
  // optional photo the person chose to skip
  function firstRequiredOpen() {
    for (var i = 0; i < state.steps.length; i++) if (state.steps[i].required && !state.uploaded[state.steps[i].kind]) return i;
    return state.steps.length;
  }

  function next() { state.index++; if (state.index >= state.steps.length) { state.screen = 'review'; } else { state.screen = 'step'; } show(); }

  function showReview() {
    var missing = state.steps.some(function (s) { return s.required && !state.uploaded[s.kind]; });
    var err = el('p', { class: C.err, role: 'alert', text: missing ? t('missing') : '' });
    var btn = el('button', { class: C.primary, type: 'button', text: t('submit') });
    btn.disabled = missing;
    function reenable(message) { state.busy = false; btn.disabled = false; btn.textContent = t('submit'); err.textContent = message; }
    // A 410 says why: already submitted (this or another attempt got through) or no longer usable
    function gone(data) {
      state.busy = false;
      if (data && data.code === 'session_submitted') return showDone();
      if (data && data.code === 'session_expired') return showFatal('closedTitle', 'closed');
      return look(); // "closed" is ambiguous: ask the service which it was
    }
    // Submitting is not safe to repeat blindly: if the first request got through but its reply was
    // lost, a repeat would be refused and wrongly tell the user their link is dead. So after an
    // unclear failure, look at the session first, and only submit again if it is still open.
    var unclear = 0;
    function look() {
      if (++unclear > 5) return reenable(t('network'));
      return wait(400 * Math.pow(2, unclear)).then(function () { return api('GET', ''); }).then(function (r) {
        if (r.status === 200) return attempt();            // still open: the first request did not go through
        if (r.status === 410) { state.busy = false; return r.data && r.data.code === 'session_submitted' ? showDone() : showFatal('closedTitle', 'closed'); }
        if (r.status === 404) return showFatal('invalidTitle', 'invalid');
        return look();
      }, look);
    }
    function attempt() {
      return api('POST', '/submit').then(function (r) {
        if (r.status === 200) { state.busy = false; return showDone(); }
        if (r.status === 404) return showFatal('invalidTitle', 'invalid');
        if (r.status === 410) return gone(r.data);
        if (r.status === 400) return reenable(t('missing'));
        if (r.status >= 500 || r.status === 429) return look();
        return reenable(messageFor(r.status));
      }, look);
    }
    btn.addEventListener('click', function () {
      if (state.busy) return;
      state.busy = true; btn.disabled = true; btn.textContent = t('submitting'); err.textContent = '';
      unclear = 0;
      attempt();
    });
    render([el('div', { class: C.card }, [
      el('h1', { class: C.h1, text: t('review') }),
      el('p', { class: C.muted, text: t('reviewText') }),
      el('div', { class: C.rows }, state.steps.map(function (s) {
        var done = !!state.uploaded[s.kind];
        return el('div', { class: C.row }, [
          el('span', { text: t(s.kind) }),
          el('span', { class: done ? C.stateOk : C.stateTodo }, [icon(done ? 'check' : 'dash'), el('span', { text: done ? '✓ ' + t('uploaded') : (s.required ? t('notSent') : t('optional')) })])
        ]);
      })),
      el('div', { class: C.actions }, [btn, el('button', { class: C.secondary, type: 'button', text: t('retake'), onclick: function () { state.screen = 'step'; state.index = 0; show(); } })]),
      err
    ])]);
  }

  function showDone() {
    state.screen = 'done';
    try {
      sessionStorage.removeItem('verify-token');
      sessionStorage.setItem('verify-done', '1'); // a reload in this tab says thank you again, not "link not found"
    } catch (e) { /* ignore */ }
    render([el('div', { class: C.card }, [art('DONE', 'ok'), el('h1', { class: C.h1, text: t('doneTitle') }), el('p', { class: C.muted, text: t('doneText') })])]);
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

  function load() {
    return withRetry(function () { return api('GET', ''); }).then(function (r) {
      if (r.status === 404) return showFatal('invalidTitle', 'invalid');
      if (r.status === 410) {
        // Reloaded after submitting: thank the user instead of calling the link dead
        if (r.data && r.data.code === 'session_submitted') return showDone();
        return showFatal('closedTitle', 'closed');
      }
      // Still failing after the retries: say so and let the user try again, instead of "link not found"
      if (r.status !== 200) return showFatal('trouble', 'network', load);
      state.liveness = !!r.data.liveness;
      var back = /[?&]liveness=(done|cancelled|selfie)\\b/.exec(location.search);
      if (back) history.replaceState(null, '', location.pathname + '?lang=' + lang);
      if (back && back[1] === 'selfie') { try { sessionStorage.setItem('verify-selfie-instead', state.token); } catch (e) { /* ignore */ } }
      if (back && back[1] === 'done') { try { sessionStorage.setItem('verify-liveness-done', state.token); } catch (e) { /* ignore */ } }
      state.selfieInstead = state.liveness && ((back && back[1] === 'selfie') || stored('verify-selfie-instead') === state.token);
      state.steps = pageSteps(r.data.steps);
      state.uploaded = {};
      (r.data.uploaded || []).forEach(function (k) { state.uploaded[k] = true; });
      // Done needs both: the face check page said so (now or earlier in this tab), and the service has a challenge on record
      if (state.liveness && r.data.livenessStarted && ((back && back[1] === 'done') || stored('verify-liveness-done') === state.token)) state.uploaded.LIVENESS = true;
      // Back from the face check page: continue where the person was, not at the start
      if (state.liveness && back) {
        state.index = firstRequiredOpen();
        state.screen = state.index >= state.steps.length ? 'review' : 'step';
        return show();
      }
      state.screen = 'intro';
      show();
    }, function () { showFatal('trouble', 'network', load); });
  }

  function start() {
    state.token = readToken();
    document.documentElement.lang = lang;
    if (!state.token) return stored('verify-done') ? showDone() : showFatal('invalidTitle', 'invalid');
    load();
  }

  start();
})();
`;

/**
 * The liveness challenge page, /verify/liveness. It is a separate document so that only it gets
 * the looser policy the AWS widget needs (camera streaming to AWS, WebAssembly face detection);
 * the capture page keeps its strict one. It reads the token from this tab's sessionStorage, asks
 * the service for a challenge, hands the widget its short-lived credentials (kept in memory only),
 * and goes back to /verify when the challenge ends. The widget itself is a separate bundle
 * (liveness-widget/, built to liveness-dist/) that defines window.VerifyLiveness.
 */
export const LIVENESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Face check</title>
<link rel="stylesheet" href="/verify/app.css">
<link rel="stylesheet" href="/verify/liveness-widget.css">
</head>
<body>
<header class="mx-auto flex max-w-[520px] items-center justify-between gap-3 px-4 pt-4" id="top"></header>
<main class="mx-auto max-w-[520px] px-4 pt-3 pb-8">
<div id="app" aria-live="polite"></div>
<div id="widget" class="widget mt-4 overflow-hidden rounded-[14px] border border-line bg-card empty:hidden"></div>
</main>
<noscript><p class="p-4">This page needs JavaScript for the face check.</p></noscript>
<script src="/verify/liveness-widget.js"></script>
<script src="/verify/liveness.js"></script>
</body>
</html>`;

export const LIVENESS_JS = `
(function () {
  'use strict';

  var STRINGS = {
    en: { title: 'Face check', preparing: 'Preparing the face check…', unavailable: 'The face check could not start on this device.',
      closedTitle: 'This link cannot be used', closed: 'It has expired or was already used. Ask the company that sent it for a new link.',
      invalidTitle: 'Link not found', invalid: 'Open the link exactly as you received it, or ask for a new one.',
      failed: 'The face check did not work this time.', retry: 'Try again', back: 'Back', selfie: 'Send a selfie instead',
      tooMany: 'The face check was started too many times with this link. Send a selfie instead, or ask for a new link.',
      brand: 'Secure identity check', follow: 'Follow the instructions in the frame below and keep your face inside the oval.',
      tips: ['Find good, even light', 'Take off sunglasses and hats', 'Move closer when asked, then hold still'] },
    sq: { title: 'Kontrolli i fytyrës', preparing: 'Po përgatitet kontrolli i fytyrës…', unavailable: 'Kontrolli i fytyrës nuk mund të fillojë në këtë pajisje.',
      closedTitle: 'Kjo lidhje nuk mund të përdoret', closed: 'Ka skaduar ose është përdorur tashmë. Kërkoni një lidhje të re nga kompania që ju e dërgoi.',
      invalidTitle: 'Lidhja nuk u gjet', invalid: 'Hapeni lidhjen saktësisht ashtu siç e morët, ose kërkoni një të re.',
      failed: 'Kontrolli i fytyrës nuk funksionoi këtë herë.', retry: 'Provo përsëri', back: 'Kthehu', selfie: 'Dërgoni një selfi',
      tooMany: 'Kontrolli i fytyrës u nis shumë herë me këtë lidhje. Dërgoni një selfi, ose kërkoni një lidhje të re.',
      brand: 'Verifikim i sigurt i identitetit', follow: 'Ndiqni udhëzimet në kornizën më poshtë dhe mbani fytyrën brenda ovalit.',
      tips: ['Gjeni dritë të mirë e të njëtrajtshme', 'Hiqni syzet e diellit dhe kapelën', 'Afrohuni kur t’ju kërkohet, pastaj rrini pa lëvizur'] },
    sr: { title: 'Provera lica', preparing: 'Priprema provere lica…', unavailable: 'Provera lica ne može da počne na ovom uređaju.',
      closedTitle: 'Ova veza se ne može koristiti', closed: 'Istekla je ili je već iskorišćena. Zatražite novu vezu od kompanije koja vam je poslala.',
      invalidTitle: 'Veza nije pronađena', invalid: 'Otvorite vezu tačno onako kako ste je dobili ili zatražite novu.',
      failed: 'Provera lica ovaj put nije uspela.', retry: 'Pokušaj ponovo', back: 'Nazad', selfie: 'Pošaljite selfi',
      tooMany: 'Provera lica je pokrenuta previše puta sa ovom vezom. Pošaljite selfi ili zatražite novu vezu.',
      brand: 'Bezbedna provera identiteta', follow: 'Pratite uputstva u okviru ispod i držite lice unutar ovala.',
      tips: ['Nađite dobro, ravnomerno svetlo', 'Skinite sunčane naočare i šešir', 'Približite se kada se zatraži, pa se ne pomerajte'] }
  };


  // Tailwind classes, the same as on the capture page (see the note there)
  var C = {
    card: 'mt-3 rounded-2xl border border-line bg-card p-7 shadow-card max-sm:px-[18px] max-sm:py-[22px]',
    h1: 'mb-2 text-2xl leading-tight font-bold tracking-tight focus:outline-none',
    muted: 'mb-3 text-muted',
    art: 'mb-5 flex h-[132px] items-center justify-center rounded-[14px] bg-accent-weak text-accent [&_svg]:size-28',
    artBad: 'mb-5 flex h-[132px] items-center justify-center rounded-[14px] bg-bad-weak text-bad [&_svg]:size-28',
    tips: 'mt-1 mb-5',
    tip: 'flex items-start gap-2.5 py-1.5 [&_svg]:mt-0.5 [&_svg]:size-5 [&_svg]:flex-none [&_svg]:text-ok',
    brand: 'flex items-center gap-2 text-[15px] font-semibold text-muted [&_svg]:size-5 [&_svg]:text-accent',
    actions: 'mt-2 grid gap-2.5',
    primary: 'btn primary flex min-h-[52px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-[18px] py-3 text-center font-semibold text-on-accent no-underline transition-colors hover:border-accent-hover hover:bg-accent-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-accent disabled:cursor-default disabled:opacity-50 [&_svg]:size-5',
    secondary: 'btn flex min-h-[52px] w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-card px-[18px] py-3 text-center font-semibold text-fg no-underline transition-colors hover:border-muted focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-accent disabled:cursor-default disabled:opacity-50 [&_svg]:size-5',
    link: 'link min-h-11 w-full cursor-pointer font-semibold text-accent hover:underline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent'
  };

  var app = document.getElementById('app');
  var widget = document.getElementById('widget');
  var lang = pickLanguage();
  var token = readToken();
  var unmount = null;

  function t(key) { return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key]; }
  function stored(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }

  // From this tab's storage, or from the URL fragment when the browser blocks storage. Taken out of
  // the address bar at once either way.
  function readToken() {
    var fromHash = location.hash.replace(/^#/, '');
    if (/^[A-Za-z0-9_-]{20,120}$/.test(fromHash)) {
      history.replaceState(null, '', location.pathname + location.search);
      return fromHash;
    }
    return stored('verify-token');
  }
  function storageWorks() {
    try { sessionStorage.setItem('verify-probe', '1'); sessionStorage.removeItem('verify-probe'); return true; } catch (e) { return false; }
  }

  function pickLanguage() {
    var q = /[?&]lang=(en|sq|sr)\\b/.exec(location.search);
    if (q) return q[1];
    var saved = null;
    try { saved = sessionStorage.getItem('verify-lang'); } catch (e) { /* ignore */ }
    return saved && STRINGS[saved] ? saved : 'en';
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

  var NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    shield: [24, [['path', { d: 'M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z' }]]],
    check: [24, [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.5l2.6 2.6L16 9.6' }]]],
    face: [120, [['path', { d: 'M32 18h-8a8 8 0 0 0-8 8v8M88 18h8a8 8 0 0 1 8 8v8M32 102h-8a8 8 0 0 1-8-8v-8M88 102h8a8 8 0 0 0 8-8v-8' }], ['ellipse', { cx: 60, cy: 57, rx: 21, ry: 27 }], ['path', { d: 'M51 52v1M69 52v1M53 68c4.5 3.6 9.5 3.6 14 0' }]]],
    alert: [120, [['circle', { cx: 60, cy: 60, r: 38 }], ['path', { d: 'M60 40v26M60 79v1' }]]]
  };
  function icon(name) {
    var spec = ICONS[name];
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + spec[0] + ' ' + spec[0]);
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', spec[0] > 24 ? '3' : '1.8');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    spec[1].forEach(function (part) {
      var n = document.createElementNS(NS, part[0]);
      Object.keys(part[1]).forEach(function (k) { n.setAttribute(k, String(part[1][k])); });
      svg.appendChild(n);
    });
    return svg;
  }

  function header() {
    var top = document.getElementById('top');
    if (!top || top.firstChild) return;
    top.appendChild(el('div', { class: C.brand }, [icon('shield'), el('span', { text: t('brand') })]));
  }

  // tone: 'face' (the challenge), 'bad' (something went wrong), or none
  function message(titleKey, textKey, actions, tone) {
    header();
    while (app.firstChild) app.removeChild(app.firstChild);
    var bad = tone === 'bad' || (tone === undefined && (titleKey === 'invalidTitle' || titleKey === 'closedTitle' || textKey === 'failed' || textKey === 'unavailable' || textKey === 'tooMany'));
    var tipList = textKey === 'preparing'
      ? el('ul', { class: C.tips }, (STRINGS[lang].tips || STRINGS.en.tips).map(function (x) { return el('li', { class: C.tip }, [icon('check'), el('span', { text: x })]); }))
      : null;
    var card = el('div', { class: C.card }, [
      el('div', { class: bad ? C.artBad : C.art }, [icon(bad ? 'alert' : 'face')]),
      el('h1', { class: C.h1, text: t(titleKey) }),
      textKey ? el('p', { class: C.muted, text: t(textKey) }) : null,
      tipList,
      actions && actions.length ? el('div', { class: C.actions }, actions) : null
    ]);
    app.appendChild(card);
  }

  // While the widget runs: a compact heading above it, nothing else to read
  function heading() {
    header();
    while (app.firstChild) app.removeChild(app.firstChild);
    app.appendChild(el('div', { class: C.card }, [el('h1', { class: C.h1, text: t('title') }), el('p', { class: C.muted, text: t('follow') })]));
  }

  // Back to the capture page, which carries on from the next required step. The outcome travels in
  // the query (it holds no secret, and the service still decides from its own record); the token
  // only in the fragment, and only when the tab cannot keep it.
  function back(outcome) {
    if (unmount) { try { unmount(); } catch (e) { /* ignore */ } unmount = null; }
    location.replace('/verify?lang=' + lang + '&liveness=' + outcome + (storageWorks() ? '' : '#' + token));
  }

  function choices() {
    return [
      el('button', { class: C.primary, type: 'button', text: t('retry'), onclick: start }),
      el('button', { class: C.secondary, type: 'button', text: t('selfie'), onclick: function () { back('selfie'); } }),
      el('button', { class: C.link, type: 'button', text: t('back'), onclick: function () { back('cancelled'); } })
    ];
  }

  function start() {
    if (!token) return message('invalidTitle', 'invalid');
    if (!window.VerifyLiveness || typeof window.VerifyLiveness.mount !== 'function') {
      return message('title', 'unavailable', choices().slice(1));
    }
    message('title', 'preparing');
    fetch('/v1/upload/' + encodeURIComponent(token) + '/liveness', { method: 'POST' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    }).then(function (r) {
      if (r.status === 404) return message('invalidTitle', 'invalid');
      if (r.status === 410) return message('closedTitle', 'closed');
      if (r.status === 429) return message('title', 'tooMany', choices().slice(1));
      if (r.status !== 200 || !r.data || !r.data.sessionId || !r.data.credentials) return message('title', 'unavailable', choices());
      heading();
      // The credentials live only inside this call: never stored, logged or put in the page
      unmount = window.VerifyLiveness.mount(widget, {
        sessionId: r.data.sessionId,
        region: r.data.region,
        credentials: r.data.credentials,
        lang: lang,
        onComplete: function () { back('done'); },
        onCancel: function () { back('cancelled'); },
        onError: function () {
          if (unmount) { try { unmount(); } catch (e) { /* ignore */ } unmount = null; }
          message('title', 'failed', choices());
        }
      });
    }, function () { message('title', 'unavailable', choices()); });
  }

  document.documentElement.lang = lang;
  start();
})();
`;
