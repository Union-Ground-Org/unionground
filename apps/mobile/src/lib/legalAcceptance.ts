import {
  legalAcceptanceRequirement as sharedRequirement,
} from '../../../../src/lib/legalAcceptance.js';
import { currentLegalVersions, legalInstrument, LEGAL_INSTRUMENTS, LEGAL_CHANGELOG_PATH } from '../../../../src/lib/legalInstruments.js';
import { ageRuleFor } from '../../../../src/lib/residenceRegions.js';
import { LEGAL_SITE_ORIGIN } from './legalDocuments';

// At the first sign-in after a
// material change the person is asked once to accept the current version, and
// the acceptance is recorded with its version, the time, the person and the
// organization. The native app reads and writes through the SAME module as
// the website (src/lib/legalAcceptance.js) and the same version source
// (src/lib/legalInstruments.js), so one server contract covers both and a
// version can never differ between platforms.
//
// English only: the owner ruled on September 20, 2026 that apps/mobile is not
// expected to speak Spanish. The website carries both co-equal texts (D-15).

const TERMS_INSTRUMENT = 'terms-of-use';

export type LegalAcceptanceState = {
  versions: Record<string, string>;
  acceptedAt: string | null;
} | null;

export type LegalAcceptanceRequirement = {
  reacceptanceRequired: boolean;
  instruments: string[];
};

export const LEGAL_ACCEPTANCE_TITLE = 'Accept the current Union Ground terms';
export const LEGAL_ACCEPTANCE_CONSENT = 'I have read the current version and I agree to it.';
export const LEGAL_ACCEPTANCE_ACTION = 'Accept and continue';
// Accounts
// are adults-only, and every acceptance carries this attestation.
export const LEGAL_ACCEPTANCE_STATE = 'State where you live';
export const LEGAL_ACCEPTANCE_STATE_CHOOSE = 'Choose your state';
// Why the state
// is asked, without listing other states as if they were the rule.
export const LEGAL_ACCEPTANCE_AGE_HELP = 'We ask where you live because state law sets the minimum age. Adults 18 and over can join from any state.';
export const LEGAL_ACCEPTANCE_ADULT = "I'm 18 or older.";
export const LEGAL_ACCEPTANCE_BAND = "I'm 13 or older, and if I'm under 18, my organization authorized this account.";
export const LEGAL_ACCEPTANCE_REQUIRED = 'Choose the state where you live and check both boxes before continuing.';
//  (M1-2): choosing a state clears a checked age box; say so beside it.
export const LEGAL_ACCEPTANCE_AGE_RECHECK = 'Check the age statement again for the state you chose.';
//  (M1-2): what a press on the unavailable Accept and continue names,
// the first unmet part in screen order.
export const LEGAL_ACCEPTANCE_MISSING = Object.freeze({
  consent: 'Check the box saying you have read and agree to the current version.',
  state: 'Choose the state where you live.',
  age: 'Check the age statement for your state.',
});
export function legalAcceptanceMissing(agreed: boolean, stateChosen: boolean, ageAttested: boolean): string | undefined {
  if (!agreed) return LEGAL_ACCEPTANCE_MISSING.consent;
  if (!stateChosen) return LEGAL_ACCEPTANCE_MISSING.state;
  return ageAttested ? undefined : LEGAL_ACCEPTANCE_MISSING.age;
}
export const LEGAL_ACCEPTANCE_FAILED = 'That acceptance could not be recorded, so nothing was stored. Check your connection and try again.';

// REQ-UG-MOBILE-STORE-AGE-SIGNAL-20261016: in an app-store age-law
// state the card asks the store for its age signal before the self-attested
// box counts (src/lib/storeAgeSignal.ts). A store-reported minor is stopped
// here with this copy; every other outcome leaves the self-attestation in
// charge. The refusal is English only, per the owner's October 20, 2026
// decision, matching the September 20 legal-card ruling.
export const LEGAL_ACCEPTANCE_STORE_CHECKING = 'Checking the age range your app store account shares…';
export const LEGAL_ACCEPTANCE_STORE_BLOCKED = 'Your app store account reports an age under 18. In the state you chose, Union Ground accounts are for adults 18 and over, so this account cannot be created. If the age on your Apple Account or Google Account is wrong, correct it there, then open Union Ground again.';

// The versions in force, which the prompt displays and the database stores.
export function legalAcceptanceVersions(): Record<string, string> {
  return currentLegalVersions() as Record<string, string>;
}

export function legalAcceptanceLinks(): { label: string; url: string }[] {
  // No Union Ground site publishes the instruments yet, so there is nothing to open.
  if (!LEGAL_SITE_ORIGIN) return [];
  const instruments = LEGAL_INSTRUMENTS as readonly { englishName: string; version: string; path: string }[];
  return [
    ...instruments.map((entry) => ({
      label: `${entry.englishName} — version ${entry.version} (opens browser)`,
      url: `${LEGAL_SITE_ORIGIN}${entry.path}`,
    })),
    { label: 'Change history (opens browser)', url: `${LEGAL_SITE_ORIGIN}${LEGAL_CHANGELOG_PATH}` },
  ];
}

// BUG-UG-NATIVE-FAILED-DOCUMENT-OPEN-LOCKS-ACCEPT-20261018: when the
// browser refuses to open an instrument, the same instrument at the same
// version reads in the app through the legal reader route. Every instrument's
// site path is its reader route; the change history has no reader page, so it
// answers null. The link list itself keeps its recorded two-field shape.
export function legalAcceptanceInAppPath(url: string): string | null {
  const instruments = LEGAL_INSTRUMENTS as readonly { path: string }[];
  return instruments.find((entry) => url === `${LEGAL_SITE_ORIGIN}${entry.path}`)?.path ?? null;
}

// Whether this reader must accept again, from the same material-change flag
// the website reads. An unknown acceptance state asks for nothing.
export function legalAcceptanceRequirement(
  state: LegalAcceptanceState,
  instruments?: unknown,
): LegalAcceptanceRequirement {
  const requirement = sharedRequirement(state, instruments) as LegalAcceptanceRequirement;
  return {
    reacceptanceRequired: requirement.reacceptanceRequired === true,
    instruments: Array.isArray(requirement.instruments) ? requirement.instruments : [],
  };
}

function instrumentName(key: string): string {
  const entry = legalInstrument(key) as { englishName?: string } | null;
  return entry?.englishName ?? key;
}

export function legalAcceptanceBody(instruments: string[]): string {
  const names = instruments.map(instrumentName).join(', ');
  return `A material change was published to: ${names}. Read the current version and accept it to go on.`;
}

export function legalAcceptanceVersionLine(): string {
  const terms = legalInstrument(TERMS_INSTRUMENT) as { version?: string } | null;
  return `Terms of use, version ${terms?.version ?? ''}.`;
}

// The attestation sentence for the chosen state, or null before a listed
// state is chosen.
export function legalAcceptanceAgeLabel(residenceState: string): string | null {
  const rule = ageRuleFor(residenceState);
  if (rule === 'adult') return LEGAL_ACCEPTANCE_ADULT;
  if (rule === 'band') return LEGAL_ACCEPTANCE_BAND;
  return null;
}
