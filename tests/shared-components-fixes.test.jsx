import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { KanbanList } from "../src/views/KanbanList.jsx";
import { Button } from "../src/components/Button.jsx";
import { QueuePager } from "../src/components/QueuePager.jsx";
import { Pager } from "../src/components/Pager.jsx";
import { usePagedQueue } from "../src/lib/usePagedQueue.js";

function TaskList(props) {
  const { lang, t } = useLang();
  return <KanbanList {...props} lang={lang} t={t} />;
}

describe("shared component review regressions", () => {
  it.each([false, true])("keeps an uninterrupted pager action reachable when rows arrive (last page=%s)", (lastPage) => {
    const onShowMore = vi.fn();
    const { rerender } = render(<Pager total={3} shown={1} onShowMore={onShowMore} />);
    const more = screen.getByRole("button", { name: "Show more" });
    more.focus();
    fireEvent.click(more);
    rerender(<Pager total={3} shown={lastPage ? 3 : 2} onShowMore={onShowMore} />);
    expect(document.activeElement).toBe(lastPage ? screen.getByText("Showing 1–3 of 3") : more);
  });

  it("cancels pending restoration even when the newly focused field is subsequently blurred", () => {
    const content = (shown) => <><input aria-label="Email" /><Pager total={3} shown={shown} onShowMore={vi.fn()} /></>;
    const { rerender } = render(content(1));
    const more = screen.getByRole("button", { name: "Show more" });
    more.focus();
    fireEvent.click(more);
    const field = screen.getByRole("textbox", { name: "Email" });
    field.focus();
    field.blur();
    rerender(content(3));
    expect(document.activeElement).toBe(document.body);
  });

  it.each([false, true])("does not reclaim focus from a field after a delayed page (last page=%s)", async (lastPage) => {
    let finishPage;
    const seed = { rows: [{ id: "first" }], cursor: "next", total: lastPage ? 2 : 3 };
    const fetcher = vi.fn(() => new Promise((resolve) => { finishPage = resolve; }));
    function DelayedQueue() {
      const query = usePagedQueue(seed, fetcher, {});
      return <><label>Email<input /></label><QueuePager query={query} /><p>{query.rows.length} loaded</p></>;
    }
    render(<DelayedQueue />);
    const more = screen.getByRole("button", { name: "Load more" });
    more.focus();
    fireEvent.click(more);
    const field = screen.getByRole("textbox", { name: "Email" });
    field.focus();
    fireEvent.change(field, { target: { value: "Still typing" } });
    await act(async () => { finishPage({ rows: [{ id: "second" }], total: seed.total, nextCursor: lastPage ? null : "later" }); });
    expect(screen.getByText("2 loaded")).toBeInTheDocument();
    expect(document.activeElement).toBe(field);
    expect(field).toHaveValue("Still typing");
  });

  it("localizes the expanded task group's range, navigation and page names in Spanish", () => {
    const tasks = Array.from({ length: 51 }, (_, index) => ({ id: `spanish-${index}`, title: `Tarea ${index}`, status: "to_do", workstream: "Chapter", priority: "normal" }));
    render(<LanguageProvider lang="es"><TaskList tasks={tasks} workstreamNames={["Chapter"]} chapterId="local-fixture" doneVisible onOpenTask={vi.fn()} onCycleStatus={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar las 51" }));
    const pager = screen.getByRole("navigation", { name: "Paginación" });
    expect(within(pager).getByText("Mostrando 1–25 de 51")).toBeInTheDocument();
    expect(within(pager).getByRole("button", { name: "Anterior" })).toBeDisabled();
    expect(within(pager).getByRole("button", { name: "Siguiente" })).toBeEnabled();
    expect(within(pager).getByLabelText("Páginas")).toBeInTheDocument();
    fireEvent.click(within(pager).getByRole("button", { name: "Página 3" }));
    expect(within(pager).getByText("Mostrando 51–51 de 51")).toBeInTheDocument();
    expect(within(pager).getByRole("button", { name: "Página 3" })).toHaveAttribute("aria-current", "page");
  });

  it("localizes QueuePager's navigation landmark as well as its visible labels", () => {
    render(<LanguageProvider lang="es"><QueuePager query={{ rows: Array.from({ length: 25 }), total: 51, cursor: "next", loadMore: vi.fn() }} /></LanguageProvider>);
    const pager = screen.getByRole("navigation", { name: "Paginación" });
    expect(within(pager).getByText("Mostrando 25 de 51")).toBeInTheDocument();
    expect(within(pager).getByRole("button", { name: "Cargar más" })).toBeEnabled();
  });

  it("localizes busy action names and preserves explicit accessible names", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<LanguageProvider lang="es"><Button loading onClick={onClick}>Agregar</Button></LanguageProvider>);
    expect((screen.getByRole("button", { name: "Cargando Agregar" })).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(screen.getByRole("button", { name: "Cargando Agregar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cargando Agregar" }));
    expect(onClick).not.toHaveBeenCalled();
    rerender(<LanguageProvider lang="es"><Button loading aria-label="Guardando el borrador"><span>Guardar</span></Button></LanguageProvider>);
    expect(screen.getByRole("button", { name: "Guardando el borrador" })).toHaveAttribute("aria-busy", "true");
    rerender(<LanguageProvider lang="es"><Button loading><span>Guardar</span></Button></LanguageProvider>);
    expect(screen.getByRole("button", { name: "Cargando acción" })).toBeInTheDocument();
  });

  it.each([false, true].flatMap((desktopWork) => ["workstream", "assignee"].flatMap((groupBy) => [5, 30].map((activeCount) => [desktopWork, groupBy, activeCount]))))(
    "reveals a completed row directly (desktop=%s, group=%s, active rows=%s)",
    (desktopWork, groupBy, activeCount) => {
      const tasks = Array.from({ length: activeCount + 1 }, (_, index) => ({
        id: `task-${index}`, title: index === activeCount ? "Completed task" : `Active task ${index}`,
        status: index === activeCount ? "done" : "to_do", workstream: "Chapter", assigneeName: "Ada Lee", priority: "normal",
      }));
      render(<LanguageProvider lang="en"><TaskList tasks={tasks} workstreamNames={["Chapter"]} chapterId="local-fixture" doneVisible={false} desktopWork={desktopWork} onOpenTask={vi.fn()} onCycleStatus={vi.fn()} /></LanguageProvider>);
      fireEvent.change(screen.getByRole("combobox", { name: "Group by" }), { target: { value: groupBy } });
      const group = screen.getByRole("region", { name: groupBy === "workstream" ? "Chapter" : "Ada Lee" });
      expect(within(group).queryByRole("button", { name: "Completed task" })).not.toBeInTheDocument();
      fireEvent.click(within(group).getByRole("button", { name: "Show done tasks (1)" }));
      expect(within(group).getByRole("button", { name: "Completed task" })).toBeInTheDocument();
      expect(within(group).queryByRole("button", { name: "Show done tasks (1)" })).not.toBeInTheDocument();
      if (activeCount > 25) expect(within(group).getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    },
  );
});
