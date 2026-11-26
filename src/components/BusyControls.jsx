import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import "./busyControls.css";

const unavailable = value => value === true || value === "true";
function refuse(event) {
  event.preventDefault();
  event.stopPropagation();
}
const navigationKey = event => ["Tab", "Escape"].includes(event.key)
  || ((event.ctrlKey || event.metaKey) && ["a", "c", "insert"].includes(event.key.toLowerCase()));

function usePendingDisabled(disabled, pending) {
  const settled = useRef(Boolean(disabled));
  useLayoutEffect(() => { if (!pending) settled.current = Boolean(disabled); }, [disabled, pending]);
  // A successful write may clear a required draft or start a refresh before
  // its promise settles. Apply that new native unavailability after pending
  // work ends; the aria-disabled guard already refuses every activation.
  // A control that was genuinely disabled before the write stays disabled.
  return pending ? settled.current : disabled;
}

// `disabled` is a permission/validation reason. `pending` describes work in
// flight: announce unavailability, block activation, and keep the DOM node
// focusable. The caller's write function also uses its own synchronous lock.
// #9458: with `disabledReason` a blocked button stays focusable, shows and is
// described by the reason, and a refused press announces it and calls
// `onBlockedPress`. Ignored while busy; without it nothing changes.
export function BusyButton({ pending = false, disabled = false, disabledReason = null, onBlockedPress, onClick, onClickCapture, onKeyDownCapture, "aria-disabled": ariaDisabled, "aria-busy": ariaBusy, "aria-describedby": describedBy, ...props }) {
  const busy = Boolean(pending);
  const reason = disabled && !busy && disabledReason ? disabledReason : null;
  const reasonId = useId();
  const [pressed, setPressed] = useState({ count: 0, reason: null });
  // A press is answered once: when the reason changes or goes away, forget it,
  // so typing back to the same reason stays silent until the next press.
  if (pressed.reason !== null && pressed.reason !== reason) setPressed({ count: pressed.count, reason: null });
  const nativeDisabled = usePendingDisabled(reason ? false : disabled, busy);
  const blocked = Boolean(disabled || busy) || unavailable(ariaDisabled);
  function refuseBlocked(event) {
    refuse(event);
    if (!reason) return;
    setPressed(last => ({ count: last.count + 1, reason }));
    onBlockedPress?.(event);
  }
  function click(event) {
    if (blocked) { refuse(event); return undefined; }
    return onClick?.(event);
  }
  const described = [reason && reasonId, describedBy].filter(Boolean).join(" ") || undefined;
  return <>
    <button {...props} data-busy-control="" data-blocked-reason={reason ? "" : undefined} disabled={nativeDisabled} aria-disabled={blocked || undefined} aria-busy={busy ? true : ariaBusy} aria-describedby={described}
      onKeyDownCapture={event => { if (blocked && ["Enter", " "].includes(event.key)) refuseBlocked(event); else onKeyDownCapture?.(event); }}
      onClickCapture={event => { if (blocked) refuseBlocked(event); else onClickCapture?.(event); }} onClick={click} />
    {/* Silent while typing; each press remounts it as an alert. */}
    {reason && <span key={pressed.count} id={reasonId} className="busy-reason" role={pressed.reason === reason ? "alert" : undefined}>{reason}</span>}
  </>;
}

const fieldValue = node => ({ value: node.value, checked: node.checked, selected: node.tagName === "SELECT" && node.multiple ? [...node.options].map(option => option.selected) : null });
function restoreField(node, saved) {
  if (!node.isConnected || !saved) return;
  if (node.type !== "file") node.value = saved.value;
  if ("checked" in node) node.checked = saved.checked;
  if (saved.selected) [...node.options].forEach((option, index) => { option.selected = saved.selected[index]; });
}

// Inputs that themselves commit (checkboxes, selects and autosaved fields)
// need the same rule. A pending uncontrolled input must not keep an edited
// DOM value from a synthetic change that bypassed its blocked interaction.
function BusyField({ as: Tag, pending = false, disabled = false, readOnly = false, onChange, onInput, onClick, onKeyDown, onBeforeInput, onPaste, onDrop, ref, "aria-disabled": ariaDisabled, ...props }) {
  const element = useRef(null);
  const last = useRef(null);
  const blocked = Boolean(disabled || pending) || unavailable(ariaDisabled);
  const nativeDisabled = usePendingDisabled(disabled, pending);
  const attach = useCallback(node => {
    element.current = node;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
    return undefined;
  }, [ref]);
  useLayoutEffect(() => {
    const node = element.current;
    if (node) last.current = fieldValue(node);
  });
  function change(event, handler) {
    if (blocked) {
      refuse(event);
      const node = event.currentTarget;
      const saved = last.current;
      restoreField(node, saved);
      // Checkbox/radio activation has a browser cancellation step after the
      // handler. Restore again before paint, after that step and React's own
      // controlled-value reconciliation have finished.
      queueMicrotask(() => { if (element.current === node && last.current === saved) restoreField(node, saved); });
      return;
    }
    handler?.(event);
  }
  const guard = handler => event => { if (blocked) refuse(event); else handler?.(event); };
  return <Tag {...props} ref={attach} data-busy-control="" disabled={nativeDisabled}
    {...(Tag === "select" ? {} : { readOnly: readOnly || Boolean(pending) })}
    aria-disabled={blocked || undefined} aria-busy={pending ? true : props["aria-busy"]}
    onChange={event => change(event, onChange)} onInput={event => change(event, onInput)}
    onClick={guard(onClick)} onBeforeInput={guard(onBeforeInput)} onPaste={guard(onPaste)} onDrop={guard(onDrop)}
    onKeyDown={event => { if (blocked && !navigationKey(event)) refuse(event); else onKeyDown?.(event); }} />;
}

export function BusyInput(props) { return <BusyField {...props} as="input" />; }
export function BusySelect(props) { return <BusyField {...props} as="select" />; }
export function BusyTextarea(props) { return <BusyField {...props} as="textarea" />; }

// A natively disabled fieldset would still blur its descendants even after
// their own busy attributes were repaired. Block interaction at the boundary
// while allowing Tab and keeping the focused child mounted and enabled.
function BusyBoundary({ as: Tag, pending = false, disabled = false, onClickCapture, onChangeCapture, onInputCapture, onSubmitCapture, onBeforeInputCapture, onPasteCapture, onDropCapture, onKeyDownCapture, ref, ...props }) {
  const nativeDisabled = usePendingDisabled(disabled, pending);
  const element = useRef(null);
  const savedFields = useRef(new Map());
  const attach = useCallback(node => {
    element.current = node;
    if (typeof ref === "function") return ref(node);
    if (ref) ref.current = node;
    return undefined;
  }, [ref]);
  useLayoutEffect(() => {
    savedFields.current = new Map([...(element.current?.querySelectorAll("input, select, textarea") || [])].map(node => [node, fieldValue(node)]));
  });
  const guardChange = handler => event => {
    if (!pending) { handler?.(event); return; }
    refuse(event);
    const saved = savedFields.current;
    const restore = () => { if (savedFields.current === saved) for (const [node, value] of saved) restoreField(node, value); };
    restore();
    queueMicrotask(restore);
  };
  const guard = handler => event => { if (pending) refuse(event); else handler?.(event); };
  return <Tag {...props} ref={attach} data-busy-control="" {...(Tag === "fieldset" ? { disabled: nativeDisabled } : {})} aria-disabled={Boolean(pending) || undefined} aria-busy={pending ? true : props["aria-busy"]}
    onClickCapture={guard(onClickCapture)} onChangeCapture={guardChange(onChangeCapture)} onInputCapture={guardChange(onInputCapture)}
    onSubmitCapture={guard(onSubmitCapture)}
    onBeforeInputCapture={guard(onBeforeInputCapture)} onPasteCapture={guard(onPasteCapture)} onDropCapture={guard(onDropCapture)}
    onKeyDownCapture={event => { if (pending && !navigationKey(event)) refuse(event); else onKeyDownCapture?.(event); }} />;
}

export function BusyFieldset(props) { return <BusyBoundary {...props} as="fieldset" />; }
export function BusyRegion(props) { return <BusyBoundary {...props} as="div" />; }
