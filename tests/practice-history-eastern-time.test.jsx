import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PracticeHistoryLine } from "../src/features/learningPeriod/LearningPeriod.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

describe.each(["America/Los_Angeles", "Asia/Tokyo"])("practice history with browser zone %s", zone => {
  it.each(["en", "es"])("renders the same labelled Eastern time in winter and summer in %s", lang => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function(locale, options) {
      return new NativeDateTimeFormat(locale, { timeZone: zone, ...options });
    });
    try {
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
      for (const createdAt of ["2026-01-15T15:31:00Z", "2026-07-15T14:31:00Z"]) {
        const view = render(<LanguageProvider lang={lang}><ul><PracticeHistoryLine entry={{ id: "tamarack-practice", actionKind: "task_create", createdAt }} status="kept" entries={[]} /></ul></LanguageProvider>);
        const time = view.container.querySelector("time");
        expect(time.textContent).toMatch(/10:31.* ET$/);
        expect(time.dateTime).toBe(new Date(createdAt).toISOString());
        view.unmount();
      }
    } finally { spy.mockRestore(); }
  });
});

it.each([null, "not-a-date"])("does not publish an invalid machine timestamp for %s", createdAt => {
  const view = render(<LanguageProvider lang="en"><ul><PracticeHistoryLine entry={{ id: "tamarack-invalid", actionKind: "task_create", createdAt }} status="kept" entries={[]} /></ul></LanguageProvider>);
  expect(view.container.querySelector("time")).not.toHaveAttribute("datetime");
});
