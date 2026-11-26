// The task title bound the database checks (chapter_tasks_title_bounded:
// char_length(btrim(title)) between 1 and 160). char_length counts code points,
// and btrim with no second argument removes spaces only, so a title may carry
// surrounding spaces and astral characters such as emoji and still be within
// the bound. A browser maxLength counts UTF-16 units of the untrimmed text and
// refused such titles early.
export const TASK_TITLE_MAX = 160;

function trimmedLength(chars) {
  let start = 0;
  while (start < chars.length && chars[start] === " ") start += 1;
  let end = chars.length;
  while (end > start && chars[end - 1] === " ") end -= 1;
  return end - start;
}

// The typed title, held to the bound as maxLength holds a box, but counted in
// trimmed code points. A change within the bound is kept whole. Past it, the
// edit is found by comparing with `previous`: the text before and after the
// edit stays, and only as much of the typed or pasted text as fits goes in, so
// no existing text is ever cut off (gate review of #9042, P1-1), and a
// replacement keeps its fitting start (re-check P2: select one character of a
// full title and type "YZ", and "Y" replaces it).
export function limitTaskTitle(value, previous = "") {
  const text = String(value ?? "");
  const next = Array.from(text);
  if (trimmedLength(next) <= TASK_TITLE_MAX) return text;
  const before = Array.from(String(previous ?? ""));
  let head = 0;
  while (head < before.length && head < next.length && before[head] === next[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < next.length - head
    && before[before.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  const prefix = next.slice(0, head);
  const inserted = next.slice(head, next.length - tail);
  const suffix = next.slice(next.length - tail);
  const fits = (count) => trimmedLength([...prefix, ...inserted.slice(0, count), ...suffix]) <= TASK_TITLE_MAX;
  // The trimmed length never falls as more inserted text is kept, so the
  // longest fitting start is found by halving.
  if (!fits(0)) return String(previous ?? "");
  let low = 0;
  let high = inserted.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return [...prefix, ...inserted.slice(0, low), ...suffix].join("");
}
