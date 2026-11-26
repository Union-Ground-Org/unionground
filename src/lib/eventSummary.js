// An event summary is one paragraph
// (BUG-UG-EVENT-SUMMARY-LINE-BREAK-REFUSED-WITH-ONLY-A-TOAST-20261108):
// create_member_event and update_member_event refuse any control character in
// it (it travels into calendar feeds and notices as one line), and every reader
// shows it as one paragraph. So in its box Enter types a space, and a pasted
// line break, tab or other control character becomes one space.

// PostgreSQL's [[:cntrl:]]: C0, DEL and C1.
// eslint-disable-next-line no-control-regex
const CONTROL_RUN = /\s*[\u0000-\u001f\u007f-\u009f]+\s*/g;

export function oneParagraph(value) {
  return String(value ?? "").replace(CONTROL_RUN, " ");
}

// Enter becomes a space where the caret is (none at the start or after a
// space), announced as an ordinary input so a controlled box keeps the caret.
export function keepOneParagraph(event) {
  if (event.key !== "Enter" || event.nativeEvent?.isComposing) return;
  event.preventDefault();
  const box = event.currentTarget;
  const start = box.selectionStart ?? box.value.length;
  if ((start === 0 || /\s/.test(box.value.charAt(start - 1))) && box.selectionEnd === start) return;
  box.setRangeText(" ", start, box.selectionEnd ?? start, "end");
  box.dispatchEvent(new Event("input", { bubbles: true }));
}
