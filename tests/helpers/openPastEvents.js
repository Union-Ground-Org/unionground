import { fireEvent, screen } from "@testing-library/react";

// UX-UG-LONG-PAGES-RENDER-EVERY-ROW-EXPANDED-WITH-NO-PAGING-20261122:
// the events card folds past events behind one button. Fixtures dated before
// today open it first, the way a person would, to reach those events' tools.
const PAST_TOGGLE = /^(Show \d+ past meetings?|Mostrar \d+ reuni(?:ón pasada|ones pasadas))$/;

export function openPastEvents() {
  for (const toggle of screen.queryAllByRole("button", { name: PAST_TOGGLE })) fireEvent.click(toggle);
}
