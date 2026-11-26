import { useEffect, useRef } from "react";

// The one keyboard model the custom role="radiogroup" surfaces share
// [A11Y-UG-CUSTOM-RADIOGROUPS-NO-KEYBOARD-MODEL-20260920]. Five web
// surfaces reassigned plain buttons to role="radio" and stopped there: each
// option was its own Tab stop and the arrow keys a screen reader promises did
// nothing. Threading a roving index through each view would have copied the
// same bug-prone bookkeeping five times, so the group owns the behaviour and
// reads its own options back out of the DOM it just rendered. Selection still
// travels through each option's existing onClick, which is why call sites keep
// their state exactly as it was. MessageWorkflowPicker predates this group and
// keeps its own equivalent roving model.
const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function radios(group) {
  if (!group) return [];
  return [...group.querySelectorAll("[role=\"radio\"]")]
    .filter((option) => !option.disabled && option.getAttribute("aria-disabled") !== "true");
}

export function RadioGroup({ children, ...rest }) {
  const groupRef = useRef(null);

  // aria-checked lives in the call site's state, so the Tab stop is re-derived
  // after every commit: keyboard, pointer and programmatic changes all land
  // here. A group with nothing checked keeps the stop on its first option —
  // otherwise Tab would skip the control entirely.
  useEffect(() => {
    const options = radios(groupRef.current);
    if (options.length === 0) return;
    const stop = options.find((option) => option.getAttribute("aria-checked") === "true") ?? options[0];
    for (const option of options) option.tabIndex = option === stop ? 0 : -1;
  });

  function onKeyDown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    // Only an option's own keystrokes steer the group; anything else inside it
    // keeps its keys.
    const current = event.target.closest?.("[role=\"radio\"]");
    if (!current) return;
    const options = radios(groupRef.current);
    const index = options.indexOf(current);
    if (index === -1) return;

    let next = null;
    if (event.key === "Home") next = options[0];
    else if (event.key === "End") next = options[options.length - 1];
    else if (event.key in STEP) next = options[(index + STEP[event.key] + options.length) % options.length];
    if (!next) return;

    event.preventDefault();
    next.focus();
    // Focus and selection move together — the radio pattern's default, and the
    // only one that matches what these groups already do on click.
    if (next.getAttribute("aria-checked") !== "true") next.click();
  }

  return (
    <div {...rest} role="radiogroup" ref={groupRef} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
