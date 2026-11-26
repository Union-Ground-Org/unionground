# Union Ground mobile

The iPhone and Android app for Union Ground, the organizing workspace for
workers and committees who are still forming a union. It is a real native
Expo/React Native app, not a website in a browser window, and it is not the
Union Ground app. Identifiers stay dedicated:

- Product name: `Union Ground`
- Scheme: `unionground`
- Application id, Expo owner and EAS project: your own (see "Your own app
  identity" below); the repository ships placeholders only

The app carries Union Ground's palette, mark, organizing hats, and
destinations. Concepts that need an existing union — grievances and legal
deadlines, contract articles, dues, the member PIN, and the public chapter
directory — are not part of this app.

## What it does

- **Dock:** Home, Work, Guide, Campaign, Account. Home keeps the over/under
  drawers: All tools under the left edge, Campaign work under the right edge.
  Messages, Campaign pulse, Meetings, Organizing rights, Recognition paths and
  the other supporting destinations open from All tools.
- **Hats:** Worker, Organizer, Committee, Campaign lead, Advisor, Admin and
  Campaign chair. Internal hat ids stay on the shared role names (`member`,
  `organizer`, `steward`, `coordinator`, `advisor`, `admin`, `vp`) so role rows
  and gates match the web.
- **Issues:** what coworkers want to change, recorded as facts. The app never
  labels conduct as illegal and never shows a card majority as certification.
- **Preview:** every build offers an explicit, clearly labeled fictional
  PREVIEW workspace (Harborview Care United at a fictional employer) that runs
  entirely on the device.

## Local checks

Use Node 22 or 24 and install the exact lockfile:

```sh
npm ci
npm run check
```

`npm run check` covers Expo Doctor, native dependency alignment, the security
audit, strict TypeScript, the type-coverage ratchet, unit tests, the icon asset
contract, the semantic contrast and icon audits, the design-coverage audit, and
production JS bundle exports for both platforms. CI runs it from the repository
root workflow on every push and pull request.

## Configuration and the provider boundary

No Union Ground backend is provisioned yet, so every build is preview-only:

- `config/sample-backend.json` pins no Supabase project and lists other
  products' projects as forbidden; `app.config.ts` refuses them by name and
  refuses any backend input that is not pinned in source.
- `src/lib/trustedBackends.js` (shared with the web) holds the only
  backend-to-portal pairs that may receive an access token. It is empty, so no
  token can leave the device and live sign-in fails closed.
- `config/mobile-app-links.json` keeps universal and App Links off;
  `src/lib/emailLinkHosts.js` admits no emailed-link host; and
  `src/lib/publicSite.ts` names no public website. Each is the single place to
  change once Union Ground has its own domain.

To connect a dedicated backend later, add exactly one owner-approved pair to
each of those sources and pin the same origin in `config/sample-backend.json`.
Never add another product's project, portal, or domain.

Live sign-in is a provisioned email address plus the password delivered by
email. There is no self-signup and no store-account, passkey, security-key, or
SSO sign-in. Sessions are stored through Expo SecureStore, backed by the iOS
Keychain and Android Keystore.

## Native development builds

```sh
npm run ios
npm run android
```

Expo Go is not a release or verification target. Development builds are
required for biometrics, the share extension, OS quick actions, and the native
calendar export.

Native modules under `./modules`:

- `secure-share-intake`: receive one shared file into an issue or task, with
  its own app group `group.<application id>.secure-share-intake`.
- `native-quick-actions`: four fixed OS shortcuts (Home, Guide, Messages,
  Work), English and Spanish, with no protected value in any label or route.
- `native-calendar-export`: add a meeting through the system calendar editor.
- `network-policy`: low-data and network classification.
- `native-auth`: interface only. Union Ground ships no native sign-in code.

Reminders are scheduled on the device; the build does not register for remote
push (`plugins/with-local-notifications-only.js`).

### Native OS quick actions

iOS 16.4 and later publishes four fixed-destination, zero-input App
Intents/App Shortcuts: Home, Guide, Messages, and Work. Each action stages
only its fixed generic identifier, requires local device authentication, and
opens the foreground app, which maps it through the same strict route
allowlist native links use and then the normal sign-in, MFA, biometric
re-lock, hat, and PREVIEW gates. Android publishes the same four static
launcher shortcuts through `MainActivity`, carrying only
`unionground://os-quick-action/<home|compass|messages|work>`. No label,
phrase, identifier, or route ever names a worker, issue, task, campaign,
role, unread count, or other protected value.

## Your own app identity

The repository names no real Expo account, EAS project or store listing.
`config/mobile-release-foundation.json` carries placeholders: the
application id `org.example.unionground`, no Expo owner and no EAS project.
Whoever builds and publishes the app sets their own, in either place:

| Variable | What it is | Placeholder |
| --- | --- | --- |
| `MOBILE_APPLICATION_ID` | iOS bundle id and Android package (lowercase reverse-DNS, e.g. `org.yourorg.organizing`) | `org.example.unionground` |
| `EXPO_OWNER` | the Expo account or organization that owns the EAS project | none |
| `EAS_PROJECT_ID` | the EAS project UUID (`eas init` prints it) | none |

- **Locally and on EAS:** export the three as environment variables, or
  commit your values to `config/mobile-release-foundation.json` in your fork.
  EAS evaluates `app.config.ts` again on its own builders, so set them as EAS
  environment variables too (`eas env:create`), or keep them in the file.
  `config/mobile-app-links.json` must name the same application id before
  app links are enabled.
- **GitHub Actions:** set them as repository variables of the same names.
  `.github/workflows/mobile-ios-eas.yml` compares every build against them and,
  until all three are set, only reports that the release is not configured.
- **Server push:** the API refuses an `APNS_BUNDLE_ID` other than
  `MOBILE_APPLICATION_ID` (or the file's value when that is unset).

Development and preview builds run on the placeholders. Staging and
production (store) builds refuse to configure until all three are your own.

## Release gates

These remain open even after local checks pass:

- a dedicated Union Ground Supabase project, portal origin, and redirect
  allowlist, approved by the owner;
- Union Ground's own published privacy policy, terms, and legal
  instruments (the in-app legal reader currently describes the preview);
- Apple and Google records for your application id and the share
  extension, and signing identities in your own EAS project;
- before the next EAS build, carry the existing TestFlight build number into
  the EAS remote version source (`eas build:version:set`);
- physical iPhone and Android acceptance, as
  `docs/contracts/native-interaction-and-depth.md` requires: build or
  browser proof alone is not enough.

[`IOS_DEVICE_RUNBOOK.md`](./IOS_DEVICE_RUNBOOK.md) describes building and
verifying on a paired Mac and physical iPhone.
