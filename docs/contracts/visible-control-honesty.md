# Visible-control honesty contract

`docs/contracts/README.md` lists every area contract.

## Visible-control honesty contract

Binding rule, recorded 2026-09-06 upstream after inert controls on the native
messaging screens came back a second time.

- Every visible native control must have an accessibility role, an
  accessibility label, a handler, and — when it cannot act — an explicit
  disabled state or an honest non-action treatment. A glyph inside a bare
  `View` is not a control; either wire it or remove it.
- Preview-only fixture data must not be able to render as a live persisted
  capability. Gate it on the preview mode rather than relying on the live store
  simply not producing it.
- `tests/mobile-message-controls-contract.test.js` is the standing guard. It is
  a class check, not a point fix: it scans the messaging screens rather than the
  three controls this record happened to name.

### What a person is told: blocked controls, limits and failures

Binding rule, recorded November 22, 2026 upstream, after an audit of that day
found 227 places on the web and the phone where a person got no feedback. It
binds every web and phone screen, not only the
native controls above. A disabled state alone does not meet it.

- (a) **A blocked control states its reason.** A control blocked by what the
  person typed or left out names the unmet rule in words next to it, for
  example "Use at least 24 characters to continue." A busy control is exempt
  but looks different from a blocked one. Two patterns meet it: the shared web
  button's `disabledReason` (`src/components/BusyControls.jsx` and
  `src/components/Button.jsx`), which keeps the button reachable,
  shows the reason beside it and reads it out on press; or a button that stays
  pressable and whose press shows the rule (the password change form in
  `src/views/SettingsView.jsx`).
- (b) **A limit is stated before it is tripped.** A length, format, count or
  file limit is shown before the person reaches it, and input is never cut
  silently. The number comes from the policy constant, never typed.
- (c) **A failure names its cause and keeps what the person typed.** A failed
  save, send or load shows a message that says what happened and what to do
  next, keeps what was typed and offers a retry. A failed load is never shown
  as an empty list, and no connection is reported as no connection.
- (d) **A wait ends.** A wait ends in a result or in an error with a retry.
- (e) **A quiet success is confirmed.** An action that succeeds without a
  visible change says so.

Every message is in each language the screen's strings exist in, sits next
to the control or field it is about, and is announced to a screen reader (a
role or live region on the web, `accessibilityRole` or a live region on the
phone).

Enforcement is not on yet. Nothing in CI fails on this rule today: it is
held by review. `node scripts/lib/blocked-control-scan.mjs --list` is a
reporting tool for rule (a) on web screens. It reads the tracked files under
`src/` as text and lists each `<button>`, or component whose name ends in
`Button`, with a top-level `disabled` attribute whose gate does not look
busy-only and with no `disabledReason`. It is a hint, not a verdict: it
decides "busy" by how a gate's names are spelled (`disabled={loading}` is
taken to mean loading), it does not see a `disabled` inside a spread, a
wrapper component not named like a button, `React.createElement`, a
`select`, an `input` or a link, and it counts button markup inside a string.
An enforcing guard (a baseline that may only shrink, compared with the default
branch, with classification a rename cannot change and a one-line exemption a
developer can write next to a button the scanner reads wrongly) is planned as
its own change. The phone joins when its shared button takes a reason. Rules
(b) to (e) cannot be read by a scanner; reviewers check them by walking each
screen with wrong input.
