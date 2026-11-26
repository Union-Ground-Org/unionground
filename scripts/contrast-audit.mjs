// Audits real values: pairs are variable names resolved through src/sg-tokens.css
// plus the app and coordinator theme roots, so token drift fails the audit instead of
// silently diverging from a hardcoded hex table.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectVars, scopedVars } from "./lib/css-vars.mjs";

/**
 * Every pair this app promises to keep readable, and the ratio it promises.
 *
 * Exported so tests/styles-token-aliases.test.js can pin the table's SHAPE.
 * Until it was, the only pin was a substring search of this file's source for
 * the five aliased names — which asks whether a name appears anywhere in the
 * text, not whether it is measured. Deleting the row for an unaliased name, or
 * lowering a row's minimum from 4.5 to 1, left every test green and the audit
 * exiting 0 while the pair it stopped guarding went unreadable.
 *
 * A minimum here is a WCAG threshold, never a number chosen to fit the value
 * we happen to have: 4.5 is 1.4.3 body text, 3 is 1.4.11 non-text UI, 7 is AAA.
 * The test rejects any other number, so relaxing a bar has to be argued for as
 * a change of standard rather than slipped in as a digit.
 */
export const pairs = [
  ["--background", "--foreground", 4.5, "Page text"],
  ["--card", "--card-foreground", 4.5, "Cards"],
  ["--popover", "--popover-foreground", 4.5, "Dialogs and floating panels"],
  ["--primary", "--primary-foreground", 4.5, "Primary surfaces and actions"],
  ["--compass-surface", "--compass-foreground", 4.5, "Compass quick-action heading"],
  ["--compass-surface", "--compass-muted-foreground", 4.5, "Compass quick-action supporting copy"],
  ["--secondary", "--secondary-foreground", 4.5, "Secondary controls"],
  ["--card", "--border", 3, "Member app-theme picker boundaries"],
  ["--card", "--ring", 3, "Member app-theme picker focus indicator"],
  ["--secondary", "--ring", 3, "Selected member app-theme picker indicator"],
  ["--muted", "--muted-foreground", 4.5, "Quiet surfaces and metadata"],
  ["--accent", "--accent-foreground", 4.5, "Progress and accent controls"],
  ["--destructive", "--destructive-foreground", 4.5, "Overdue and destructive states"],
  ["--terra-soft", "--terra-soft-foreground", 4.5, "Terra status chips"],
  ["--notice", "--notice-foreground", 4.5, "Caution banners, offline banner, gold deltas"],
  ["--success", "--success-foreground", 4.5, "Guide avatar and success affordances"],
  ["--disabled", "--disabled-foreground", 4.5, "Disabled controls"],
  ["--status-surface", "--status-foreground", 4.5, "Status chips"],
  ["--toast", "--toast-foreground", 4.5, "Toasts"],
  ["--primary", "--primary-muted-foreground", 4.5, "Quiet copy on primary hero surfaces"],
  ["--input", "--foreground", 4.5, "Search and text input"],
  ["--input", "--green", 3, "Signature ink against the drawing surface"],
  ["--input", "--border", 3, "Signature drawing boundary"],
  ["--input", "--ring", 3, "Signature drawing focus indicator"],
  ["--border", "--background", 3, "Meaningful non-text boundaries"],
  ["--ring", "--background", 3, "Focus indicator"],
  // Added with the styles.css token pass. Both aliases were being edited with
  // no row to measure them: --status-foreground is the pill text on
  // --status-surface AND, through --task-status-backlog, a 4px border-left on
  // .task-card, so it carries a 1.4.11 non-text duty as well; --success is the
  // done state, painted on --card by .timeline-bar and on --success-foreground
  // by .guide-avatar. An unaudited alias is one a later repoint moves silently.
  ["--status-surface", "--status-foreground", 4.5, "Status pills and task board metadata"],
  ["--success", "--success-foreground", 4.5, "Done and confirmed states"],
  ["--card", "--success", 4.5, "Success text and rules on cards"],
  // Added with the dark-scope pass. Each of these was painted by a real rule
  // and measured by nothing, which is why every one of them held in the light
  // theme and three of them collapsed the moment the tasks board's per-screen
  // dark palette repointed --primary to gold. A scope dimension alone would not
  // have caught them: run against the table as it stood, all fourteen rows
  // above PASS under dark. The hole was never "the audit reads one scope", it
  // was "the audit measures token pairs that share a name-stem, and the app
  // paints pairs that do not".
  //
  // That palette is retired (2026-07-28) and its scope is gone from `scopes`
  // below, but these five rows STAY. They are the derivation's output, not the
  // palette's: each names a pair a live rule paints, and system dark mode
  // returns as a design-system token PR. Deleting a row because the scope that
  // exposed it went away is how the pair goes back to being unmeasured.
  ["--hero-surface", "--hero-ink", 4.5, "Progress hero heading"],
  ["--hero-surface", "--accent", 4.5, "Progress hero eyebrow, and the ring's arc against the panel"],
  ["--hero-surface", "--primary-muted-foreground", 4.5, "Progress hero supporting copy"],
  ["--accent", "--primary-deep", 3, "Progress ring arc against its own track"],
  ["--home-streak-surface", "--home-streak-ink", 4.5, "Home and rewards streak chips"],
  ["--green-soft", "--priority-low-ink", 4.5, "Low-priority pill"],
  // Derived, not chosen. Everything above this line was assembled by reasoning
  // about which pairs looked risky, and that method has now failed twice in one
  // PR: first on the hero, then on --ink — the alias thirty rules paint as text,
  // which the retired dark palette re-pointed three lines from the ones that
  // pass edited, and which no row measured. Re-point --ink alone and the entire
  // board rendered 1.12:1 with the audit exiting 0 and 1332 tests green.
  //
  // These ten are every pair a single .task* rule paints as background+color
  // that had no row, enumerated by paintedPairs() rather than picked. All ten
  // PASS today in all three scopes; they are guards, not fixes. The eleventh,
  // --terra-soft under --destructive, is the one that fails (4.12:1 in LIGHT)
  // and is argued as an exception in the test file rather than added here,
  // because a row it cannot meet would red the build for a defect this PR
  // cannot fix.
  //
  // Several look redundant beside a row above — --card/--ink next to
  // --card/--card-foreground, --canvas/--ink next to --background/--foreground.
  // They are not. Each pair of names holds the same hex in every scope today
  // only because someone kept both in sync by hand, and a row that passes by
  // coincidence is indistinguishable from one that passes by construction right
  // up until the coincidence ends. The name the RULE paints is the one that has
  // to be measured.
  ["--canvas", "--ink", 4.5, "Screen background and base text"],
  ["--card", "--ink", 4.5, "Card text, dialogs, the task editor and its buttons"],
  ["--card-2", "--ink", 4.5, "Sunken card text"],
  ["--input", "--ink", 4.5, "Text typed into a field"],
  ["--track", "--ink", 4.5, "Text on a rail or scope chip"],
  ["--card", "--muted-foreground", 4.5, "Metadata on a card"],
  ["--card-2", "--muted-foreground", 4.5, "Metadata on a sunken card"],
  ["--track", "--muted-foreground", 4.5, "Metadata on a rail"],
  ["--rail-surface-start", "--rail-text", 4.5, "Desktop rail idle hat and navigation text at gradient start"],
  ["--rail-surface-end", "--rail-text", 4.5, "Desktop rail idle hat and navigation text at gradient end"],
  ["--rail-surface-end", "--rail-sect", 4.5, "Desktop rail group labels on the resolvable rail surface"],
  ["--rail-surface-start", "--rail-ink", 4.5, "Desktop rail selected hat and hover text at gradient start"],
  ["--rail-surface-end", "--rail-ink", 4.5, "Desktop rail selected hat and hover text at gradient end"],
  ["--rail-surface-start", "--rail-focus", 3, "Desktop rail hat focus ring at gradient start"],
  ["--rail-surface-end", "--rail-focus", 3, "Desktop rail hat focus ring at gradient end"],
  ["--rail-hover", "--rail-ink", 4.5, "Desktop rail hovered navigation and hat text"],
  ["--rail-selected", "--rail-ink", 4.5, "Desktop rail selected hat text"],
  ["--rail-current", "--rail-current-foreground", 4.5, "Desktop rail current page row (the identity paints it white with Union green text)"],
  ["--rail-current-foreground", "--rail-current", 4.5, "Desktop rail count inside the current page row"],
  ["--rail-mark", "--rail-mark-foreground", 4.5, "Desktop rail Union Ground mark"],
  ["--rail-control", "--rail-control-foreground", 4.5, "Desktop rail collapse, profile and compact hat controls"],
  ["--rail-control", "--rail-ink", 4.5, "Desktop rail shared-work destination"],
  ["--rail-popover", "--rail-popover-foreground", 4.5, "Desktop rail compact hat menu"],
  ["--rail-surface-start", "--rail-control-border", 3, "Desktop rail control boundary at gradient start"],
  ["--rail-surface-end", "--rail-control-border", 3, "Desktop rail control boundary at gradient end"],
  ["--rail-control", "--rail-control-border", 3, "Desktop rail control boundary"],
  ["--rail-popover", "--rail-control-border", 3, "Desktop rail compact hat menu boundary"],
  ["--rail-control", "--rail-focus", 3, "Desktop rail control focus indicator"],
  ["--rail-popover", "--rail-focus", 3, "Desktop rail compact hat menu focus indicator"],
  ["--chapter-rail-surface-start", "--chapter-rail-muted", 4.5, "Chapter rail metadata at gradient start"],
  ["--chapter-rail-surface-mid", "--chapter-rail-muted", 4.5, "Chapter rail metadata at gradient mid"],
  ["--chapter-rail-surface-end", "--chapter-rail-muted", 4.5, "Chapter rail metadata at gradient end"],
  ["--chapter-rail-surface-start", "--chapter-rail-foreground", 4.5, "Chapter rail text at gradient start"],
  ["--chapter-rail-surface-mid", "--chapter-rail-foreground", 4.5, "Chapter rail text at gradient mid"],
  ["--chapter-rail-surface-end", "--chapter-rail-foreground", 4.5, "Chapter rail text at gradient end"],
  ["--chapter-rail-signal", "--chapter-rail-foreground", 4.5, "Chapter rail header text"],
  ["--chapter-rail-signal", "--chapter-rail-muted", 4.5, "Chapter rail group labels"],
  ["--chapter-rail-selection", "--chapter-rail-muted", 4.5, "Selected chapter metadata"],
  ["--chapter-rail-selection", "--chapter-rail-selection-foreground", 4.5, "Selected chapter row text"],
  ["--chapter-rail-popover", "--chapter-rail-popover-foreground", 4.5, "Collapsed chapter tooltip"],
  ["--chapter-rail-popover", "--chapter-rail-muted", 4.5, "Chapter filter placeholder"],
  ["--chapter-rail-accent", "--chapter-rail-accent-foreground", 4.5, "Chapter abbreviation tile"],
  ["--chapter-rail-surface-start", "--chapter-rail-border", 3, "Chapter rail control boundary at gradient start"],
  ["--chapter-rail-signal", "--chapter-rail-border", 3, "Chapter rail header boundary"],
  ["--chapter-rail-popover", "--chapter-rail-border", 3, "Chapter filter and tooltip boundary"],
  ["--chapter-rail-selection", "--chapter-rail-border", 3, "Selected chapter row boundary"],
  ["--chapter-rail-surface-start", "--chapter-rail-ring", 3, "Chapter rail focus indicator"],
  ["--chapter-rail-signal", "--chapter-rail-ring", 3, "Chapter rail header focus indicator"],
  ["--chapter-rail-popover", "--chapter-rail-ring", 3, "Chapter filter focus indicator"],
  ["--chapter-rail-selection", "--chapter-rail-accent", 3, "Selected chapter edge"],
  ["--chapter-rail-selection", "--chapter-rail-ring", 4.5, "Pinned chapter indicator"],
  ["--card", "--destructive", 4.5, "Destructive action on a card"],
  ["--notice", "--notice-foreground", 4.5, "Medium-priority pill"],
  // The same derivation, run over the WHOLE sheet instead of the tasks board.
  //
  // The ten rows above were derived, but from a FILTERED set: paintedPairs()
  // restricted to selectors matching /task/i. That filter was the last piece of
  // this table still chosen by hand, and it was wrong in both directions. It
  // could be emptied — narrow it to something that matches nothing and the
  // coverage guard inspects zero rules and passes. And it leaked: the board's
  // own timeline view names its rules `timeline-*`, so `.timeline-row__label`
  // was never "a tasks selector" to the filter despite rendering inside
  // .tasks-screen.
  //
  // So the boundary is gone. These eleven are every remaining pair any rule in
  // src/styles.css paints as background+color in one block, and each already
  // clears 4.5:1 in all three scopes — they cost nothing to adopt and they end
  // the era of the audit measuring a hand-picked corner of the sheet. Five more
  // pairs exist that do NOT clear it; they are argued by name, with their
  // measured ratios, in tests/styles-token-aliases.test.js rather than given a
  // row they cannot meet.
  ["--card", "--foreground", 4.5, "Reward chips and card body text"],
  ["--card-2", "--foreground", 4.5, "Staff switcher entries"],
  ["--muted", "--foreground", 4.5, "Hovered quiet controls"],
  ["--card", "--green", 4.5, "Affirmative text, skip link and outline pills on a card"],
  ["--card", "--terra", 4.5, "Secondary dialog action"],
  ["--card", "--mcases-terra", 4.5, "My cases due line and step chip on a case card"],
  ["--green", "--primary-foreground", 4.5, "Selected choice, completion seal, member message"],
  ["--input", "--muted-foreground", 4.5, "Search field metadata"],
  ["--disabled", "--disabled-foreground", 4.5, "Disabled send button"],
  ["--toast", "--toast-foreground", 4.5, "Toast notice"],
  // The last two arrived with the product hub, after this sweep was already
  // written. They are here rather than in the exception ledger for the reason
  // the ledger's own guard insists on: both clear 4.5:1 in every scope, so an
  // excuse would be a polite way to stop measuring them. --card/--primary is
  // the tightest of the eleven at 5.69:1, and only in `tasks dark`.
  ["--card", "--primary", 4.5, "Rights and legal links on a card"],
  ["--card-2", "--card-foreground", 4.5, "Hub thread list entries"],
  // Case dashboards (REQ-UG-CASEWORK-CONSOLE-54). The five categorical
  // series are non-text UI that CARRIES the meaning of a bar, a column and a
  // plotted point, so 1.4.11's 3:1 is the bar each must clear on the chart
  // surface. They are listed as five rows rather than one because the series
  // are repointed as a set on the night-shift system theme, and a set repointed
  // together is a set where exactly one member can quietly go wrong.
  ["--card", "--case-chart-1", 3, "Case dashboards: open-cases-by-step bars"],
  ["--card", "--case-chart-2", 3, "Case dashboards: deadlines-due-soon columns"],
  ["--card", "--case-chart-3", 3, "Case dashboards: cases-per-assignee bars"],
  ["--card", "--case-chart-4", 3, "Case dashboards: overdue-deadline bars"],
  ["--card", "--case-chart-5", 3, "Case dashboards: median-days-per-step line and points"],
  ["--canvas", "--foreground", 4.5, "Public document shell text"],
  ["--green-soft", "--foreground", 4.5, "Profile visibility guidance"],
  ["--sg-color-card-2", "--sg-color-green-text", 4.5, "Voice action controls"],
  ["--sg-color-green-soft", "--sg-color-ink", 4.5, "Voice steward guidance"],
  ["--sg-color-green", "--sg-color-card", 4.5, "Voice affirmative actions"],
  // The three the retired dark palette used to hold hostage.
  //
  // Each of these was painted by a real rule, cleared 4.5:1 everywhere it could
  // actually render, and failed ONLY under `.tasks-screen--dark` — a scope none
  // of them could reach, because dialogs, StatCard/FloatingControls and
  // ProductHubView all render outside the tasks subtree. They were therefore
  // parked in tests/styles-token-aliases.test.js's exception ledger on a
  // REACHABILITY argument: excused from having a row because the only scope
  // that failed them was unreachable.
  //
  // With that palette deleted there is no failing scope left to argue about, so
  // the excuse expires and the ledger's own rule applies — "clears 4.5:1 in
  // every scope; give it a row instead of an excuse". These are those rows.
  // Moving them here rather than dropping them is the point: an excuse that
  // stops being needed should turn into coverage, not into silence.
  ["--green-soft", "--muted-foreground", 4.5, "Anonymity note on a mint dialog panel"],
  ["--green-soft", "--green", 4.5, "Positive delta chip, selected persona, tour link"],
  ["--primary-deep", "--primary-foreground", 4.5, "Product hub intro panel"],
  // Wave 2a (pixel-parity chrome/home/reports/voting/morehub). Same derivation
  // as the sweeps above: every one of these is a pair a new rule paints as
  // background+color in one block, enumerated by paintedPairs(), not picked.
  // Several name --sg-* tokens directly because the rebuilt screens paint the
  // prototype's own token names rather than the app-alias layer; the name the
  // RULE paints is the one that has to be measured. All clear 4.5:1 today.
  // The one pair the sweep found FAILING — --sg-color-warn on --sg-color-warn-
  // soft at 3.26:1 — was not excused: the chips were repointed to --amber-ink,
  // the prototype's own amber text ink, which is the last row here at 4.83:1.
  ["--canvas", "--green", 4.5, "More-hub steward CTA button label"],
  ["--card", "--sg-color-sec", 4.5, "Home search placeholder row"],
  ["--gold", "--sg-color-ink-on-gold", 4.5, "Customize pill and gold report pills"],
  ["--green", "--sg-color-card", 4.5, "Mobile top-bar avatar initials"],
  ["--sg-color-canvas", "--sg-color-ink", 4.5, "Pulse option chip"],
  ["--sg-color-card-2", "--sg-color-ink", 4.5, "Soft voting buttons"],
  ["--sg-color-card-2", "--sg-color-sec", 4.5, "Official-ballot chips and muted vote strips"],
  ["--sg-color-card", "--sg-color-green", 4.5, "Verify link on a voted card"],
  ["--sg-color-card", "--sg-color-ink", 4.5, "Verify links and the poll-suggestion input"],
  ["--sg-color-card", "--sg-color-sec", 4.5, "Voting tab at rest"],
  ["--sg-color-card", "--sg-color-green-text", 4.5, "Event scope label on the next-up hero"],
  ["--sg-color-gold", "--sg-color-ink-on-gold", 4.5, "Ballot hero CTAs, steward hat pill, open chips"],
  ["--sg-color-gold", "--voting-gold-ink", 4.5, "Mobile hero Approve button"],
  ["--sg-color-green-soft", "--sg-color-green-text", 4.5, "Receipt seals, availability and points chips"],
  ["--sg-color-green", "--primary-foreground", 4.5, "Home ballot card CTA"],
  ["--sg-color-green", "--sg-color-canvas", 4.5, "Dark home chip"],
  ["--sg-color-hero", "--primary-foreground", 4.5, "Home hero banner"],
  ["--sg-color-hero", "--sg-color-card", 4.5, "Rail footer avatar initials"],
  ["--sg-color-ink", "--sg-color-canvas", 4.5, "Selected poll-scope chip"],
  ["--sg-color-warn-soft", "--amber-ink", 4.5, "Closing-soon chips and vote counts"],
  // Wave 2b (pixel-parity cases/inbox/learn/events/rewards + header strip).
  // Same paintedPairs() derivation; all measure >=4.5:1 today. The sweep's two
  // finds were FIXED, not excused: the learn terra chip/button arrived at the
  // prototype's #c25b3a (3.40:1) and ships darkened as --learn-terra-ink
  // (4.70/5.98), and the rewards hero chip arrived on the prototype's gold
  // wash (3.30:1) and ships on an rgba scrim literal that lives in the
  // background ledger (5.90:1 composited) rather than as an unmeasurable pair.
  ["--card-2", "--sec", 4.5, "Cases desk latest-note bar"],
  ["--card2", "--sec", 4.5, "Inbox search pill icon and placeholder"],
  ["--gold", "--voting-gold-ink", 4.5, "Cases desk current milestone node"],
  ["--green-text", "--primary-foreground", 4.5, "Cases desk done milestone node"],
  ["--green", "--canvas", 4.5, "Events next-up hero panel ink (the body copy paints green-tint, an inherited-surface paint outside pair derivation)"],
  ["--green", "--card", 4.5, "Events green action button"],
  ["--green", "--gold", 4.5, "Events green icon tile and hero eyebrow"],
  ["--learn-terra-ink", "--sg-color-card", 4.5, "Learn request-a-steward button"],
  ["--card-2", "--learn-terra-ink", 4.5, "Member operations import row errors"],
  ["--sg-color-card-2", "--ink", 4.5, "Events disclosure chevron, date-block day, code tile"],
  ["--sg-color-card", "--ink", 4.5, "Appointment slot chips, type cards and time/date inputs"],
  ["--sg-color-terra-soft", "--learn-terra-ink", 4.5, "Learn walkthrough chip"],
  // Wave 2c (pixel-parity forms/workload/hub/compass/settings-inner + the new
  // Be-heard screen). Same paintedPairs() derivation; all measure >=4.5:1.
  // The workload danger ink arrived at the proto's #b14e30 (4.06:1 on
  // danger-soft) and ships as var(--learn-terra-ink) #a04a2c — the same
  // darkened terra Wave 2b derived independently for Learn.
  ["--card2", "--ink", 4.5, "Workload ghost buttons and settings chips on the sunken surface"],
  ["--card", "--sec", 4.5, "Workload steppers and hub tabs at rest"],
  ["--green-soft", "--green-text", 4.5, "Hub green status chips"],
  ["--card", "--green-text", 4.5, "Inbox section action and Show-all expander on the panel"],
  ["--green-soft", "--ink", 4.5, "Hub minutes quote block"],
  ["--sg-color-canvas", "--sg-color-green", 4.5, "Be-heard scope pill, selected state"],
  ["--sg-color-danger-soft", "--mwl-danger-ink", 4.5, "Workload trending chip and clear-all danger button"],
  ["--sg-color-danger-soft", "--learn-terra-ink", 4.5, "Institutional record archived and error states"],
  ["--sg-color-hero", "--card", 4.5, "Institutional record primary actions"],
  // Union structure map (REQ-UG-UNION-STRUCTURE-VIEW-20261003). Two
  // non-text marks drawn on the public card: the national bodies' discs and
  // the filed-body dots, each a magnitude mark that carries meaning on its own,
  // so 1.4.11's 3:1 is the bar. The canvas reads these names through
  // getComputedStyle at draw time, so the rows measure what it paints.
  ["--card", "--sg-color-hero", 3, "Union structure map: national body discs"],
  ["--card", "--sg-color-green", 3, "Union structure map: filed-body dots"],
  ["--card", "--primary", 3, "Union structure map: hover and selection ring"],
  // Union network map (REQ-UG-UNION-NETWORK-MAPS-20261003). The rotatable
  // SVG stage on the same public card: national discs, their far-side dashed
  // outlines and the shared-connection lines in --sg-color-hero, filed dots
  // and structure lines in --sg-color-green, the selection ring in --primary.
  // Depth switches to a dashed outline in the same colour, never a fade.
  ["--card", "--sg-color-hero", 3, "Union network map: national discs, far-side outlines and shared lines"],
  ["--card", "--sg-color-green", 3, "Union network map: filed dots and structure lines"],
  ["--card", "--primary", 3, "Union network map: selection ring"],
  ["--card", "--foreground", 4.5, "Union network map: stage labels on their card plates"],
  ["--sg-color-warn-soft", "--notice-foreground", 4.5, "Institutional record draft and history-gap notices"],
  // Wave 2d (pixel-parity public surfaces: landing, sign-in flow, verify
  // receipt).: landings are light by default.
  // --pub-canvas/--pub-ink alias cream/forest so display and body ink stay
  // dark on the cream door. Green feature cards keep cream type.
  ["--canvas", "--forest", 4.5, "Pre-auth shell: forest wordmark and ink on the cream landing"],
  ["--pub-canvas", "--pub-ink", 4.5, "Public landing: forest display and body ink on the cream ground"],
  ["--pub-canvas", "--pub-sage", 4.5, "Public landing: supporting copy on the cream ground"],
  ["--pub-canvas", "--pub-border", 3, "Public landing: controls and product-window boundary"],
  ["--gold", "--pub-gold-ink", 4.5, "Landing gold CTAs and the pressed language toggle"],
  ["--pub-surface", "--pub-surface-foreground", 4.5, "Landing product rail, feature cards, hover controls, and final CTA"],
  ["--pub-surface-foreground", "--pub-surface", 4.5, "Landing final-CTA secondary hover invert"],
  ["--pub-surface", "--pub-surface-muted-foreground", 4.5, "Landing preview and feature-card supporting text"],
  ["--pub-surface", "--sg-color-gold-soft", 4.5, "Landing dark-panel eyebrows on the green surface"],
  ["--pub-light-surface", "--pub-light-foreground", 4.5, "Landing preview cards and toolbar text"],
  ["--pub-light-surface", "--pub-light-muted-foreground", 4.5, "Landing preview card metadata"],
  ["--pub-light-surface", "--pub-light-border", 3, "Landing preview card and toolbar boundaries"],
  ["--pub-light-surface", "--pub-ink", 4.5, "Landing closing-band intake link hover"],
  ["--pub-light-surface-alt", "--pub-light-foreground", 4.5, "Landing preview canvas heading"],
  ["--pub-light-surface-alt", "--pub-light-muted-foreground", 4.5, "Landing preview canvas body"],
  ["--pub-success-surface", "--pub-success-foreground", 4.5, "Landing positive preview state"],
  // The signed-out site's two looks
  // (REQ-UG-SIGNED-OUT-SITE-PINE-LOOK-COMPARED-WITH-LIGHT-20261117).
  // Pine: the header, footer, hero and closing band run from pine to Union
  // green, with the lighter green under the hero's glow and on the footer
  // chips, so each text colour is measured on all three. Paper: the tinted
  // seats band, the gold-soft statement band and the four seat colours.
  ["--sg-light-brand-deep", "--sg-light-on-primary", 4.5, "Signed-out site (pine): names, headline and links on pine"],
  ["--sg-light-brand", "--sg-light-on-primary", 4.5, "Signed-out site (pine): headline at the Union green end of the band"],
  ["--sg-light-brand-2", "--sg-light-on-primary", 4.5, "Signed-out site (pine): headline over the hero's glow, Follow chip name and updates panel"],
  ["--sg-light-brand-deep", "--sg-light-rail-ink", 4.5, "Signed-out site (pine): header links and footer text on pine"],
  ["--sg-light-brand", "--sg-light-rail-ink", 4.5, "Signed-out site (pine): hero and band body at the Union green end"],
  ["--sg-light-brand", "--sg-light-rail-label", 4.5, "Signed-out site (pine): labels, status and captions at the Union green end"],
  ["--sg-light-brand-2", "--sg-light-rail-label", 4.5, "Signed-out site (pine): labels over the hero's glow and the handle on a Follow chip"],
  ["--sg-light-brand-deep", "--sg-light-accent-on-dark", 4.5, "Signed-out site (pine): the headline's gold lead words on pine"],
  ["--sg-light-brand", "--sg-light-accent-on-dark", 4.5, "Signed-out site (pine): the headline's gold lead words at the Union green end"],
  ["--sg-light-card", "--sg-light-brand-deep", 4.5, "Signed-out site (pine): Sign in on its white button"],
  ["--sg-light-canvas", "--sg-light-brand", 4.5, "Signed-out site (paper): green headline and section titles on the canvas"],
  ["--sg-light-canvas", "--sg-light-placeholder", 4.5, "Signed-out site (paper): the product picture's caption on the canvas"],
  ["--sg-light-brand-tint", "--sg-light-brand", 4.5, "Signed-out site: section title on the tinted band"],
  ["--sg-light-brand-tint", "--sg-light-ink-2", 4.5, "Signed-out site: supporting copy on the tinted band"],
  ["--sg-light-accent-soft", "--sg-light-on-accent", 4.5, "Signed-out site: the statement band"],
  ["--sg-light-chart-1", "--sg-light-on-primary", 4.5, "Signed-out site: Member seat initials and role pill"],
  ["--sg-light-chart-2", "--sg-light-on-primary", 4.5, "Signed-out site: Steward seat initials and role pill"],
  ["--sg-light-chart-3", "--sg-light-on-primary", 4.5, "Signed-out site: Coordinator seat initials and role pill"],
  ["--sg-theme-chart-4", "--sg-light-on-primary", 4.5, "Signed-out site: Leadership seat initials and role pill"],
  ["--sg-light-card", "--sg-light-chart-1", 4.5, "Signed-out site: Member seat's name line on the card"],
  ["--sg-light-card", "--sg-light-chart-2", 4.5, "Signed-out site: Steward seat's name line on the card"],
  ["--sg-light-card", "--sg-light-chart-3", 4.5, "Signed-out site: Coordinator seat's name line on the card"],
  ["--sg-light-card", "--sg-theme-chart-4", 4.5, "Signed-out site: Leadership seat's name line on the card"],
  // The theme guide's quiet captions (ink-3 on the public pages) and its chart
  // series 4 to 6, which a chart draws on the white card as non-text marks.
  // Both are light-only values, so they are measured on the light card token
  // (white in every scope), not on --card.
  ["--sg-light-card", "--sg-color-muted", 4.5, "Quiet captions on the white card"],
  ["--sg-light-card", "--sg-theme-chart-4", 3, "Chart series 4 on the card"],
  ["--sg-light-card", "--sg-theme-chart-5", 3, "Chart series 5 on the card"],
  ["--sg-light-card", "--sg-theme-chart-6", 3, "Chart series 6 on the card"],
  // The circled check on the verify success card: a 24px glyph, but held to
  // text AA anyway — 4.73:1 measured, so the stricter floor costs nothing.
  ["--green-soft", "--success", 4.5, "Verify receipt: the counted checkmark on its soft-green disc"],
  // Wave 2e (pixel-parity staff planes). The KPI tile's gold-tone sub line:
  // the prototype writes it in the gold rail colour itself, which fails as
  // text on the card, so the tile uses the readable gold ink instead.
  ["--card", "--gold-ink", 4.5, "Staff KPI tile: gold-tone sub line on the card"],
  //: the member-form Required marker is 11px bold on the cream canvas.
  // --gold is the CTA fill and fails 1.4.3, so the marker uses --gold-ink.
  ["--canvas", "--gold-ink", 4.5, "Member form: Required marker on the form canvas"],
  // Wave 2e staff planes, paintedPairs() derivation. The dark Compass card is
  // the same green/cream measurement the home chip already certifies, reached
  // through the alias names; the danger-soft chips take the learn terra ink
  // (minted in W2b precisely because raw terra fails as text on soft grounds).
  ["--green", "--sg-color-canvas", 4.5, "Casework desk: cream copy on the dark Compass card"],
  ["--sg-color-case-soft", "--sg-color-case-deep", 4.5, "Case queue: open-count chip on the Active cases head"],
  ["--sg-color-danger-soft", "--gq-danger-ink", 4.5, "Case queue: due-soon count chip and overdue date chips"],
  ["--gq-accent-soft", "--gq-accent-ink", 4.5, "Reactive casework: ledger breakdowns, follow-up guidance, and selected counts"],
  ["--card", "--gq-accent-ink", 4.5, "Reactive casework: daily docket method, rank index, and deadline metadata"],
  ["--gq-accent", "--gq-accent-on", 4.5, "Reactive casework: selected view control"],
  ["--gq-accent-on", "--gq-accent-ink", 4.5, "Reactive casework: count inside selected view control"],
  ["--casework-canvas", "--casework-canvas-foreground", 4.5, "Casefile Control: coordinator screen ground"],
  ["--casework-surface", "--casework-surface-foreground", 4.5, "Casefile Control: files, rows, and work panels"],
  ["--casework-surface", "--casework-muted-foreground", 4.5, "Casefile Control: metadata on file surfaces"],
  ["--casework-surface", "--casework-primary", 4.5, "Casefile Control: quiet controls and identifiers on files"],
  // Design QA round 1 (2026-08-22): under a system theme the command header
  // and docket band trade the primary slab for the muted surface with the
  // screen ink — the pair those overrides paint.
  ["--casework-muted-surface", "--casework-canvas-foreground", 4.5, "Casefile Control: themed command header and docket titles"],
  // PR1815 acceptance (2026-09-11): the themed header/docket eyebrows painted
  // --casework-primary on the muted surface; Night Shift measured 4.16:1 on the
  // live coordinator desk. The eyebrows now take the secondary foreground.
  ["--casework-muted-surface", "--casework-secondary-foreground", 4.5, "Casefile Control: themed command header and docket eyebrows"],
  // Design QA round 2: the step-ladder pill gets a semantic family; the
  // default pair mirrors the original gray pill, each theme repoints it.
  ["--casework-step-soft", "--casework-step", 4.5, "Casefile Control: step-ladder pill"],
  // Design QA round 4: the status column becomes a pill (ok family) and warn
  // takes its own register for the gold KPI edge and Night Shift clocks.
  ["--casework-ok-soft", "--casework-ok", 4.5, "Casefile Control: status-ok pill"],
  ["--casework-surface", "--casework-warn", 4.5, "Casefile Control: warn register on file surfaces"],
  ["--casework-warn-soft", "--casework-warn", 4.5, "Casefile Control: warn chip"],
  ["--casework-muted-surface", "--casework-muted-foreground", 4.5, "Casefile Control: expanded facts and secondary metadata"],
  ["--casework-primary", "--casework-primary-foreground", 4.5, "Casefile Control: command header and selected workflow tabs"],
  ["--casework-secondary", "--casework-secondary-foreground", 4.5, "Casefile Control: hover, selected file, and method surfaces"],
  ["--casework-accent", "--casework-accent-foreground", 4.5, "Casefile Control: chapter-work action and method tag"],
  ["--casework-critical", "--casework-critical-foreground", 4.5, "Casefile Control: deadline-critical surfaces"],
  ["--casework-critical-soft", "--casework-critical-soft-foreground", 4.5, "Casefile Control: deadline-critical tags"],
  ["--casework-surface", "--casework-control-border", 3, "Casefile Control: file and control boundaries"],
  ["--casework-canvas", "--casework-rule", 3, "Casefile Control: contract spines on the screen ground"],
  ["--casework-canvas", "--casework-focus", 3, "Casefile Control: focus ring on light work surfaces"],
  ["--casework-header", "--casework-focus-on-dark", 3, "Casefile Control: focus ring in the command header"],
  ["--casework-header", "--casework-header-stroke", 3, "Casefile Control: search and header-button edges in the command header"],
  ["--ledger-porcelain", "--ledger-plum", 4.5, "Ledger workspace: member and steward canvas"],
  ["--ledger-plum", "--sg-color-purple-soft", 4.5, "Ledger shell: idle navigation and secondary dark-surface copy"],
  ["--ledger-plum", "--sg-color-card", 4.5, "Ledger shell: brand and primary dark-surface copy"],
  ["--ledger-aubergine", "--sg-color-card", 4.5, "Ledger workspace: primary surfaces and hovered navigation"],
  ["--sg-light-card", "--sg-light-focus", 3, "Steward header: focus ring on header controls"],
  ["--sg-light-card", "--sg-light-ink-2", 4.5, "Steward header: eyebrow and subtitle on the paper band"],
  ["--sg-light-card", "--sg-light-ink", 4.5, "Steward header: title on the paper band"],
  ["--ledger-aubergine", "--sg-color-card", 3, "Member Home rewards hero: focus ring on the points ring and tier button"],
  ["--sg-color-purple-soft", "--ledger-aubergine", 4.5, "Ledger workspace: quiet status surfaces"],
  ["--ledger-copper", "--sg-color-card", 4.5, "Ledger workspace: current navigation and copper actions"],
  ["--ledger-plum", "--ledger-copper-boundary", 3, "Ledger shell: focus and shell boundary"],
  ["--sg-color-purple-deep", "--sg-color-card", 4.5, "Ledger shell: notification and profile surfaces"],
  ["--union-ground-canvas", "--sg-color-ink", 4.5, "Union Ground Evergreen: primary text on the cream desktop canvas"],
  ["--union-ground-card-2", "--sg-color-ink", 4.5, "Union Ground Evergreen: primary text on a raised cream surface"],
  ["--union-ground-track", "--sg-color-sec", 4.5, "Union Ground Evergreen: metadata on a quiet cream surface"],
  ["--sg-color-card", "--sg-color-border-strong", 3, "Union Ground Evergreen: meaningful control boundary on a card"],
  ["--union-ground-canvas", "--sg-color-border-strong", 3, "Union Ground Evergreen: meaningful control boundary on the cream canvas"],
  ["--union-ground-canvas", "--sg-color-green", 3, "Union Ground Evergreen: focus ring on the cream canvas"],
  ["--terra-soft", "--ink", 4.5, "Tasks: blocked summary tile when blocked > 0"],
  // The three terra-on-soft-terra paint sites the tasks board owns: the high
  // priority chip, the blocked count inside a breakdown row, and the inline
  // error banner. They painted --destructive at 4.12:1 and were carried as an
  // upstream exception in tests/styles-token-aliases.test.js until the
  // 2026-09-12 acceptance campaign measured the banner in a live browser on
  // /m/tasks/report and failed the case. --learn-terra-ink is the darkened
  // terra Wave 2b minted for exactly this ground.
  ["--terra-soft", "--learn-terra-ink", 4.5, "Tasks: high-priority chip, blocked count and inline error banner"],
  // Cream-removal / de-purple wave (owner-directed, 2026-07-30): the green
  // hero ramp — forest to --hero-green-deep — whose deep stop is the light
  // end of the gradient, so it is the surface every hero ink must clear.
  // --hero-green-deep lives in the styles.css:root block, which this
  // audit's resolver reads alongside sg-tokens.css. The Compass sheet hero
  // left this ramp for the bordered card recipe (owner reference,
  // 2026-08-08); .learn-dhero still paints it.
  ["--hero-green-deep", "--canvas", 4.5, "Learn hero: title on the deep-green gradient's light stop"],
  ["--hero-green-deep", "--sg-color-green-tint", 4.5, "Learn hero and Home Compass row: body copy"],
  ["--hero-green-deep", "--sg-color-gold-soft", 4.5, "Learn hero: badge"],
  // Kanban board (REQ-UG-KANBAN-PHASE1-20260801). The tasks screen paints
  // its own --kan-* namespace rather than re-pointing the app aliases, so these
  // rows are the ONLY thing measuring it. Light is now the only reachable
  // board palette, so every row runs at:root under `app` and again with the
  // `.tasks-screen` status carriers under `kanban`.
  //
  // Derived the same way as the sweeps above — paintedPairs() over the new
  // rules, then the handful the derivation structurally cannot see: card
  // surfaces are flat `s1` colors while the timeline progress overlay uses
  // `s2`, the priority glyphs and the status
  // dots inherit their backdrop from the card rather than naming it, and the
  // insertion line is painted on the column ground by a rule that sets no
  // colour of its own.
  ["--kan-canvas", "--kan-ink", 4.5, "Kanban: board ground and base text"],
  ["--kan-canvas", "--kan-muted", 4.5, "Kanban: column composer and hidden-done labels on the board ground"],
  ["--kan-canvas", "--kan-accent-text", 4.5, "Kanban: accent type on the board ground"],
  ["--kan-canvas", "--kan-accent-text", 3, "Kanban: the insertion line, focus rings and avatar filter ring on the board ground"],
  ["--kan-card", "--kan-ink", 4.5, "Kanban: calendar, timeline and progress panels"],
  ["--kan-card", "--kan-muted", 4.5, "Kanban: metadata on a panel"],
  ["--kan-card", "--kan-muted", 4.5, "Field Notes: textarea placeholder on the composer input surface"],
  ["--kan-card", "--kan-muted", 3, "Field Notes: meaningful resting textarea boundary against inner and outer composer surfaces"],
  ["--kan-card", "--kan-pill-muted", 4.5, "Kanban: quiet pill on a panel"],
  ["--kan-card", "--kan-accent-text", 4.5, "Kanban: the done-toast Undo and other accent type on a panel"],
  ["--kan-card", "--kan-danger", 4.5, "Kanban: overdue and destructive text on a panel"],
  ["--kan-card", "--kan-ok", 4.5, "Kanban: progress fills and done text on a panel"],
  ["--kan-card-2", "--kan-ink", 4.5, "Kanban: sunken fields, composers and the comments thread"],
  ["--kan-card-2", "--kan-muted", 4.5, "Kanban: keycaps, counts and the outside-month calendar day"],
  ["--kan-card-2", "--kan-accent-text", 4.5, "Kanban: the selected view pill"],
  ["--kan-pill", "--kan-pill-ink", 4.5, "Kanban: every chrome pill and round icon button"],
  ["--kan-pill", "--kan-pill-muted", 4.5, "Kanban: the search pill's placeholder and idle report chips"],
  ["--kan-pill", "--kan-accent-text", 4.5, "Kanban: accent type on a chrome pill"],
  ["--kan-popover", "--kan-ink", 4.5, "Kanban: popover options"],
  ["--kan-popover", "--kan-muted", 4.5, "Kanban: popover section titles and quick-pick digits"],
  ["--kan-modal", "--kan-ink", 4.5, "Kanban: the task modal's cards, the shortcuts sheet and the workstream panel"],
  ["--kan-modal", "--kan-muted", 4.5, "Kanban: modal field labels and hints"],
  ["--kan-accent", "--kan-accent-ink", 4.5, "Kanban: the lime fill under its ink — primary buttons, avatars, today pill, checks"],
  ["--kan-accent-ink", "--kan-accent", 3, "Kanban: active watch bell in its dark thumb"],
  ["--kan-muted", "--kan-modal", 3, "Kanban: idle watch bell in its muted thumb"],
  ["--kan-track", "--kan-muted", 3, "Kanban: idle watch track boundary"],
  ["--kan-ok", "--kan-modal", 3, "Kanban: completed-subtask check"],
  ["--kan-track", "--kan-ink", 3, "Kanban: subtask toggle and unlink controls"],
  ["--kan-danger-soft", "--kan-danger", 4.5, "Kanban: the blocked chip"],
  ["--kan-track", "--kan-accent-text", 3, "Kanban: the milestone progress fill against its own rail"],
  ["--kan-track", "--kan-ok", 3, "Kanban: calendar and breakdown progress fills against their rail"],
  ["--kan-backlog-s1", "--kan-backlog-ink", 4.5, "Kanban: backlog card title, status pill, calendar chip and timeline bar"],
  ["--kan-backlog-s1", "--kan-backlog-muted", 4.5, "Kanban: backlog card metadata"],
  ["--kan-backlog-s2", "--kan-backlog-ink", 4.5, "Kanban: backlog timeline title over the progress overlay"],
  ["--kan-backlog-s1", "--kan-backlog-dot", 3, "Kanban: backlog dot and rule"],
  ["--kan-backlog-s1", "--kan-danger", 4.5, "Kanban: overdue date on a backlog card"],
  ["--kan-backlog-s1", "--kan-needs_review-dot", 3, "Kanban: high-priority chevrons on a backlog card"],
  ["--kan-backlog-s1", "--kan-in_progress-dot", 3, "Kanban: low-priority chevrons on a backlog card"],
  ["--kan-to_do-s1", "--kan-to_do-ink", 4.5, "Kanban: to-do card title, status pill, calendar chip and timeline bar"],
  ["--kan-to_do-s1", "--kan-to_do-muted", 4.5, "Kanban: to-do card metadata"],
  ["--kan-to_do-s2", "--kan-to_do-ink", 4.5, "Kanban: to-do timeline title over the progress overlay"],
  ["--kan-to_do-s1", "--kan-to_do-dot", 3, "Kanban: to-do dot and rule"],
  ["--kan-to_do-s1", "--kan-danger", 4.5, "Kanban: overdue date on a to-do card"],
  ["--kan-in_progress-s1", "--kan-in_progress-ink", 4.5, "Kanban: in-progress card title, status pill, calendar chip and timeline bar"],
  ["--kan-in_progress-s1", "--kan-in_progress-muted", 4.5, "Kanban: in-progress card metadata"],
  ["--kan-in_progress-s2", "--kan-in_progress-ink", 4.5, "Kanban: in-progress timeline title over the progress overlay"],
  ["--kan-in_progress-s1", "--kan-in_progress-dot", 3, "Kanban: in-progress dot and rule"],
  ["--kan-in_progress-s1", "--kan-danger", 4.5, "Kanban: overdue date on an in-progress card"],
  ["--kan-in_progress-s1", "--kan-needs_review-dot", 3, "Kanban: high-priority chevrons on an in-progress card"],
  ["--kan-needs_review-s1", "--kan-needs_review-ink", 4.5, "Kanban: needs-review card title, status pill, calendar chip and timeline bar"],
  ["--kan-needs_review-s1", "--kan-needs_review-muted", 4.5, "Kanban: needs-review card metadata"],
  ["--kan-needs_review-s2", "--kan-needs_review-ink", 4.5, "Kanban: needs-review timeline title over the progress overlay"],
  ["--kan-needs_review-s1", "--kan-needs_review-dot", 3, "Kanban: needs-review dot and rule"],
  ["--kan-needs_review-s1", "--kan-danger", 4.5, "Kanban: overdue date on a needs-review card"],
  ["--kan-needs_review-s1", "--kan-in_progress-dot", 3, "Kanban: low-priority chevrons on a needs-review card"],
  ["--kan-done-s1", "--kan-done-ink", 4.5, "Kanban: done card title, status pill, calendar chip, timeline bar and the done chip"],
  ["--kan-done-s1", "--kan-done-muted", 4.5, "Kanban: done card metadata"],
  ["--kan-done-s2", "--kan-done-ink", 4.5, "Kanban: done timeline title over the progress overlay"],
  ["--kan-done-s1", "--kan-done-dot", 3, "Kanban: done dot and rule"],
  ["--kan-done-s1", "--kan-danger", 4.5, "Kanban: overdue date on a done card"],
  ["--kan-done-s1", "--kan-needs_review-dot", 3, "Kanban: high-priority chevrons on a done card"],
  ["--kan-popover", "--kan-backlog-dot", 3, "Kanban: backlog dot in the status picker"],
  ["--kan-popover", "--kan-to_do-dot", 3, "Kanban: to-do dot in the status picker"],
  ["--kan-popover", "--kan-in_progress-dot", 3, "Kanban: in-progress dot in the status picker"],
  ["--kan-popover", "--kan-needs_review-dot", 3, "Kanban: needs-review dot in the status picker"],
  ["--kan-popover", "--kan-done-dot", 3, "Kanban: done dot in the status picker"],
  ["--kan-card", "--kan-backlog-dot", 3, "Kanban: backlog dot in the calendar legend"],
  ["--kan-card", "--kan-to_do-dot", 3, "Kanban: to-do dot in the calendar legend"],
  ["--kan-card", "--kan-in_progress-dot", 3, "Kanban: in-progress dot in the calendar legend"],
  ["--kan-card", "--kan-needs_review-dot", 3, "Kanban: needs-review dot in the calendar legend"],
  ["--kan-card", "--kan-done-dot", 3, "Kanban: done dot in the calendar legend"],
  // The ten workstream identities. Each is an opaque 26px tile carrying a
  // single uppercase letter, so each is held to the TEXT bar rather than the
  // 3:1 graphical one — the letter is what tells two columns apart at a glance
  // even though it is aria-hidden and the name sits beside it.
  ["--kan-ws-0", "--kan-ws-ink", 4.5, "Kanban: workstream tile 0"],
  ["--kan-ws-1", "--kan-ws-ink", 4.5, "Kanban: workstream tile 1"],
  ["--kan-ws-2", "--kan-ws-ink", 4.5, "Kanban: workstream tile 2"],
  ["--kan-ws-3", "--kan-ws-ink", 4.5, "Kanban: workstream tile 3"],
  ["--kan-ws-4", "--kan-ws-ink", 4.5, "Kanban: workstream tile 4"],
  ["--kan-ws-5", "--kan-ws-ink", 4.5, "Kanban: workstream tile 5"],
  ["--kan-ws-6", "--kan-ws-ink", 4.5, "Kanban: workstream tile 6"],
  ["--kan-ws-7", "--kan-ws-ink", 4.5, "Kanban: workstream tile 7"],
  ["--kan-ws-8", "--kan-ws-ink", 4.5, "Kanban: workstream tile 8"],
  ["--kan-ws-9", "--kan-ws-ink", 4.5, "Kanban: workstream tile 9"],
  // Mobile cards Rev 5 (owner sign-off, 2026-08-08): the left card's floating
  // foot avatar paints initials in --card on the plum --ink disc — the same
  // paintedPairs() derivation as every sweep above. 16.16:1 neutral, 14.94:1
  // aubergine; a guard, not a fix.
  ["--ink", "--card", 4.5, "Left-card foot avatar initials on the ink disc"],
  // One Union Ground identity (design Step 2): build-order section 2.2, every
  // text and control role (light only since the owner's order of November 5,
  // 2026; the dark values are deleted), measured on the token values
  // themselves so the table holds whatever block paints them. Tokens are
  // global, so each row resolves the same in every scope.
  ["--sg-light-card", "--sg-light-ink", 4.5, "Identity (light): Ink on card"],
  ["--sg-light-canvas", "--sg-light-ink", 4.5, "Identity (light): Ink on canvas"],
  ["--sg-light-card", "--sg-light-ink-2", 4.5, "Identity (light): Ink 2 on card"],
  ["--sg-light-fill", "--sg-light-ink-2", 4.5, "Identity (light): Ink 2 on fill (neutral chips, disabled controls)"],
  ["--sg-light-fill", "--sg-light-placeholder", 4.5, "Identity (light): Placeholder on fill"],
  ["--sg-light-brand", "--sg-light-on-primary", 4.5, "Identity (light): Primary button"],
  ["--sg-light-card", "--sg-light-brand-text", 4.5, "Identity (light): Brand text on card"],
  ["--sg-light-brand-tint", "--sg-light-on-brand-tint", 4.5, "Identity (light): Quiet button, tag chip"],
  ["--sg-light-brand-tint-2", "--sg-light-on-brand-tint", 4.5, "Identity (light): Selected filter pill"],
  ["--sg-light-accent", "--sg-light-on-accent", 4.5, "Identity (light): Accent (gold) button"],
  ["--sg-light-accent-soft", "--sg-light-accent-text", 4.5, "Identity (light): Gold-family text"],
  ["--sg-light-info-soft", "--sg-light-info", 4.5, "Identity (light): Information chip"],
  ["--sg-light-card", "--sg-light-info", 4.5, "Identity (light): Information link"],
  ["--sg-light-ok-soft", "--sg-light-ok", 4.5, "Identity (light): Done chip"],
  ["--sg-light-danger-soft", "--sg-light-danger", 4.5, "Identity (light): Late, error chip"],
  ["--sg-light-card", "--sg-light-danger", 4.5, "Identity (light): Error text on card"],
  ["--sg-light-danger-fill", "--sg-light-on-primary", 4.5, "Identity (light): Today chip, badge"],
  ["--sg-light-due-soft", "--sg-light-due", 4.5, "Identity (light): Due chip"],
  ["--sg-light-fill", "--sg-light-ink", 4.5, "Identity (light): Incoming bubble"],
  ["--sg-light-rail", "--sg-light-rail-ink", 4.5, "Identity (light): Rail row"],
  ["--sg-light-rail", "--sg-light-rail-label", 4.5, "Identity (light): Rail label"],
  ["--sg-light-rail-selected", "--sg-light-brand", 4.5, "Identity (light): Rail selected row"],
  ["--sg-light-rail-count", "--sg-light-on-primary", 4.5, "Identity (light): Rail count"],
  ["--sg-light-brand-2", "--sg-light-accent-on-dark", 4.5, "Identity (light): Gold link on the green rail"],
  // The green desktop rail (REQ-UG-DESKTOP-RAIL-GREEN-THEME-GUIDE-20261112):
  // the surface fades from pine (--sg-light-brand-deep) to --sg-light-rail, so
  // each rail pair is measured at the pine end too, plus the hover row, the
  // white current row, both count pills and the gold focus ring.
  ["--sg-light-brand-deep", "--sg-light-rail-ink", 4.5, "Green desktop rail: Row at the pine top of the rail"],
  ["--sg-light-brand-deep", "--sg-light-rail-label", 4.5, "Green desktop rail: Label and resting icon at the pine top of the rail"],
  ["--sg-light-brand-2", "--sg-light-rail-ink", 4.5, "Green desktop rail: Row under the pointer"],
  ["--sg-light-rail-selected", "--sg-light-brand-deep", 4.5, "Green desktop rail: Current row, pine text and icon on white"],
  ["--sg-light-brand-tint", "--sg-light-brand-deep", 4.5, "Green desktop rail: Count pill on the white current row"],
  ["--sg-light-brand-deep", "--sg-light-accent-on-dark", 3, "Green desktop rail: Focus ring at the pine top of the rail"],
  ["--sg-light-rail", "--sg-light-accent-on-dark", 3, "Green desktop rail: Focus ring on the Union green rail"],
  ["--sg-light-brand-2", "--sg-light-accent-on-dark", 3, "Green desktop rail: Focus ring on the row under the pointer"],
  ["--sg-light-ink", "--sg-light-on-primary", 4.5, "Green desktop rail: Tooltip and hat menu text on ink"],
  ["--sg-light-card", "--sg-light-line-strong", 3, "Identity (light): Input and button edge"],
  ["--sg-light-fill", "--sg-light-line-strong", 3, "Identity (light): Edge on fill"],
  ["--sg-light-card", "--sg-light-focus", 3, "Identity (light): Focus ring"],
  ["--sg-light-brand-tint", "--sg-light-brand", 3, "Identity (light): Selected edge"],
  ["--sg-light-card", "--sg-light-danger", 3, "Identity (light): Error border"],
  ["--sg-light-card", "--sg-light-danger-fill", 3, "Identity (light): Unread dot"],
  ["--sg-light-card", "--sg-light-ok-fill", 3, "Identity (light): Done ring, presence"],
  ["--sg-light-card", "--sg-light-gold-mark", 3, "Identity (light): In-review ring, President marker"],
  ["--sg-light-card", "--sg-light-role-member", 3, "Identity (light): Role marker: member"],
  ["--sg-light-card", "--sg-light-role-steward", 3, "Identity (light): Role marker: steward"],
  ["--sg-light-card", "--sg-light-role-coordinator", 3, "Identity (light): Role marker: coordinator"],
  ["--sg-light-card", "--sg-light-role-advisor", 3, "Identity (light): Role marker: advisor"],
  ["--sg-light-card", "--sg-light-role-admin", 3, "Identity (light): Role marker: admin"],
  ["--sg-light-card", "--sg-light-role-president", 3, "Identity (light): Role marker: president"],
  // Chapter notice glow (REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113): the text on a glowing
  // notice tile, on each colour's fill; the Urgent and due words on red and amber.
  ["--sg-light-glow-green-fill", "--sg-light-ink", 4.5, "Notice glow (light): Text on the green tile"],
  ["--sg-light-glow-green-fill", "--sg-light-ink-2", 4.5, "Notice glow (light): Chapter name and time on the green tile"],
  ["--sg-light-glow-blue-fill", "--sg-light-ink", 4.5, "Notice glow (light): Text on the blue tile"],
  ["--sg-light-glow-blue-fill", "--sg-light-ink-2", 4.5, "Notice glow (light): Chapter name and time on the blue tile"],
  ["--sg-light-glow-gold-fill", "--sg-light-ink", 4.5, "Notice glow (light): Text on the gold tile"],
  ["--sg-light-glow-gold-fill", "--sg-light-ink-2", 4.5, "Notice glow (light): Chapter name and time on the gold tile"],
  ["--sg-light-glow-violet-fill", "--sg-light-ink", 4.5, "Notice glow (light): Text on the violet tile"],
  ["--sg-light-glow-violet-fill", "--sg-light-ink-2", 4.5, "Notice glow (light): Chapter name and time on the violet tile"],
  ["--sg-light-glow-amber-fill", "--sg-light-ink", 4.5, "Notice glow (light): Text on the amber tile"],
  ["--sg-light-glow-amber-fill", "--sg-light-ink-2", 4.5, "Notice glow (light): Chapter name and time on the amber tile"],
  ["--sg-light-glow-red-fill", "--sg-light-ink", 4.5, "Notice glow (light): Text on the red tile"],
  ["--sg-light-glow-red-fill", "--sg-light-ink-2", 4.5, "Notice glow (light): Chapter name and time on the red tile"],
  ["--sg-light-glow-red-fill", "--sg-light-danger", 4.5, "Notice glow (light): Urgent on the red tile"],
  ["--sg-light-glow-amber-fill", "--sg-light-due", 4.5, "Notice glow (light): Due date on the amber tile"],
  // REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: the website chart
  // series are the app's validated light trio (#137C54 #1473E6 #8A5A00). Each
  // is a 1.4.11 graphical object on both website surfaces, the card and the
  // canvas.
  ["--card", "--chart-series-1", 3, "Pulse chart series 1 (green) on cards"],
  ["--card", "--chart-series-2", 3, "Pulse chart series 2 (blue) on cards"],
  ["--card", "--chart-series-3", 3, "Pulse chart series 3 (amber) on cards"],
  ["--background", "--chart-series-1", 3, "Pulse chart series 1 (green) on the canvas"],
  ["--background", "--chart-series-2", 3, "Pulse chart series 2 (blue) on the canvas"],
  ["--background", "--chart-series-3", 3, "Pulse chart series 3 (amber) on the canvas"],
];

// The header promise above only holds if every semantic foreground token has a
// row. Six painted pairs (notice, success, disabled, status, toast, and the
// primary hero's muted copy) were absent for months because the list was hand
// maintained, so the audit now proves its own coverage: any `--*-foreground`
// token that never appears as a foreground in `pairs` fails the run.
const AUDITED_FOREGROUNDS = new Set(pairs.map(([, foregroundVar]) => foregroundVar));

/**
 * Pairs whose names are declared by a SCOPE rather than by `:root`.
 *
 * The four --task-status-* carriers live in `.tasks-screen`, so they cannot be
 * resolved from `:root` at all and could not be given a row until the audit
 * learned to overlay a scope. Each is a graphical object under WCAG 1.4.11 —
 * a 9px dot or a 3px rule — rather than text, so each is held to 3:1.
 *
 * THREE surfaces, not one. The first version of this table measured all four
 * against --card only, which was the wrong backdrop for two of the three places
 * they render; it was caught by measuring the live preview rather than by
 * reading the sheet, which is the whole lesson of that pass repeating itself
 * one level down. Where each actually lands:
 *   --card-2         .task-column > header's dot     (.task-column is --card-2)
 *   --card           .tasks-calendar__legend's dots  (inherited, legend sets none)
 *   --status-surface .calendar-task's 3px border-left
 */
export const scopedPairs = [
  ["--card-2", "--task-status-backlog", 3, "Backlog dot in the board column header"],
  ["--card-2", "--task-status-in-progress", 3, "In-progress dot in the board column header"],
  ["--card-2", "--task-status-review", 3, "Needs-review dot in the board column header"],
  ["--card-2", "--task-status-done", 3, "Done dot in the board column header"],
  ["--card", "--task-status-in-progress", 3, "In-progress dot in the calendar legend"],
  ["--card", "--task-status-review", 3, "Needs-review dot in the calendar legend"],
  ["--status-surface", "--task-status-backlog", 3, "Backlog rule on a calendar chip"],
  ["--status-surface", "--task-status-in-progress", 3, "In-progress rule on a calendar chip"],
  ["--status-surface", "--task-status-review", 3, "Needs-review rule on a calendar chip"],
  ["--status-surface", "--task-status-done", 3, "Done rule on a calendar chip"],
];

/**
 * The value sets a member can actually be looking at.
 *
 * `:root` is not the only place this app declares colour. `.tasks-screen`
 * declares the four --task-status-* carriers, so for every pair inside the
 * board there is a second set of values that no amount of reading `:root` will
 * reveal. `overlays` are applied in order over `:root`, exactly as the cascade
 * applies them.
 *
 * There was a third scope here, `tasks dark`, overlaying `.tasks-screen--dark`
 * — a per-screen palette behind a localStorage toggle. The toggle was deleted
 * with the staff-tool wire-in and the block itself on 2026-07-28, so the scope
 * went with it. That deletion is not a loss of coverage, it is the removal of
 * FALSE coverage: an overlay over a selector nothing can carry publishes a
 * ratio for a screen no member can open, and prints it in the same table, in
 * the same shape, as the two that describe what actually renders. The five
 * pairs it once justified keep their rows above, so what the pass found stays
 * measured after the palette that revealed it is gone.
 *
 * A scope is not optional coverage. Adding one has to be able to FAIL the run,
 * so an overlay naming a selector that declares nothing throws rather than
 * quietly measuring `:root` twice and reporting twice the confidence.
 *
 * Kanban has one reachable light palette. The app scope resolves the palette
 * in:root and the `kanban` scope adds the exact `.tasks-screen` selector that
 * owns its status carriers and light color-scheme. Naming a selector that
 * declares nothing still throws, so this remains real scoped coverage.
 */
export const scopes = [
  { name: "app", overlays: [] },
  // One Union Ground identity (design Step 2; the owner's ruling of November
  // 3, 2026 retired the steward's Harbor Ledger exception): every hat renders
  // `union-ground`, light only (owner order of November 5, 2026,
  // REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105; the dormant dark
  // form and its scope are deleted). These replace the per-hat scopes (owner
  // feedback 2026-08-25), the Evergreen desktop scope and the ten work-/sys-
  // scopes of the retired selectable palettes.
  { name: "union-ground", overlays: ['.sg-app[data-workspace-theme="union-ground"]', ".tasks-screen"] },
  // The signed-out pages keep this edition's own theme: no separate public
  // overlay (the official service's theme-guide block is not carried), so
  // there is no second public scope to measure.
  { name: "kanban", overlays: [".tasks-screen"] },
];

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// Parsing lives in ./lib/css-vars.mjs so tests/styles-token-aliases.test.js can
// feed it hand-built sheets. Two holes it closes — comments being parsed as
// declarations, and only the first:root being read — were live here until this
// pass and are pinned by behaviour there, not by a pin on this file's text.
const resolverFor = (vars) =>
  function resolve(name, seen = new Set()) {
    if (seen.has(name)) throw new Error(`circular reference at ${name}`);
    seen.add(name);
    const value = vars.get(name);
    if (value === undefined) throw new Error(`undefined variable ${name}`);
    const ref = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    if (ref) return resolve(ref[1], seen);
    if (!/^#[0-9a-f]{6}$/i.test(value)) {
      throw new Error(`${name} resolves to "${value}", not a 6-digit hex color`);
    }
    return value.toLowerCase();
  };

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16, (value >> 8) & 255, value & 255];
}

function luminance(hex) {
  return rgb(hex)
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Every row this audit runs, in every scope, as data.
 *
 * main() below is only a printer over this. That split is deliberate: while the
 * loop lived inside main(), the tests could pin the TABLES all they liked and
 * still not notice main() quietly narrowing what it fed them — a one-word edit
 * dropping `scopedPairs` from the row list left every table pin green and the
 * four status-dot rows running nowhere. Pinning data is not pinning the path
 * that consumes it, so the path has to be callable.
 */
/**
 * One resolver per scope, built once and shared.
 *
 * Extracted so that measure() below and ratiosFor() further down cannot drift
 * apart. ratiosFor() exists to let the test file put a NUMBER on a pair that has
 * no row — the exception ledger has to prove each pair it excuses really does
 * fail — and a second, private copy of "apply the overlays, then resolve" would
 * mean the ledger's numbers were produced by different code than the audit's.
 * Two implementations of one rule is how a guard ends up agreeing with itself
 * and disagreeing with the browser.
 */
function scopeResolvers({ tokens, styles }) {
  const root = collectVars([tokens, styles]);
  return scopes.map(({ name: scope, overlays }) => {
    const vars = new Map(root);
    for (const selector of overlays) {
      const declared = scopedVars(styles, selector);
      if (declared.size === 0) {
        throw new Error(
          `scope "${scope}" overlays \`${selector}\`, which declares no custom properties. ` +
            "An overlay that resolves to nothing measures :root a second time and reports it " +
            "as a second scope's worth of coverage.",
        );
      }
      for (const [key, value] of declared) vars.set(key, value);
    }
    return { scope, overlays, resolve: resolverFor(vars) };
  });
}

/**
 * The ratio a pair holds in every scope, for a pair that need not have a row.
 *
 * The exception ledger in tests/styles-token-aliases.test.js excuses a handful
 * of painted pairs from having a row. An unchecked excuse list is just a way to
 * delete coverage politely, so the ledger asserts that each entry genuinely
 * misses its bar — which requires measuring a pair the table does not contain.
 */
export function ratiosFor({ tokens, styles }, backgroundVar, foregroundVar) {
  return scopeResolvers({ tokens, styles }).map(({ scope, resolve }) => {
    try {
      return { scope, ratio: contrast(resolve(backgroundVar), resolve(foregroundVar)) };
    } catch (error) {
      return { scope, error: error.message };
    }
  });
}

export function measure({ tokens, styles }) {
  const rows = [];

  for (const { scope, overlays, resolve } of scopeResolvers({ tokens, styles })) {
    // The scoped rows describe the tasks board, which the bare "app" scope has
    // no overlay for; measuring them there would only report undefined names.
    const applicable = overlays.length === 0 ? pairs : [...pairs, ...scopedPairs];
    for (const [backgroundVar, foregroundVar, minimum, usage] of applicable) {
      const row = { scope, backgroundVar, foregroundVar, minimum, usage };
      try {
        row.background = resolve(backgroundVar);
        row.foreground = resolve(foregroundVar);
        row.ratio = contrast(row.background, row.foreground);
      } catch (error) {
        row.error = error.message;
      }
      rows.push(row);
    }
  }
  return rows;
}

function main() {
  const tokens = readFileSync(join(srcDir, "sg-tokens.css"), "utf8");
  const styles = ["styles.css", "coordinator-theme.css"]
    .map((file) => readFileSync(join(srcDir, file), "utf8"))
    .join("\n");

  let failed = false;
  console.log("Scope | Token pair | Background | Foreground | Ratio | AA | AAA | Usage");
  for (const row of measure({ tokens, styles })) {
    const name = `${row.backgroundVar.slice(2)} / ${row.foregroundVar.slice(2)}`;
    if (row.error) {
      failed = true;
      console.log(`${row.scope} | ${name} | - | - | - | FAIL | FAIL | ${row.usage} (${row.error})`);
      continue;
    }
    const aa = row.ratio >= row.minimum;
    if (!aa) failed = true;
    console.log(`${row.scope} | ${name} | ${row.background} | ${row.foreground} | ${row.ratio.toFixed(2)}:1 | ${aa ? "PASS" : "FAIL"} | ${row.ratio >= 7 ? "PASS" : "FAIL"} | ${row.usage}`);
  }

  // Union Ground's coverage proof: every `--*-foreground` token the sheets
  // declare must appear as a foreground in `pairs`, or the run fails.
  for (const name of collectVars([tokens, styles]).keys()) {
    if (!name.endsWith("-foreground") || AUDITED_FOREGROUNDS.has(name)) continue;
    failed = true;
    console.log(`${name} | - | - | - | FAIL | FAIL | no audited background pair; add a row to pairs`);
  }

  if (failed) process.exitCode = 1;
}

// Audit only when invoked directly. The table above has to be importable to be
// pinned, and an import that printed a report and set process.exitCode would
// fail vitest's own run from inside a passing test.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
