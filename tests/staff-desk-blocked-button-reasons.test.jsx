// #9468: a held staff desk button names its unmet rule and announces it on a press.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskCheckoffPanel } from "../src/views/TaskCheckoffPanel.jsx";
import { NominationsManager } from "../src/features/elections/NominationsManager.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";

const described = (node) => (node.getAttribute("aria-describedby") || "").split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");
const inLang = (lang, node) => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
afterEach(() => vi.restoreAllMocks());

describe.each(["en", "es"])("check-off Create list, W6-9 (%s)", (lang) => {
  const tk = (key, vars) => t(lang, `taskCheckoff.${key}`, vars);
  async function openBuilder(members) {
    const client = { rpc: vi.fn(async (name) => ({ error: null, data: name === "get_task_checkoff_list" ? { enabled: true, list: null } : { members } })) };
    inLang(lang, <TaskCheckoffPanel client={client} taskId="task-1" memberId="s-1" />);
    fireEvent.click(await screen.findByRole("button", { name: tk("add") }));
    const created = () => client.rpc.mock.calls.some(([name]) => name === "create_task_checkoff_list");
    return { created, create: await screen.findByRole("button", { name: tk("create") }) };
  }
  const tick = (name) => fireEvent.click(screen.getByRole("checkbox", { name }));
  it("names missing members, stewards and per-member stewards in turn", async () => {
    const { created, create } = await openBuilder([{ id: "m-1", name: "Ana" }, { id: "m-2", name: "Luis" }, { id: "s-1", name: "Sam", steward: true }]);
    expectRefusedEveryWay(create, tk("blocked.members"), created);
    tick("Ana"); tick("Luis");
    expectRefusedEveryWay(create, tk("blocked.stewards"), created);
    fireEvent.click(screen.getByRole("radio", { name: tk("mode.manual") }));
    expectRefusedEveryWay(create, tk("blocked.manual", { names: "Ana, Luis" }), created);
  });
  it("points to the shared list when nobody holds a staff role, in split and manual modes", async () => {
    const { created, create } = await openBuilder([{ id: "m-1", name: "Ana" }]);
    tick("Ana");
    expectRefusedEveryWay(create, tk("blocked.noStewards"), created);
    fireEvent.click(screen.getByRole("radio", { name: tk("mode.manual") }));
    expect(described(create)).toContain(tk("blocked.noStewards"));
    expect(described(create)).not.toContain(tk("blocked.manual", { names: "Ana" }));
    fireEvent.click(screen.getByRole("radio", { name: tk("mode.shared") }));
    expect(create).not.toHaveAttribute("aria-disabled");
  });
  it("says the chapter has no members when the roster is empty", async () => {
    const { created, create } = await openBuilder([]);
    expectRefusedEveryWay(create, tk("noMembers"), created);
    expect(described(create)).not.toContain(tk("blocked.members"));
  });
});

describe.each(["en", "es"])("nominations as ballot choices, W5-3 (%s)", (lang) => {
  const seconded = (count) => Array.from({ length: count }, (_, index) => ({ id: `n-${index}`, nomineeName: `Nominee ${index}`, secondedAt: "2026-11-01" }));
  async function open(reads) {
    const rpc = vi.fn();
    for (const read of reads) rpc.mockImplementationOnce(async () => (read instanceof Error ? { data: null, error: read } : { data: { nominationsCloseAt: null, nominations: read }, error: null }));
    const onUseNominees = vi.fn();
    const { container } = inLang(lang, <NominationsManager client={{ rpc }} campaign={{ id: "ballot-1" }} onUseNominees={onUseNominees} />);
    const details = container.querySelector("details");
    // Open it once, as a browser does: setting `open` makes jsdom queue its own
    // toggle task. A second, synthetic toggle on top of it started a second read
    // whenever that task ran after the first read had rendered (a React
    // Scheduler pass already posted, as under shard load), so the button was
    // found mid-read, busy and without its reason.
    await act(async () => {
      const toggled = new Promise((resolve) => details.addEventListener("toggle", resolve, { once: true }));
      details.open = true;
      await toggled;
    });
    const count = reads[0].filter((row) => row.secondedAt).length;
    return { onUseNominees, container, use: await screen.findByRole("button", { name: t(lang, "nominations.useAsChoices", { count }) }) };
  }
  const notice = (container) => container.querySelector(".cam-live").textContent;
  it("names the two-choice minimum and refuses every press", async () => {
    const { onUseNominees, use } = await open([[...seconded(1), { id: "n-x", nomineeName: "Omar" }]]);
    expectRefusedEveryWay(use, t(lang, "nominations.tooFew", { count: 1, min: 2 }), () => onUseNominees.mock.calls.length > 0);
  });
  it("names the twenty-choice maximum beside the button instead of a silent native disable", async () => {
    const { onUseNominees, use } = await open([seconded(21)]);
    expectRefusedEveryWay(use, t(lang, "nominations.tooMany", { count: 21, max: 20 }), () => onUseNominees.mock.calls.length > 0);
  });
  it("keeps the load-failed notice, never a count, when the fresh read fails", async () => {
    const { onUseNominees, use, container } = await open([seconded(2), new Error("offline")]);
    fireEvent.click(use);
    await waitFor(() => expect(notice(container)).toBe(t(lang, "nominations.loadFailed")));
    expect(notice(container)).not.toContain(t(lang, "nominations.tooFew", { count: 0, min: 2 }));
    expect(onUseNominees).not.toHaveBeenCalled();
  });
  it("names the fresh count when the list shrank below two since it was shown", async () => {
    const { onUseNominees, use, container } = await open([seconded(2), seconded(1)]);
    fireEvent.click(use);
    await waitFor(() => expect(notice(container)).toBe(t(lang, "nominations.tooFew", { count: 1, min: 2 })));
    expect(onUseNominees).not.toHaveBeenCalled();
  });
});
