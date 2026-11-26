import { useRef, useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AgendaItemsBuilder } from "../src/components/AgendaItemsBuilder.jsx";
import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { t } from "../src/lib/i18n.js";
const en=(key,vars)=>t("en",key,vars);
const open=(title="Ordered agenda items")=>fireEvent.click(screen.getByText(title,{selector:"summary"}));
const topic=(scope=screen)=>scope.getByRole("textbox",{name:"Topic"});
const owner=(scope=screen)=>scope.getByRole("textbox",{name:"Responsible person"});
const outcome=(scope=screen)=>scope.getByRole("textbox",{name:"Expected outcome or decision (optional)"});
const item=(number)=>screen.getByRole("group",{name:`Agenda item ${number}`});
function fill(number,topicText,ownerText){
  fireEvent.change(topic(within(item(number))),{target:{value:topicText}});
  fireEvent.change(owner(within(item(number))),{target:{value:ownerText}});
}
function Host({ initial="Call to order" }) {
  const [agenda, setAgenda] = useState(initial);
  const agendaFieldRef = useRef(null);
  return <><textarea aria-label="Agenda draft" ref={agendaFieldRef} value={agenda} onChange={(event)=>setAgenda(event.target.value)} />
    <AgendaItemsBuilder t={en} agenda={agenda} onAppend={setAgenda} agendaFieldRef={agendaFieldRef} /></>;
}
it("keeps existing agenda text and appends ordered owners, time boxes and outcomes",()=>{
  const append=vi.fn();render(<AgendaItemsBuilder t={en} agenda="Call to order" onAppend={append} />);
  open();
  fill(1,"Budget review","Treasurer");
  fireEvent.change(outcome(),{target:{value:"Approve the budget"}});
  fireEvent.click(screen.getByRole("button",{name:"Add agenda item"}));
  fill(2,"Minutes","Secretary");
  fireEvent.click(screen.getByRole("button",{name:"Move item 2 up"}));
  fireEvent.click(screen.getByRole("button",{name:"Append items to agenda"}));
  expect(append).toHaveBeenCalledWith(expect.stringContaining("Call to order"));
  const text=append.mock.calls[0][0];expect(text.indexOf("1. Minutes")).toBeLessThan(text.indexOf("2. Budget review"));
  expect(text).toContain("Responsible person: Treasurer");expect(text).toContain("Time box (minutes): 10");expect(text).toContain("Expected outcome or decision: Approve the budget");
  // The optional outcome leaves no dangling label line when it is empty.
  expect(text.match(/Expected outcome or decision/g)).toHaveLength(1);
  expect(screen.getAllByRole("textbox",{name:"Topic"})).toHaveLength(1);
  expect(topic()).toHaveValue("");
  expect(outcome()).toHaveValue("");
});
it("refuses incomplete items and overlong agendas, with translated controls",()=>{
  const append=vi.fn();
  const view=render(<AgendaItemsBuilder t={(key,vars)=>t("es",key,vars)} agenda={"a".repeat(4000)} onAppend={append} />);
  open("Puntos ordenados de la agenda");
  const button=screen.getByRole("button",{name:"Añadir puntos a la agenda"});
  expect(button).toBeDisabled();
  // The empty placeholder item does not count toward the length limit.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(button).toHaveAccessibleDescription("Para añadirlos, cada punto necesita un tema y una persona responsable.");
  fireEvent.change(screen.getByRole("textbox",{name:"Tema"}),{target:{value:"Presupuesto"}});
  expect(screen.getByRole("alert")).toHaveTextContent("superan los 4.000");
  expect(button).toHaveAccessibleDescription(expect.stringContaining("superan los 4.000"));
  expect(append).not.toHaveBeenCalled();
  view.unmount();
});
it("marks required and optional fields and explains why Append is unavailable",()=>{
  render(<AgendaItemsBuilder t={en} agenda="" onAppend={vi.fn()} />);
  open();
  expect(topic()).toHaveAttribute("aria-required","true");
  expect(owner()).toHaveAttribute("aria-required","true");
  expect(outcome()).not.toHaveAttribute("aria-required");
  expect(item(1)).toHaveTextContent("Topic (required)");
  expect(item(1)).toHaveTextContent("Expected outcome or decision (optional)");
  const button=screen.getByRole("button",{name:"Append items to agenda"});
  expect(button).toHaveAccessibleDescription("Give every item a topic and a responsible person to append.");
  expect(screen.queryByRole("alert")).toBeNull();
  fill(1,"Budget review","Treasurer");
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute("aria-describedby");
});
it.each(["1e2","0","241","2.5","1000",""])("refuses the time box %j",(value)=>{
  const append=vi.fn();render(<AgendaItemsBuilder t={en} agenda="" onAppend={append} />);
  open();
  fill(1,"Budget review","Treasurer");
  const minutes=screen.getByRole("spinbutton",{name:"Time box (minutes)"});
  const button=screen.getByRole("button",{name:"Append items to agenda"});
  fireEvent.change(minutes,{target:{value}});
  expect(button).toBeDisabled();
  if (minutes.value!=="") expect(button).toHaveAccessibleDescription("Enter each time box as whole minutes from 1 to 240.");
  fireEvent.change(minutes,{target:{value:"240"}});
  fireEvent.click(button);
  expect(append.mock.calls[0][0]).toContain("Time box (minutes): 240");
});
it("prints a padded time box as a plain number",()=>{
  const append=vi.fn();render(<AgendaItemsBuilder t={en} agenda="" onAppend={append} />);
  open();
  fill(1,"Budget review","Treasurer");
  fireEvent.change(screen.getByRole("spinbutton",{name:"Time box (minutes)"}),{target:{value:"010"}});
  fireEvent.click(screen.getByRole("button",{name:"Append items to agenda"}));
  expect(append.mock.calls[0][0]).toMatch(/Time box \(minutes\): 10$/);
  expect(append.mock.calls[0][0]).not.toContain("010");
});
it("moves focus with the moved item across two presses and announces its position",()=>{
  render(<AgendaItemsBuilder t={en} agenda="" onAppend={vi.fn()} />);
  open();
  fireEvent.click(screen.getByRole("button",{name:"Add agenda item"}));
  fireEvent.click(screen.getByRole("button",{name:"Add agenda item"}));
  fill(1,"First","A");fill(2,"Second","B");fill(3,"Third","C");
  fireEvent.click(screen.getByRole("button",{name:"Move item 3 up"}));
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Move item 2 up"}));
  expect(topic(within(item(2)))).toHaveValue("Third");
  expect(screen.getByRole("status")).toHaveTextContent("Item moved to position 2");
  // A second press keeps moving the same item instead of undoing the first.
  fireEvent.click(document.activeElement);
  expect(topic(within(item(1)))).toHaveValue("Third");
  expect(topic(within(item(2)))).toHaveValue("First");
  // Move up is disabled at the top edge, so focus lands on the same item's Move down.
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Move item 1 down"}));
  expect(screen.getByRole("status")).toHaveTextContent("Item moved to position 1");
  fireEvent.click(screen.getByRole("button",{name:"Move item 2 down"}));
  expect(topic(within(item(3)))).toHaveValue("First");
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Move item 3 up"}));
});
it("keeps focus on a nearby control after Remove",()=>{
  render(<AgendaItemsBuilder t={en} agenda="" onAppend={vi.fn()} />);
  open();
  fireEvent.click(screen.getByRole("button",{name:"Add agenda item"}));
  fireEvent.click(screen.getByRole("button",{name:"Add agenda item"}));
  fill(1,"First","A");fill(2,"Second","B");fill(3,"Third","C");
  fireEvent.click(screen.getByRole("button",{name:"Remove item 3"}));
  expect(document.activeElement).toBe(topic(within(item(2))));
  expect(screen.getByRole("status")).toHaveTextContent("Item 3 removed");
  fireEvent.click(screen.getByRole("button",{name:"Remove item 1"}));
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Add agenda item"}));
  expect(topic()).toHaveValue("Second");
});
it("clears appended items, focuses the agenda and continues its numbering", () => {
  render(<Host initial={"1. Call to order\n2. Roll call"} />);
  open();
  fill(1,"Budget review","Treasurer");
  const append = screen.getByRole("button", { name: "Append items to agenda" });
  fireEvent.click(append);
  const draft=screen.getByRole("textbox",{name:"Agenda draft"});
  expect(document.activeElement).toBe(draft);
  expect(screen.getByRole("status")).toHaveTextContent("Items appended to the agenda");
  expect(append).toBeDisabled();
  expect(topic()).toHaveValue("");
  expect(owner()).toHaveValue("");
  expect(screen.getByRole("spinbutton",{name:"Time box (minutes)"})).toHaveValue(10);
  fireEvent.click(append);
  expect(draft.value.match(/3\. Budget review/g)).toHaveLength(1);
  // A fresh item is still appendable, without restoring the previous one, and
  // numbering continues instead of restarting at 1.
  fill(1,"Minutes","Secretary");
  fireEvent.click(append);
  expect(draft.value).toContain("4. Minutes");
  expect(draft.value.match(/^1\. /gm)).toHaveLength(1);
  expect(draft.value.match(/Budget review/g)).toHaveLength(1);
});
it("starts at 1 for an agenda with no numbered lines",()=>{
  const append=vi.fn();render(<AgendaItemsBuilder t={en} agenda={"Welcome\nNotes: 3. see attachment"} onAppend={append} />);
  open();
  fill(1,"Budget review","Treasurer");
  fireEvent.click(screen.getByRole("button",{name:"Append items to agenda"}));
  expect(append.mock.calls[0][0]).toContain("\n\n1. Budget review");
});

it("keeps an agenda control focusable while the event card's own write runs (record 8435)", async () => {
  render(<AgendaItemsBuilder t={en} agenda="Call to order" onAppend={vi.fn()} pending />);
  const field = screen.getAllByRole("textbox")[0];
  await expectPendingFocus(field);
});
