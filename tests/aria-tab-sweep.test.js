import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The fake tab pattern, swept out of all seven of its sites on 2026-07-28.
//
// `role="tab"` + `aria-selected` with no `role="tablist"` owning a
// `role="tabpanel"`, and no arrow-key handling. A screen reader announced
// "tab, 1 of 3", the member pressed Right, and nothing moved: the role promised
// a keyboard model the app had never implemented anywhere. None of the seven
// were tab panels — they were filters and switches over ONE region — so all
// seven became buttons with `aria-pressed`, which is what the tasks board's own
// scope chips already did correctly.
//
// A per-view assertion cannot hold this. Each of the seven was written by
// someone copying the nearest existing control, which is exactly how the
// inconsistency spread in the first place, so the guard has to be a sweep of
// every .jsx in src/ rather than a pin on the files that happened to have it.
// PublicLanding later added the app's first complete tab pattern. The desktop
// Work surface followed once its view strip had the same complete behavior:
// a tablist, owned tabs and panel, roving tabindex, and Arrow/Home/End handling.
// The companion rendering remains a pressed-button group.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

const sources = readdirSync(join(root, "src"), { recursive: true })
  .map((entry) => String(entry).replace(/\\/g, "/"))
  .filter((entry) => entry.endsWith(".jsx"))
  .sort()
  .map((entry) => [`src/${entry}`, read(join("src", entry))]);

/** Roles for which `aria-selected` is a supported, meaningful attribute. */
const SELECTABLE_ROLES = ["option", "row", "gridcell", "treeitem", "columnheader", "rowheader", "tab"];

describe("the fake tab pattern stays swept", () => {
  it("found sources to sweep", () => {
    // A sweep over an empty list passes every assertion below it. This is the
    // same soft-scope failure the contrast guards were rebuilt to refuse: the
    // thing asserted was protected and the thing SELECTING what to assert over
    // was not.
    expect(sources.length).toBeGreaterThanOrEqual(20);
  });

  it("keeps literal tab roles confined to complete tab patterns", () => {
    const offenders = sources
      .flatMap(([path, source]) =>
        [...source.matchAll(/role=["'](tab|tablist|tabpanel)["']/g)].map(([, role]) => `${path}: role="${role}"`))
      .sort();
    expect(offenders).toEqual([
      'src/features/coordination/ui/OrganizationCoordinationDesk.jsx: role="tab"',
      'src/features/coordination/ui/OrganizationCoordinationDesk.jsx: role="tablist"',
      'src/features/coordination/ui/OrganizationCoordinationDesk.jsx: role="tabpanel"',
      'src/views/OrganizeView.jsx: role="tab"',
      'src/views/OrganizeView.jsx: role="tablist"',
      'src/views/OrganizeView.jsx: role="tabpanel"',
    ]);
    // Union Ground's public landing preview strip was the other complete
    // pattern; the public landing is left out of Union Ground. The
    // organizing lifecycle's stage tabs are Union Ground's own.
    expect(existsSync(join(root, "src/views/PublicLanding.jsx"))).toBe(false);
    const lifecycle = read("src/views/OrganizeView.jsx");
    expect(lifecycle).toContain('role="tablist"');
    expect(lifecycle).toContain('role="tab"');
    expect(lifecycle).toContain('role="tabpanel"');
    expect(lifecycle).toContain('aria-controls="lifecycle-panel-active"');
    expect(lifecycle).toContain('id="lifecycle-panel-active" aria-labelledby={`lifecycle-tab-${tab}`}');
    expect(lifecycle).toContain("tabIndex={tab === item ? 0 : -1}");
    expect(lifecycle).toContain("onKeyDown={(event) => moveTab(event, item)}");
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(lifecycle).toMatch(new RegExp(`const keyMoves = \\{[^}]*\\b${key}:`));
    }
    const coordination = read("src/features/coordination/ui/OrganizationCoordinationDesk.jsx");
    expect(coordination).toContain('role="tablist"');
    expect(coordination).toContain('role="tab"');
    expect(coordination).toContain('role="tabpanel"');
    expect(coordination).toContain("aria-controls={`coord-panel-${item.id}`}");
    expect(coordination).toContain("tabIndex={selected ? 0 : -1}");
    expect(coordination).toContain('["ArrowRight", "ArrowDown"].includes(event.key)');
    expect(coordination).toContain('["ArrowLeft", "ArrowUp"].includes(event.key)');
    expect(coordination).toContain('event.key === "Home"');
    expect(coordination).toContain('event.key === "End"');
  });

  it("carries aria-selected only on an element whose role supports it", () => {
    // The half a role sweep alone would miss. `aria-selected` on a bare
    // <button> is the fake pattern with its most visible half deleted — the
    // announcement is quieter but the attribute is still ignored, and the CSS
    // hook it feeds keeps working, so nothing on screen says anything is wrong.
    const offenders = [];
    for (const [path, source] of sources) {
      for (const [tag] of source.matchAll(/<[a-zA-Z][^>]*aria-selected[^>]*>/g)) {
        const role = tag.match(/role=["']([a-z]+)["']/);
        if (!role || !SELECTABLE_ROLES.includes(role[1])) {
          offenders.push(`${path}: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("keeps the five modal listboxes that legitimately own aria-selected options", () => {
    // Stated by name so the sweep above cannot be satisfied by deleting the
    // last honest use of the attribute along with the dishonest ones. This IS a
    // single-selection listbox: a role="listbox" container, role="option"
    // children. Workstream/status/priority/dependency are single-select; the
    // assignee picker is explicitly multi-select.
    //
    // 2026-08-01, the t0ggles rebuild (647466cb5): the listboxes MOVED. The old
    // TasksView owned an inline task editor whose assignee field and one sibling
    // carried the app's only two honest role="option" elements. That editor is
    // gone; the detail modal replaced it, and the pickers multiplied — the modal
    // now opens four popovers (workstream, status, priority, assignee) and the
    // assignee one adds an explicit "unassigned" option above the people.
    //
    // The pin follows the JSX rather than being relaxed, because the number is
    // the whole point of the guard: this file exists because seven strips grew a
    // fake tab pattern by copy-paste, and four popovers built the same week from
    // one template is precisely that shape again. If a fifth picker lands and
    // this count is quietly bumped without reading it, nothing was checked. Read
    // the diff, confirm each new option really is a single-selection listbox
    // child, then move the number.
    //
    // Current inventory in TaskModal.jsx: workstream picker (1) + status picker
    // (1) + priority picker (1) + assignee unassign row (1) + assignee people
    // rows (1) + dependency add-picker candidates (1, phase 2 — a searchable
    // single-selection listbox exactly like the assignee people rows) = 6.
    const modal = read("src/views/TaskModal.jsx");
    expect(modal).toContain('className="task-assignee-options" role="listbox" aria-multiselectable="true"');
    // Attributes may be inserted between role and aria-labelledby (the
    // multi-select declaration is one), so pin ownership within the same tag
    // instead of pinning incidental attribute adjacency.
    expect([...modal.matchAll(/role="listbox"[^>]*aria-labelledby=/g)]).toHaveLength(5);
    // The disabled state can sit between the role and selection state too.
    expect([...modal.matchAll(/role="option"[^>]*aria-selected=/g)]).toHaveLength(6);
  });

  it("left none of the pattern behind in the rewritten TasksView", () => {
    // The other half of the move. A rewrite that COPIES the old markup into the
    // new file instead of relocating it leaves two live listboxes on screen and
    // the pin above still passes, so the departure is asserted as its own fact.
    // TasksView is now chrome only — top bar, popovers, view switching — and
    // every option list it used to own belongs to the modal.
    const view = read("src/views/TasksView.jsx");
    expect(view).toContain('role={desktopShell ? "tablist" : "group"}');
    expect(view).toContain('role={desktopShell ? "tab" : undefined}');
    expect(view).toContain('role={desktopShell ? "tabpanel" : undefined}');
    expect(view).toContain('aria-selected={desktopShell ? view === id : undefined}');
    expect(view).toContain('aria-controls={desktopShell ? `tasks-panel-${id}` : undefined}');
    expect(view).toContain('tabIndex={focusedView === id ? 0 : -1}');
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      expect(view).toContain(`event.key === "${key}"`);
    }
    expect(view).not.toContain("task-assignee-options");
  });
});

describe("the style hooks moved with the JSX", () => {
  // The trap this sweep had to avoid, and the reason the CSS is asserted here
  // rather than left to a visual check: `[aria-selected="true"]` was a LIVE
  // style hook for .segment and the old .hub-tabs. Convert the JSX alone and
  // every selected state in the app silently renders as unselected, with the
  // full suite green.
  //
  // Wave 2c (2026-07-29) rebuilt most of the converted strips into new
  // namespaces, so the inventory tracks the successors: .segment survives on
  // the sign-in language switch; the workload groups became WorkloadView's
  // .mwl-tab / .mwl-chip / .mwl-checkrow family; the six hub sections became
  // ProductHubView's .hub2-tab pills; and VoiceView's scope strip
  // (.bevoice-scope__btn) was born on aria-pressed and is held to the same
  // rule. Strips that style their pressed state without the attribute (inline
  // chipStyle in the forms editor, class toggles like .voting-tab--on) need no
  // sheet hook and are exempt — losing their hook is a compile-visible change,
  // not this silent one.
  const stylesCss = read("src/styles.css");

  it("styles every converted strip on aria-pressed", () => {
    for (const selector of [
      ".segment button", // sign-in language (AuthScreen)
      ".mwl-tab", // Workload log: Submit / History / Stats
      ".mwl-chip", // Workload log: weekly presets, employment, leave, timing
      ".mwl-checkrow", // Workload log: the pressed check rows
      ".hub2-tab", // Product hub: six section pills
      ".bevoice-scope__btn", // Be heard: chapter/local scope
    ]) {
      expect(
        stylesCss.includes(`${selector}[aria-pressed="true"]`),
        `${selector} lost its selected-state rule; the strip renders flat`,
      ).toBe(true);
      expect(
        stylesCss.includes(`${selector}[aria-selected="true"]`),
        `${selector} still hooks aria-selected, which its JSX no longer sets`,
      ).toBe(false);
    }
  });

  it("leaves an aria-selected hook only where an aria-selected element exists", () => {
    // Derived from the sheet, not enumerated: any rule keying on the attribute
    // has to name a selector some role="option" element carries.
    //
    // 2026-08-01: this used to be a flat equality against the single surviving
    // hook, which read as "the sheet may style exactly one thing". That was
    // never the rule — the rule is that a hook must point at markup that
    // actually sets the attribute — and the kanban rebuild made the difference
    // load-bearing: the modal's four popovers are option lists, and the sheet is
    // free to grow `[aria-selected="true"]` rules for them. What it must never
    // do is keep a hook aimed at a strip that has moved to aria-pressed, which
    // is the silent regression this describe block was built for: the JSX
    // conversion compiles, the suite stays green, and every selected state in
    // the app renders as unselected.
    //
    // So the check became the derivation it always described. Every hook has to
    // name a class that lives in a source file that also builds role="option"
    // elements; the assignee list stays pinned by name because it is the one
    // hook whose deletion would be invisible on screen until someone tried to
    // tell two option rows apart.
    const optionSources = sources.filter(([, source]) => source.includes('role="option"'));
    expect(optionSources.length, "no source builds role=\"option\" any more").toBeGreaterThan(0);
    const selectableSources = sources.filter(([, source]) => source.includes('role="option"') || source.includes('role="tab"') || source.includes('role={desktopShell ? "tab"'));

    const hooks = [...stylesCss.matchAll(/^([^{\n]*\[aria-selected[^{\n]*)\{/gm)]
      .map(([, selector]) => selector.trim())
      .sort();

    expect(
      hooks,
      "the assignee options hook is the named survivor of the 2026-07-28 sweep; " +
        "losing it renders every option row identically",
    ).toContain('.task-assignee-options button[aria-selected="true"]');

    const orphans = hooks.filter((hook) => {
      const classes = [...hook.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(([, name]) => name);
      if (!classes.length) return true;
      return !classes.every((name) => selectableSources.some(([, source]) => source.includes(name)));
    });
    expect(
      orphans,
      "an aria-selected rule that names a class no role=\"option\" markup carries " +
        "is either a dead hook or a strip that moved to aria-pressed without its CSS",
    ).toEqual([]);
  });
});
