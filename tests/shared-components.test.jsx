import { existsSync } from "node:fs";
import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../src/components/Button.jsx";
import { Field } from "../src/components/Field.jsx";
import { Chip } from "../src/components/Chip.jsx";
import { SegmentedControl } from "../src/components/SegmentedControl.jsx";
import { FilterPills } from "../src/components/FilterPills.jsx";
import { Pager } from "../src/components/Pager.jsx";
import { PageHeader } from "../src/components/PageHeader.jsx";
import { TrackerRow } from "../src/components/TrackerRow.jsx";
import { TrackerStageGroup } from "../src/components/TrackerStageGroup.jsx";
import { RoutedTabLink } from "../src/components/WorkspacePages.jsx";

const options = [{ value: "all", label: "All", count: 4 }, { value: "open", label: "Open", count: 2 }];

describe("shared component contracts", () => {
  it("Button exposes its action, icon, link, busy and disabled states", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button icon={<span>+</span>} onClick={onClick}>Create</Button>);
    const button = screen.getByRole("button", { name: "Create" });
    expect(button.querySelector(".sg-button__icon")).not.toBeNull();
    button.focus(); expect(document.activeElement).toBe(button);
    fireEvent.click(button); expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button loading onClick={onClick}>Create</Button>);
    expect((screen.getByRole("button", { name: /Loading Create/ })).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(screen.getByRole("button", { name: /Loading Create/ }));
    fireEvent.click(screen.getByRole("button", { name: /Loading Create/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
    rerender(<Button as="a" href="/next" disabled onClick={onClick}>Next</Button>);
    const link = screen.getByText("Next").closest("a");
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveAttribute("tabindex", "-1");
    fireEvent.click(link); expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("Field links label, help and actionable error to its control; no left-out civic copy of either primitive ships", () => {
    // Civic action is left out of Union Ground, so its re-export of these
    // two primitives (src/features/civic/ui.jsx) must not come back as a fork.
    expect(existsSync(new URL("../src/features/civic/ui.jsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../src/civic.css", import.meta.url))).toBe(false);
    render(<><Field label="Email" hint="Use your work email" error="Enter a valid email address">{(props) => <input {...props} type="email" />}</Field><Chip tone="bad">Late</Chip></>);
    const input = screen.getByRole("textbox", { name: "Email" });
    input.focus(); expect(document.activeElement).toBe(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = input.getAttribute("aria-describedby").split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0])).toHaveTextContent("Use your work email");
    expect(document.getElementById(ids[1])).toHaveTextContent("Enter a valid email address");
    expect(screen.getByText("Late")).toHaveClass("sg-chip--bad");
    const { container } = render(<Field label="Name"><input /></Field>);
    expect(within(container).getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  it("SegmentedControl and FilterPills have named groups and pressed states", () => {
    const changeView = vi.fn(); const changeFilter = vi.fn();
    render(<><SegmentedControl label="View" options={options} value="all" onChange={changeView} /><FilterPills label="Filter" options={options} value="open" onChange={changeFilter} /></>);
    const view = screen.getByRole("group", { name: "View" });
    const filter = screen.getByRole("group", { name: "Filter" });
    expect(within(view).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(within(filter).getByRole("button", { name: "Open 2" })).toHaveAttribute("aria-pressed", "true");
    const target = within(view).getByRole("button", { name: "Open" }); target.focus();
    expect(document.activeElement).toBe(target);
    fireEvent.click(target); expect(changeView).toHaveBeenCalledWith("open");
    fireEvent.click(within(filter).getByRole("button", { name: "All 4" })); expect(changeFilter).toHaveBeenCalledWith("all");
  });

  it("Pager names the range, moves pages, preserves focus, and retries a failed load", () => {
    const onPageChange = vi.fn();
    const { rerender } = render(<Pager total={51} page={1} onPageChange={onPageChange} />);
    expect(screen.getByText("Showing 1–25 of 51")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
    screen.getByRole("button", { name: "Next" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Next" })); expect(onPageChange).toHaveBeenCalledWith(2);
    rerender(<Pager total={51} page={2} onPageChange={onPageChange} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next" }));
    const onShowMore = vi.fn();
    rerender(<Pager total={51} shown={25} onShowMore={onShowMore} moreError labels={{ error: "Page failed", retry: "Try again" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Page failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(onShowMore).toHaveBeenCalledTimes(1);
  });

  it("PageHeader says the title once and places the action after the copy", () => {
    render(<PageHeader eyebrow="Chapter" title="Events" purpose="Plan and manage events." action={<Button>Create event</Button>} />);
    expect(screen.getAllByRole("heading", { name: "Events", level: 1 })).toHaveLength(1);
    expect(screen.getByText("Plan and manage events.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create event" })).toBeInTheDocument();
  });

  it("Pager stays mounted while busy: no stale total, focusable unavailable controls, focus kept on removal", () => {
    const onShowMore = vi.fn();
    const onRetry = vi.fn();
    const { rerender } = render(<Pager total={418} shown={25} onShowMore={onShowMore} />);
    const more = screen.getByRole("button", { name: "Show more" });
    more.focus();
    rerender(<Pager total={418} shown={25} onShowMore={onShowMore} loading busy />);
    const count = document.querySelector(".sg-pager__count");
    expect(count).toHaveAttribute("aria-live", "polite");
    expect(count).toHaveTextContent("Loading…");
    expect(document.querySelector(".sg-pager")).not.toHaveTextContent("418");
    expect(more).toHaveFocus();
    expect(more).not.toBeDisabled();
    expect(more).toHaveAttribute("aria-disabled", "true");
    expect(more).toHaveAttribute("aria-busy", "true");
    fireEvent.click(more);
    expect(onShowMore).not.toHaveBeenCalled();
    // The new answer fits: Show more leaves and focus moves to the count.
    rerender(<Pager total={12} shown={12} onShowMore={onShowMore} />);
    expect(more.isConnected).toBe(false);
    expect(count).toHaveFocus();
    expect(count).toHaveTextContent("Showing 1–12 of 12");

    // A failed load's Try again gives way to the busy count, which takes focus.
    rerender(<Pager total={0} shown={0} error onRetry={onRetry} />);
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<Pager total={0} shown={0} busy onRetry={onRetry} />);
    expect(document.activeElement).toBe(document.querySelector(".sg-pager__count"));
    expect(document.activeElement).toHaveTextContent("Loading…");
  });

  it("Pager's refresh control retries, and stays focusable but inert while busy", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<Pager total={30} shown={25} onRetry={onRetry} labels={{ refresh: "Refresh" }} />);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(refresh);
    expect(onRetry).toHaveBeenCalledTimes(1);
    refresh.focus();
    rerender(<Pager total={30} shown={25} busy onRetry={onRetry} labels={{ refresh: "Refresh" }} />);
    expect(refresh).toHaveFocus();
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(refresh);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("Pager selects numbered pages and returns with Previous while keeping the active control reachable", () => {
    const onPageChange = vi.fn();
    const { rerender } = render(<Pager total={76} page={1} onPageChange={onPageChange} />);
    const fourthPage = screen.getByRole("button", { name: "Page 4" });
    fourthPage.focus();
    fireEvent.click(fourthPage);
    expect(onPageChange).toHaveBeenLastCalledWith(4);
    rerender(<Pager total={76} page={4} onPageChange={onPageChange} />);
    expect(screen.getByText("Showing 76–76 of 76")).toBeInTheDocument();
    expect(fourthPage).toHaveAttribute("aria-current", "page");
    expect(document.activeElement).toBe(fourthPage);
    const previous = screen.getByRole("button", { name: "Previous" });
    previous.focus();
    fireEvent.click(previous);
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    rerender(<Pager total={76} page={3} onPageChange={onPageChange} />);
    expect(screen.getByText("Showing 51–75 of 76")).toBeInTheDocument();
    expect(document.activeElement).toBe(previous);
    expect(screen.getByRole("button", { name: "Page 3" })).toHaveAttribute("aria-current", "page");
  });

  it("TrackerRow keeps task opening and status action distinct; stage groups reveal and page", () => {
    const open = vi.fn(); const cycle = vi.fn();
    const task = { id: "task-1", title: "Contact members", status: "in_progress", priority: "high", dueDate: "2026-10-03", assigneeName: "Ada Lee" };
    const t = (key) => key;
    const { container } = render(<><TrackerRow task={task} chapterId="x" t={t} lang="en" urgency="soon" onOpenTask={open} onCycleStatus={cycle} /><TrackerStageGroup id="stage" name="In progress" count={30} rows={Array.from({ length: 30 }, (_, i) => i)} collapsed={false} onToggle={vi.fn()} renderRow={(n) => <li key={n}>Item {n}</li>} /></>);
    const row = container.querySelector(".sg-tracker-row");
    expect(row.querySelector(".sg-tracker-ring")).not.toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Contact members" })); expect(open).toHaveBeenCalledWith(task);
    fireEvent.click(within(row).getByRole("button", { name: /kanban.advanceTo/ })); expect(cycle).toHaveBeenCalledWith(task);
    const toggle = screen.getByRole("button", { name: "In progress, 30" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText(/Item /)).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Show all 30" }));
    expect(screen.getAllByText(/Item /)).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByText(/Item /)).toHaveLength(5);
  });

  it("TrackerStageGroup keeps a controlled panel target when collapsed", () => {
    const onToggle = vi.fn();
    render(<TrackerStageGroup id="collapsed-stage" name="Done" count={1} rows={[1]} collapsed onToggle={onToggle} renderRow={(n) => <li key={n}>Task {n}</li>} />);
    const toggle = screen.getByRole("button", { name: "Done, 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("collapsed-stage")).toHaveAttribute("hidden");
    toggle.focus(); expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle); expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("RoutedTabLink retains keyboard focus and its fallback action without a workspace", () => {
    const onClick = vi.fn();
    render(<RoutedTabLink group="tasks" value="list" onClick={onClick} aria-pressed>List</RoutedTabLink>);
    const tab = screen.getByRole("button", { name: "List" });
    tab.focus(); expect(document.activeElement).toBe(tab);
    expect(tab).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(tab); expect(onClick).toHaveBeenCalledTimes(1);
  });
});
