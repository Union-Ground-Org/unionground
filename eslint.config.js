// Minimal flat config. Scope is deliberately narrow — `npm run lint` targets
// src/, api/, scripts/ and the root build config only. The many untracked or
// generated top-level directories (dist/, coverage/, reports/, playwright
// output, …) are ignored so a bare `npx eslint .` stays useful too.
//
// Three blocks of their own follow the shared rules: the
// native app's build-time JavaScript, the service worker, and the test suite.
// react-hooks/exhaustive-deps is the reason a linter exists here at all: an
// effect keyed on a value rebuilt every token refresh once tore the whole
// member shell down hourly.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

// formatDateTime prints a time in the device's zone without naming the zone;
// 25 "missing Eastern label" BUG records in a month came from it, one screen
// at a time. Shown times go through formatDateTimeWithZone instead.
const UNLABELED_TIME_MESSAGE =
  "formatDateTime shows a time without its zone. Use formatDateTimeWithZone from src/lib/i18n/zonedDates.js (or the i18n.js barrel).";
// Named imports and calls, and any reach through a namespace import
// (`dates.formatDateTime` or `dates["formatDateTime"]`).
const UNLABELED_TIME_FORMATTER = [
  { selector: "ImportSpecifier[imported.name='formatDateTime']", message: UNLABELED_TIME_MESSAGE },
  { selector: "CallExpression[callee.name='formatDateTime']", message: UNLABELED_TIME_MESSAGE },
  { selector: "MemberExpression[computed=false][property.name='formatDateTime']", message: UNLABELED_TIME_MESSAGE },
  { selector: "MemberExpression[computed=true][property.value='formatDateTime']", message: UNLABELED_TIME_MESSAGE },
];

// UX-UG-TIMES-SHOWN-WITHOUT-A-ZONE-AND-IN-SEVERAL-FORMATS-20261122
// (#9530): the bare stamp, dateTimeFormat(lang) with no options or a Date's
// toLocaleString() with no arguments, printed "21/8/2025, 1:00:00 p. m."
// with seconds and no zone on the Casework hub and the Admin desks. The
// selectors are syntax only: they catch dateTimeFormat(x).format(...) and
// new Date(...).toLocaleString(). A Date held in a variable and then
// .toLocaleString() is not caught, and a zero-argument toLocaleString() on
// any value is not refused, because that would also refuse number formatting.
const BARE_STAMP_MESSAGE =
  "A bare date-and-time stamp shows seconds and no zone. Use formatGroupMoment (a moment) or formatCalendarDay (a day) from src/lib/i18n/zonedDates.js.";
const BARE_STAMP = [
  { selector: "CallExpression[callee.property.name='format'][callee.object.type='CallExpression'][callee.object.callee.name='dateTimeFormat'][callee.object.arguments.length<2]", message: BARE_STAMP_MESSAGE },
  { selector: "CallExpression[callee.property.name='toLocaleString'][arguments.length=0][callee.object.type='NewExpression'][callee.object.callee.name='Date']", message: BARE_STAMP_MESSAGE },
];

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "e2e/**",
      "docs/**",
      "**/*.min.js",
      "supabase/.temp/**",
      // Deliberately unsafe and safe code samples the security-scanner tests
      // feed to semgrep; they are fixtures, not runnable modules.
      "tests/fixtures/security-scanners/**",
      ".playwright-cli/**",
      // The native app's generated and installed trees; its TypeScript is held
      // by `npm run check --prefix apps/mobile` (strict tsc and Vitest).
      "apps/mobile/dist/**", "apps/mobile/node_modules/**", "apps/mobile/ios/**", "apps/mobile/android/**", "apps/mobile/.expo/**",
    ],
  },

  // Browser + React application code.
  {
    files: ["src/**/*.{js,jsx}", "packages/shared-core/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        __UNIONGROUND_BRAND__: "readonly",
        __UNIONGROUND_OFFICIAL_MARK__: "readonly",
        __UNIONGROUND_OFFICIAL_HOSTS__: "readonly",
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": ["error", ...UNLABELED_TIME_FORMATTER, ...BARE_STAMP],
    },
  },

  // The formatter's own module, which defines formatDateTime, is the only
  // exemption; every other web file uses formatDateTimeWithZone.
  {
    files: ["src/lib/i18n/format.js"],
    rules: { "no-restricted-syntax": "off" },
  },

  // Vercel serverless handlers: Node runtime, no DOM.
  {
    files: ["api/**/*.{js,mjs}"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Browser-automation driver: runs under Node, but its page.evaluate()
  // callbacks are serialized and executed inside the remote page, so `window`
  // and `document` are legitimately in scope there.
  {
    files: ["scripts/verify-workload-browser.mjs"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Operational scripts and the root build config: Node only.
  {
    files: ["scripts/**/*.{js,mjs}", "demo-bots/**/*.mjs", "*.config.{js,mjs}", "eslint.config.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // Union Ground: native build-time JavaScript. Expo config plugins and the
  // Metro config are CommonJS evaluated by Node; the audit and proof scripts
  // are Node ES modules.
  {
    files: ["apps/mobile/**/*.{js,cjs}"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs", globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
  {
    files: ["apps/mobile/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "warn",
      "no-control-regex": "off",
    },
  },

  // Union Ground: the service worker runs in a ServiceWorkerGlobalScope.
  {
    files: ["public/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "script", globals: { ...globals.serviceworker, ...globals.browser } },
    rules: {
      ...js.configs.recommended.rules,
      // `let x = null; try { x = f(); } catch { x = null; }` is deliberate in the
      // worker's push handler: it states the fallback beside the parse.
      "no-useless-assignment": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-var": "error",
    },
  },

  // Union Ground: tests get both environments plus the Vitest globals.
  {
    files: ["tests/**/*.{js,jsx,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node, ...globals.vitest },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { varsIgnorePattern: "^[A-Z_]", argsIgnorePattern: "^_" }],
      // Some assertions deliberately pin control characters.
      "no-control-regex": "off",
      // The service-worker tests compile public/sw.js with `new Function` and
      // carry eslint-disable-next-line directives for exactly that.
      "no-new-func": "error",
    },
  },
];
