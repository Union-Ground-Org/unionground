import { PUBLIC_SITE_ORIGIN } from './publicSite';

export const LEGAL_LAST_REVIEWED = '2026-10-15';

// Union Ground has no published website, legal entity statement, or
// support mailbox yet. The reader therefore shows what this build actually
// does and links nowhere until PUBLIC_SITE_ORIGIN is set.
export const LEGAL_SITE_ORIGIN: string | null = PUBLIC_SITE_ORIGIN;

export type LegalPageKey = 'privacy' | 'terms' | 'accessibility' | 'accessibility-statement' | 'about' | 'ai-disclosure' | 'retention';

export const LEGAL_INSTRUMENT_HEADING = 'The instrument behind this summary';

export type LegalInstrumentReference = {
  name: string;
  status: string;
  url: string;
  // The instrument's full text, in the order the shared source lists it, then
  // the acceptance section the web route appends.
  sections: { heading: string; body: string }[];
};

export type LegalDocument = {
  key: LegalPageKey;
  instrument?: LegalInstrumentReference | null;
  title: string;
  intro: string;
  notice: string;
  sitePath: string;
  contactLabel: string;
  contactEmail: string;
  sections: { heading: string; body: string }[];
};

const previewNotice = `This page describes the Union Ground preview app as built. Union Ground's formal policies are not published yet and will be before live accounts open. Content last reviewed: ${LEGAL_LAST_REVIEWED}.`;
const noContact = 'No support address is published yet. For account help, use the contact who provisioned your account.';

export const LEGAL_DOCUMENTS: Record<LegalPageKey, LegalDocument> = {
  privacy: {
    key: 'privacy',
    instrument: null,
    title: 'Privacy',
    intro: 'Union Ground is built for workers organizing a union, so it treats coworker names, card counts, and issue notes as private by default.',
    notice: previewNotice,
    sitePath: '/privacy',
    contactLabel: 'Privacy questions',
    contactEmail: '',
    sections: [
      { heading: 'What this preview holds', body: 'The preview runs on fictional people and records. Your changes, preferences, and Guide history stay in protected storage on this device and do not sync to another phone.' },
      { heading: 'No live account or provider', body: 'Live sign-in, live AI, and a live data provider are not available in this build. Nothing you enter is sent to a Union Ground server.' },
      { heading: 'No tracking', body: 'The app has no advertising, tracking, purchases, or public posting. It does not register for remote push notifications.' },
      { heading: 'Device features you choose', body: 'Calendar, camera, microphone, and local reminders act only after you ask for them, and the system confirms each permission.' },
      { heading: 'Before live accounts open', body: 'A full privacy policy, including what a live account stores and how to request access or deletion, will be published here first.' },
    ],
  },
  terms: {
    key: 'terms',
    instrument: null,
    title: 'Terms of use',
    intro: 'Use Union Ground to plan organizing work with coworkers. Keep worker lists private and respect the people you are organizing with.',
    notice: previewNotice,
    sitePath: '/terms',
    contactLabel: 'Terms questions',
    contactEmail: '',
    sections: [
      { heading: 'Preview use', body: 'This build is a fictional preview for evaluation. It is not a place to store real coworker information.' },
      { heading: 'Not legal advice', body: 'Union Ground explains organizing steps in plain language. It does not give legal conclusions. Get qualified help for decisions about your rights or a campaign.' },
      { heading: 'Recognition is not automatic', body: 'A card majority shown in the app is not certification or recognition. Those follow their own legal paths.' },
      { heading: 'Before live accounts open', body: 'Full terms of use will be published here and accepted at first sign-in.' },
    ],
  },
  accessibility: {
    key: 'accessibility',
    instrument: null,
    title: 'Accessibility',
    intro: 'Union Ground is designed for screen readers, larger text, reduced motion, and one-handed use in break rooms and parking lots.',
    notice: previewNotice,
    sitePath: '/accessibility',
    contactLabel: 'Accessibility help',
    contactEmail: '',
    sections: [
      { heading: 'Standards', body: 'The app targets WCAG 2.2 AA in English and Spanish copy, with 48-point touch targets.' },
      { heading: 'Supported use', body: 'Controls have text labels and do not rely on color alone. VoiceOver, TalkBack, Dynamic Type, and Reduce Motion are supported throughout.' },
      { heading: 'Report a barrier', body: `${noContact} Include the screen, device, and what blocked you.` },
    ],
  },
  'accessibility-statement': {
    key: 'accessibility-statement',
    instrument: null,
    title: 'Accessibility statement',
    intro: 'Union Ground targets WCAG 2.2 level AA. A formal conformance statement will be published after the app is evaluated on physical iPhone and Android devices.',
    notice: previewNotice,
    sitePath: '/accessibility/statement',
    contactLabel: 'Accessibility help',
    contactEmail: '',
    sections: [
      { heading: 'Conformance status', body: 'Not yet evaluated. No conformance claim is made for this preview build.' },
      { heading: 'How it will be evaluated', body: 'With VoiceOver on iPhone and TalkBack on Android, on physical devices, before live accounts open.' },
    ],
  },
  about: {
    key: 'about',
    instrument: null,
    title: 'About Union Ground',
    intro: 'Union Ground is an organizing workspace for workers and committees who are forming a union.',
    notice: previewNotice,
    sitePath: '/about',
    contactLabel: 'Contact',
    contactEmail: '',
    sections: [
      { heading: 'What it is for', body: 'Building a committee, talking with coworkers, gathering authorization cards, choosing an election or voluntary recognition, recording employer resistance as facts, and bargaining a first contract.' },
      { heading: 'A separate product', body: 'Union Ground is built for workers forming a union. It shares no members, data, hosting or sign-in with any other product.' },
      { heading: 'Fictional preview', body: 'The people, campaign, and employer in this preview are fictional.' },
    ],
  },
  'ai-disclosure': {
    key: 'ai-disclosure',
    instrument: null,
    title: 'Guide disclosure',
    intro: 'The Guide answers organizing questions. In this preview it uses prewritten examples, not live AI.',
    notice: previewNotice,
    sitePath: '/ai-disclosure',
    contactLabel: 'Guide questions',
    contactEmail: '',
    sections: [
      { heading: 'What the preview does', body: 'Questions are matched to prewritten example answers on the device. No question leaves the phone.' },
      { heading: 'Protect sensitive information', body: 'Do not enter passwords, Social Security numbers, medical details, or coworker lists. The Guide is not an emergency service and not legal advice.' },
      { heading: 'Before live AI is enabled', body: 'Which provider would process a question, what is sent, and what is kept will be published here first.' },
    ],
  },
  retention: {
    key: 'retention',
    instrument: null,
    title: 'Data retention',
    intro: 'This preview keeps its records on your device only.',
    notice: previewNotice,
    sitePath: '/retention',
    contactLabel: 'Retention questions',
    contactEmail: '',
    sections: [
      { heading: 'On this device', body: 'Preview records, preferences, and Guide history stay in protected device storage until you clear them in Account or remove the app.' },
      { heading: 'Before live accounts open', body: 'A retention schedule for live accounts will be published here first.' },
    ],
  },
};

export const LEGAL_PAGE_KEYS = Object.keys(LEGAL_DOCUMENTS) as LegalPageKey[];

export function isLegalPageKey(value: string): value is LegalPageKey {
  return value in LEGAL_DOCUMENTS;
}

export function legalDocument(page: string): LegalDocument | null {
  return isLegalPageKey(page) ? LEGAL_DOCUMENTS[page] : null;
}

export function legalPlainText(document: LegalDocument): string {
  const sections = document.sections.map((section) => `${section.heading}\n${section.body}`).join('\n\n');
  const instrument = document.instrument
    ? [
      `${LEGAL_INSTRUMENT_HEADING}\n${document.instrument.name}\n${document.instrument.status}`,
      ...document.instrument.sections.map((section) => `${section.heading}\n${section.body}`),
      document.instrument.url,
    ].join('\n\n')
    : null;
  return [
    `Union Ground · ${document.title}`,
    'Public information',
    document.intro,
    document.notice,
    sections,
    ...(instrument ? [instrument] : []),
    `${document.contactLabel}: ${document.contactEmail || noContact}`,
    ...(LEGAL_SITE_ORIGIN ? [`${LEGAL_SITE_ORIGIN}${document.sitePath}`] : []),
  ].join('\n\n');
}

// The "In this document" card lists every section the reader renders: the
// summary, the instrument card, then each instrument section. Headings repeat
// between a summary and its instrument (Provider route, Report a barrier), so
// each entry carries its own anchor id, and an instrument row tells a screen
// reader which copy it jumps to.
export type LegalJumpEntry = { id: string; heading: string; accessibilityLabel: string };

export const LEGAL_INSTRUMENT_ANCHOR = 'instrument';

export function legalSummaryAnchor(index: number): string {
  return `summary-${index}`;
}

export function legalInstrumentAnchor(index: number): string {
  return `instrument-${index}`;
}

export function legalJumpEntries(document: LegalDocument): LegalJumpEntry[] {
  const summary = document.sections.map((section, index) => ({ id: legalSummaryAnchor(index), heading: section.heading, accessibilityLabel: section.heading }));
  if (!document.instrument) return summary;
  return [
    ...summary,
    { id: LEGAL_INSTRUMENT_ANCHOR, heading: LEGAL_INSTRUMENT_HEADING, accessibilityLabel: LEGAL_INSTRUMENT_HEADING },
    ...document.instrument.sections.map((section, index) => ({
      id: legalInstrumentAnchor(index),
      heading: section.heading,
      accessibilityLabel: `${section.heading}, in the full instrument`,
    })),
  ];
}

export function legalSiteUrl(document: LegalDocument): string | null {
  return LEGAL_SITE_ORIGIN ? `${LEGAL_SITE_ORIGIN}${document.sitePath}` : null;
}
