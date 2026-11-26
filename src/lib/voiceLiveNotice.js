import { useCallback, useRef, useState } from "react";

// A polite live region stays silent when its text does not change. These marks
// are not whitespace, so alternating them changes the accessible text of a
// region that is already mounted. Callers render the mark in a .sr-only child
// and leave it in the accessibility tree (no aria-hidden).
const LIVE_NOTICE_MARKS = ["\u200B", "\u200C"];

export function useVoiceLiveNotice() {
  const [notice, setNotice] = useState({ text: "", token: "" });
  const tick = useRef(0);

  const publishNotice = useCallback((message = "") => {
    const text = typeof message === "string" ? message : "";
    if (text === "") {
      setNotice({ text: "", token: "" });
      return;
    }
    tick.current += 1;
    setNotice({
      text,
      token: LIVE_NOTICE_MARKS[tick.current % 2],
    });
  }, []);

  return { notice, publishNotice };
}
