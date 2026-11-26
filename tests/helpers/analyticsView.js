import { fireEvent, screen, within } from "@testing-library/react";

// The analytics desk has one routed level of sections and one labelled view
// selector (REQ-UG-WEB-ANALYTICS-TAB-OCTOBER-DESIGN-20261002). Opens
// the section that holds the view named `name` and selects it.
export function showAnalyticsView(name) {
  const nav = screen.getByRole("navigation", { name: /^(Analytics sections|Apartados de analítica)$/ });
  for (const section of within(nav).getAllByRole("button")) {
    fireEvent.click(section);
    const select = screen.getByRole("combobox", { name: /^(Show|Mostrar)$/ });
    const option = within(select).queryByRole("option", { name });
    if (option) {
      fireEvent.change(select, { target: { value: option.value } });
      return select;
    }
  }
  throw new Error(`No analytics view named ${name}`);
}

export function analyticsViewOptions() {
  const select = screen.getByRole("combobox", { name: /^(Show|Mostrar)$/ });
  return within(select).getAllByRole("option").map((option) => option.textContent);
}
