import { createRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BusyButton, BusyFieldset, BusyInput, BusyRegion, BusySelect, BusyTextarea } from "../src/components/BusyControls.jsx";
import { prepareBusyWrite, runBusyWrite } from "../src/lib/busyWrite.js";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

describe("busy write controls keep the member's place", () => {
  it.each([{ key: "Escape" }, { key: "Tab" }, { key: "c", ctrlKey: true }, { key: "a", metaKey: true }])("preserves navigation and copying through a pending field and boundary (%j)", key => {
    const navigate = vi.fn();
    render(<div onKeyDown={navigate}><BusyFieldset pending><BusyInput pending aria-label="Pending value" defaultValue="before" /></BusyFieldset></div>);
    const field = screen.getByLabelText("Pending value");
    fireEvent.keyDown(field, key);
    expect(navigate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "a" });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it.each(["field", "fieldset", "region"])("does not restore an old %s value over a new owner render", async kind => {
    const write = vi.fn();
    const surface = value => kind === "field"
      ? <BusyInput pending aria-label="Current owner" value={value} onChange={write} />
      : kind === "fieldset"
        ? <BusyFieldset pending><input aria-label="Current owner" value={value} onChange={write} /></BusyFieldset>
        : <BusyRegion pending><input aria-label="Current owner" value={value} onChange={write} /></BusyRegion>;
    const { rerender } = render(surface("old owner"));
    const field = screen.getByLabelText("Current owner");
    fireEvent.change(field, { target: { value: "blocked edit" } });
    rerender(surface("new owner"));
    await Promise.resolve();
    expect(field).toHaveValue("new owner");
    expect(write).not.toHaveBeenCalled();
  });

  it("lets a corrected or cancelled draft retry immediately, but locks a prepared write before React renders", async () => {
    const lock = { current: new Set() };
    const event = { preventDefault: vi.fn() };
    expect(prepareBusyWrite(lock, "save", () => undefined, event)).toBeUndefined();
    expect(lock.current.size).toBe(0);
    let release;
    const write = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const prepare = vi.fn(() => write);
    const first = prepareBusyWrite(lock, "save", prepare, event);
    prepareBusyWrite(lock, "save", prepare, event);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    release("saved");
    await expect(first).resolves.toBe("saved");
    expect(lock.current.size).toBe(0);
    expect(() => prepareBusyWrite(lock, "save", () => { throw new Error("invalid"); })).toThrow("invalid");
    expect(lock.current.size).toBe(0);
  });

  it("releases a synchronous refusal inline without letting its later cleanup unlock a newer write", async () => {
    const lock = { current: new Set() };
    const refused = runBusyWrite(lock, "save", async release => {
      try { throw new Error("refused"); }
      catch { return false; }
      finally { release(); }
    });
    expect(lock.current.has("save")).toBe(false);
    let releaseNew;
    const newer = runBusyWrite(lock, "save", () => new Promise(resolve => { releaseNew = resolve; }));
    await expect(refused).resolves.toBe(false);
    expect(lock.current.has("save")).toBe(true);
    releaseNew(); await newer;
    expect(lock.current.size).toBe(0);
  });

  it.each(["Enter", " "])("refuses %j in capture before a custom key handler can activate a pending button", key => {
    const activate = vi.fn(), capture = vi.fn();
    render(<BusyButton pending onKeyDown={activate} onKeyDownCapture={capture}>Save</BusyButton>);
    fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key });
    expect(activate).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("forwards ordinary clicks, capture handlers, keyboard navigation, form values, and refs", () => {
    const button = createRef(), field = createRef(), fieldset = createRef();
    const click = vi.fn(), capture = vi.fn(), change = vi.fn(), key = vi.fn();
    const view = render(<form><BusyFieldset ref={fieldset} onChangeCapture={capture} onInputCapture={capture} onKeyDownCapture={key}>
      <BusyInput ref={field} aria-label="Value" name="value" defaultValue="before" onChange={change} onKeyDown={key} onClick={click} onInput={change} onPaste={change} onDrop={change} onBeforeInput={change} />
      <BusyButton ref={button} type="button" onClick={click} onClickCapture={capture} onKeyDownCapture={key} aria-busy="true">Save</BusyButton>
    </BusyFieldset></form>);
    fireEvent.change(field.current, { target: { value: "after" } });
    fireEvent.input(field.current); fireEvent.click(field.current); fireEvent.click(button.current);
    fireEvent.keyDown(field.current, { key: "a" }); fireEvent.keyDown(button.current, { key: "Tab" });
    expect(click).toHaveBeenCalledTimes(2);
    expect(change).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(key).toHaveBeenCalled();
    expect(button.current).toHaveAttribute("aria-busy", "true");
    expect(fieldset.current.tagName).toBe("FIELDSET");
    expect(new FormData(view.container.querySelector("form")).get("value")).toBe("after");
    view.unmount();
    expect(field.current).toBeNull();
    expect(button.current).toBeNull();
    expect(fieldset.current).toBeNull();
  });

  it.each(["input", "change", "click", "paste", "drop", "keyDown"])("refuses a pending field's %s while retaining its value", async event => {
    enableFocusFixup();
    const activate = vi.fn();
    const ref = vi.fn();
    const view = render(<BusyInput ref={ref} pending aria-label="Value" defaultValue="before" onInput={activate} onChange={activate} onClick={activate} onPaste={activate} onDrop={activate} onKeyDown={activate} />);
    const field = screen.getByLabelText("Value");
    field.focus();
    fireEvent[event](field, event === "keyDown" ? { key: "a" } : { target: { value: "ignored" } });
    await afterRenderingUpdate();
    expect(activate).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
    if (event === "input" || event === "change") expect(field).toHaveValue("before");
    expect(ref).toHaveBeenCalledWith(field);
    view.unmount();
  });

  it("preserves multiple selections and file input unavailability without a forbidden file value assignment", async () => {
    const change = vi.fn();
    const { rerender } = render(<><BusySelect aria-label="Choices" multiple defaultValue={["a", "c"]} onChange={change}><option>a</option><option>b</option><option>c</option></BusySelect><BusyInput type="file" multiple aria-label="File" pending onChange={change} /></>);
    rerender(<><BusySelect aria-label="Choices" pending multiple defaultValue={["a", "c"]} onChange={change}><option>a</option><option>b</option><option>c</option></BusySelect><BusyInput type="file" multiple aria-label="File" pending onChange={change} /></>);
    fireEvent.change(screen.getByLabelText("Choices"), { target: { value: "b" } });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [new File(["proof"], "proof.txt")] } });
    await Promise.resolve();
    expect(screen.getByLabelText("Choices")).toHaveValue(["a", "c"]);
    expect(change).not.toHaveBeenCalled();
  });

  it("restores uncontrolled values and a whole radio group inside a pending fieldset", async () => {
    const change = vi.fn(), key = vi.fn(), ref = vi.fn();
    const { rerender } = render(<BusyFieldset ref={ref}><BusyInput aria-label="Value" defaultValue="before" /><input aria-label="A" type="radio" name="choice" value="a" defaultChecked /><input aria-label="B" type="radio" name="choice" value="b" /></BusyFieldset>);
    rerender(<BusyFieldset ref={ref} pending onChangeCapture={change} onInputCapture={change} onKeyDownCapture={key}><BusyInput aria-label="Value" defaultValue="before" /><input aria-label="A" type="radio" name="choice" value="a" defaultChecked /><input aria-label="B" type="radio" name="choice" value="b" /></BusyFieldset>);
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "ignored" } });
    fireEvent.input(screen.getByLabelText("Value"), { target: { value: "ignored again" } });
    fireEvent.click(screen.getByLabelText("B"));
    await Promise.resolve();
    expect(screen.getByLabelText("Value")).toHaveValue("before");
    expect(screen.getByLabelText("A")).toBeChecked();
    expect(screen.getByLabelText("B")).not.toBeChecked();
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("A"), { key: "Tab" });
    expect(key).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText("A"), { key: "ArrowRight" });
    expect(key).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalled();
  });

  it("keeps native permission, read-only and aria-disabled reasons separate from pending work", () => {
    const click = vi.fn();
    render(<><BusyInput aria-label="Permission" disabled /><BusyInput aria-label="Read only" readOnly /><BusyFieldset disabled><input aria-label="Child" /></BusyFieldset><BusyButton aria-disabled="true" onClick={click}>Unavailable</BusyButton></>);
    expect(screen.getByLabelText("Permission")).toBeDisabled();
    expect(screen.getByLabelText("Child")).toBeDisabled();
    expect(screen.getByLabelText("Read only")).toHaveAttribute("readonly");
    const button = screen.getByRole("button", { name: "Unavailable" });
    expect(button).toBeEnabled(); fireEvent.click(button);
    expect(click).not.toHaveBeenCalled();
  });


  it.each([
    ["text input", props => <BusyInput aria-label="Autosave" defaultValue="before" {...props} />, node => fireEvent.change(node, { target: { value: "saved" } }), node => expect(node).toHaveValue("saved")],
    ["textarea", props => <BusyTextarea aria-label="Autosave" defaultValue="before" {...props} />, node => fireEvent.change(node, { target: { value: "saved" } }), node => expect(node).toHaveValue("saved")],
    ["select", props => <BusySelect aria-label="Autosave" defaultValue="before" {...props}><option value="before">Before</option><option value="saved">Saved</option><option value="ignored">Ignored</option></BusySelect>, node => fireEvent.change(node, { target: { value: "saved" } }), node => expect(node).toHaveValue("saved")],
    ["checkbox", props => <BusyInput aria-label="Autosave" type="checkbox" {...props} />, node => fireEvent.click(node), node => expect(node).toBeChecked()],
  ])("keeps %s focus across the autosave and refuses another change", async (_kind, field, change, assertValue) => {
    enableFocusFixup();
    let finish;
    const write = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    function Surface() {
      const [pending, setPending] = useState(false);
      return field({ pending, onChange: async () => { setPending(true); try { await write(); } finally { setPending(false); } } });
    }
    render(<Surface />);
    const control = screen.getByLabelText("Autosave");
    control.focus();
    change(control);
    await afterRenderingUpdate();
    expect(control).toHaveFocus();
    expect(control).toBeEnabled();
    expect(control).toHaveAttribute("aria-disabled", "true");
    assertValue(control);
    if (control.type === "checkbox") fireEvent.click(control);
    else fireEvent.change(control, { target: { value: "ignored" } });
    await afterRenderingUpdate();
    expect(write).toHaveBeenCalledTimes(1);
    assertValue(control);
    await act(async () => finish());
    await afterRenderingUpdate();
    expect(control).toHaveFocus();
    expect(control).not.toHaveAttribute("aria-disabled", "true");
  });

  it("does not let a pending fieldset disable or reactivate its focused child", async () => {
    enableFocusFixup();
    let finish;
    const write = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    function Surface() {
      const [pending, setPending] = useState(false);
      return <BusyFieldset pending={pending}><legend>Write</legend><button onClick={async () => { setPending(true); try { await write(); } finally { setPending(false); } }}>Save</button></BusyFieldset>;
    }
    render(<Surface />);
    const control = screen.getByRole("button", { name: "Save" });
    control.focus(); fireEvent.click(control);
    await afterRenderingUpdate();
    expect(control).toHaveFocus();
    expect(control).toBeEnabled();
    expect(control.closest("fieldset")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(control);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("retains native unavailability for a permission or validation reason", () => {
    render(<BusyButton disabled pending onClick={vi.fn()}>Not permitted</BusyButton>);
    expect(screen.getByRole("button", { name: "Not permitted" })).toBeDisabled();
  });

  it("keeps a focused submit enabled through draft reset and refresh, then applies its new validation limit", async () => {
    enableFocusFixup();
    const { rerender } = render(<BusyButton>Save</BusyButton>);
    const button = screen.getByRole("button", { name: "Save" });
    button.focus();
    rerender(<BusyButton pending>Save</BusyButton>);
    rerender(<BusyButton pending disabled>Save</BusyButton>);
    await afterRenderingUpdate();
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    rerender(<BusyButton disabled>Save</BusyButton>);
    expect(button).toBeDisabled();
  });

  it("blocks an immediate second activation even before pending props commit", async () => {
    let finish;
    const write = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const lock = { current: new Set() };
    render(<BusyButton onClick={() => runBusyWrite(lock, "save", write)}>Save</BusyButton>);
    const control = screen.getByRole("button", { name: "Save" });
    fireEvent.click(control); fireEvent.click(control);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    fireEvent.click(control);
    expect(write).toHaveBeenCalledTimes(2);
    await act(async () => finish());
  });


  it("guards the write itself and releases after a refused or failed operation", async () => {
    let finish;
    const ref = { current: new Set() };
    const event = { preventDefault: vi.fn() };
    const write = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const first = runBusyWrite(ref, "save", write, event);
    await runBusyWrite(ref, "save", write, event);
    expect(write).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    finish(); await first;
    await expect(runBusyWrite(ref, "save", () => { throw new Error("refused"); })).rejects.toThrow("refused");
    await expect(runBusyWrite(ref, "save", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(ref.current.size).toBe(0);
    await runBusyWrite(ref, "save", async () => "saved");
    expect(ref.current.size).toBe(0);
  });
});
