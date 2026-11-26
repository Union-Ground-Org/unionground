# Web shell and native mobile contract

`docs/contracts/README.md` lists every area contract.

## Web shell and native mobile contract

Binding owner direction, recorded 2026-08-23:

- Do not mount a companion-phone iframe, fake phone bezel, or reserved phone
  column in the web app. Desktop content fills the remaining width after the
  green rail. Responsive real-phone web layouts may remain.
- `apps/mobile` is the native iPhone and Android product. It is one Expo/React
  Native TypeScript codebase, never a WebView shell.
- Public, pre-auth, web, and native surfaces default to the light cream canvas.
- Native Home uses an over/under drawer language: All
  tools under the left edge and Campaign work under the right edge, with Home
  moving above pinned drawers.
- Work is a first-class organizing destination, not an item hidden inside
  Campaign. Web exposes `/m/work`; the native primary dock is Home, Work,
  Guide, Campaign, Account. Rights and other supporting destinations remain
  reachable from All Tools without displacing those five primary tabs.
- Use the shared depth system for cards, drawers, composers, sheets, dock, and
  controls. Respect Reduce Motion, 48px touch targets, Dynamic Type, VoiceOver,
  TalkBack, safe areas, and platform back behavior.
- Keep Union Ground concepts organizing-specific: Worker, Organizer,
  Committee, Campaign lead, Advisor, Admin, and Campaign chair; issues,
  meetings, cards, recognition, employer resistance, and a first contract.
  Never import grievance, chapter, steward, or existing-contract language.
- Native live sign-in is provisioned email plus a password delivered by email.
  No self-signup or store-account login. Preview data remains explicitly
  fictional and cannot share live providers, sessions, identifiers, or
  associated domains.
- The Union Ground demo remains on a separate deployment and origin so its
  provider, cookies, service worker, and sign-in boundary cannot collide with a
  live deployment.
