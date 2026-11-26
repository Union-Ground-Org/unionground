# Translation area modules

The web catalogue's strings live here, one module per screen or area and one
folder per language: `en/<area>.js` holds the English table and `es/<area>.js`
the Spanish one for the same keys. `src/lib/i18n.js` spreads the English
modules into `catalogue.en`, and `src/lib/i18n/es.js` (loaded on demand)
spreads the Spanish ones, so `t()` and every export are unchanged. Add or edit a
key in its area module, never in the assembled file: find the module that
already holds the key's first segment (`git grep -l '"admin\.' src/lib/i18n/locales/en`),
put the English string there and the Spanish string at the same place in the
matching `es/` module. A new first segment goes into the one area that fits it,
in both languages. Only the legal release keys (`legal.*`,
`landing.interestConsent`, `landing.aiDisclosure`) stay inline in
`src/lib/i18n.js` and `src/lib/i18n/es.js`, because the legal release tooling
hashes their lines in those two files. The namespace chunks one level up
(`src/lib/i18n/<namespace>.js`) and the feature namespaces in
`src/lib/i18n/features/` are unchanged. `tests/i18n.test.js` refuses a key
declared twice, a first segment split across modules or languages, and English
and Spanish modules whose keys differ.

Spanish data from the shared namespace APIs lives in `es/namespaces/`.
Its namespace module one level above keeps the English table and exposes
Spanish through a getter, preserving synchronous native and Node imports.
The browser build's catalogue plugin redirects those Spanish imports to live
bindings in `spanishNamespaces.js`; the on-demand `es.js` load fills them from
the real Spanish modules before rendering. This also covers helpers imported
directly by the English screen. Edit a namespace's Spanish copy in its data
module, and keep its exported binding in the registry and `es.js` registration.
`tests/i18n-spanish-load.test.js` builds the shared APIs and proves that English
fetches no Spanish namespace data and that loading Spanish restores every table.
