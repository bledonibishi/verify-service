/**
 * The AWS Face Liveness widget, wrapped so the plain-JavaScript liveness page can use it:
 * `window.VerifyLiveness.mount(element, options)` renders the challenge and returns an unmount
 * function. Built into one script and stylesheet by scripts/build-liveness.mjs; nothing here talks
 * to verify-service. The credentials come from the service (short-lived, limited to starting this
 * one stream) and are handed to the widget from memory only.
 */
import { FaceLivenessDetectorCore } from '@aws-amplify/ui-react-liveness';
import '@aws-amplify/ui-react/styles.css';
import * as React from 'react';
import { createRoot } from 'react-dom/client';

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: string;
}

export interface MountOptions {
  sessionId: string;
  region: string;
  credentials: Credentials;
  lang?: 'en' | 'sq' | 'sr';
  onComplete: () => void;
  onCancel: () => void;
  onError: (code: string) => void;
}

// The most visible texts. Written by the developer, not a native translator: have them reviewed.
const TEXT: Record<string, Record<string, string>> = {
  sq: {
    startScreenBeginCheckText: 'Fillo kontrollin',
    hintMoveFaceFrontOfCameraText: 'Vendoseni fytyrën para kamerës',
    hintTooManyFacesText: 'Sigurohuni që vetëm një fytyrë të jetë para kamerës',
    hintFaceDetectedText: 'Fytyra u gjet',
    hintCanNotIdentifyText: 'Vendoseni fytyrën para kamerës',
    hintTooCloseText: 'Largohuni pak',
    hintTooFarText: 'Afrohuni',
    hintConnectingText: 'Po lidhet…',
    hintVerifyingText: 'Po verifikohet…',
    hintCheckCompleteText: 'Kontrolli përfundoi',
    hintIlluminationTooBrightText: 'Shkoni në një vend me më pak dritë',
    hintIlluminationTooDarkText: 'Shkoni në një vend me më shumë dritë',
    hintHoldFaceForFreshnessText: 'Qëndroni pa lëvizur',
    hintCenterFaceText: 'Vendoseni fytyrën në qendër',
    hintFaceOffCenterText: 'Fytyra nuk është në qendër. Vendoseni fytyrën para kamerës.',
    recordingIndicatorText: 'Po regjistrohet',
    cancelLivenessCheckText: 'Anulo kontrollin',
    photosensitivityWarningHeadingText: 'Paralajmërim për ndjeshmërinë ndaj dritës',
    photosensitivityWarningBodyText: 'Ky kontroll shfaq ngjyra që ndriçojnë. Kujdes nëse jeni të ndjeshëm ndaj dritës.',
    waitingCameraPermissionText: 'Në pritje të lejes për kamerën.',
    cameraNotFoundHeadingText: 'Kamera nuk është e qasshme.',
    cameraNotFoundMessageText: 'Lejoni qasjen në kamerë te cilësimet e shfletuesit dhe provoni përsëri.',
    retryCameraPermissionsText: 'Provo përsëri',
  },
  sr: {
    startScreenBeginCheckText: 'Počni proveru',
    hintMoveFaceFrontOfCameraText: 'Postavite lice ispred kamere',
    hintTooManyFacesText: 'Neka ispred kamere bude samo jedno lice',
    hintFaceDetectedText: 'Lice pronađeno',
    hintCanNotIdentifyText: 'Postavite lice ispred kamere',
    hintTooCloseText: 'Odmaknite se malo',
    hintTooFarText: 'Približite se',
    hintConnectingText: 'Povezivanje…',
    hintVerifyingText: 'Provera…',
    hintCheckCompleteText: 'Provera završena',
    hintIlluminationTooBrightText: 'Pređite na mesto sa manje svetla',
    hintIlluminationTooDarkText: 'Pređite na mesto sa više svetla',
    hintHoldFaceForFreshnessText: 'Ne pomerajte se',
    hintCenterFaceText: 'Postavite lice u sredinu',
    hintFaceOffCenterText: 'Lice nije u sredini. Postavite lice ispred kamere.',
    recordingIndicatorText: 'Snima se',
    cancelLivenessCheckText: 'Otkaži proveru',
    photosensitivityWarningHeadingText: 'Upozorenje za osetljivost na svetlo',
    photosensitivityWarningBodyText: 'Ova provera prikazuje boje koje trepere. Budite oprezni ako ste osetljivi na svetlo.',
    waitingCameraPermissionText: 'Čeka se dozvola za kameru.',
    cameraNotFoundHeadingText: 'Kamera nije dostupna.',
    cameraNotFoundMessageText: 'Dozvolite pristup kameri u podešavanjima pregledača i pokušajte ponovo.',
    retryCameraPermissionsText: 'Pokušaj ponovo',
  },
};

function mount(element: HTMLElement, o: MountOptions): () => void {
  const root = createRoot(element);
  const credentials = {
    accessKeyId: o.credentials.accessKeyId,
    secretAccessKey: o.credentials.secretAccessKey,
    sessionToken: o.credentials.sessionToken,
    ...(o.credentials.expiration ? { expiration: new Date(o.credentials.expiration) } : {}),
  };
  root.render(
    <FaceLivenessDetectorCore
      sessionId={o.sessionId}
      region={o.region}
      config={{ credentialProvider: async () => credentials }}
      displayText={o.lang && TEXT[o.lang] ? TEXT[o.lang] : undefined}
      onAnalysisComplete={async () => o.onComplete()}
      onUserCancel={() => o.onCancel()}
      // Only a fixed code leaves the widget: an error object can carry request details
      onError={(e) => o.onError(String((e as { state?: string })?.state ?? 'error'))}
    />,
  );
  return () => root.unmount();
}

(window as unknown as { VerifyLiveness: { mount: typeof mount } }).VerifyLiveness = { mount };
