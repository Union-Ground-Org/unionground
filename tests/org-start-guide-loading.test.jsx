import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { DeferredOrgStartGuide } from "../src/features/onboardingGuideEngine/DeferredOrgStartGuide.jsx";

const delayed = vi.hoisted(() => ({ resolve: null }));
vi.mock("../src/features/onboardingGuideEngine/OrgStartGuide.jsx", () => new Promise((resolve) => { delayed.resolve = resolve; }));

it("keeps the organization card visible with inert actions until its interactive chunk is ready", async () => {
  const view = {
    kind: "guide", canAct: true, milestones: [], next: null,
    title: { key: "guideEngine.org.cardTitle", params: { org: "Tamarack Valley" } },
    eyebrow: { key: "guideEngine.org.title" },
    ring: { percent: 0, done: 0, total: 7, text: { key: "guideEngine.org.ring", params: { done: 0, total: 7 } } },
  };
  const { container } = render(<LanguageProvider lang="en"><DeferredOrgStartGuide guide={{ view }} /></LanguageProvider>);
  const title = "Get Tamarack Valley ready for workers";
  expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  expect(container.querySelector(".org-start")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("button", { name: "Continue setup" })).toBeDisabled();
  await waitFor(() => expect(delayed.resolve).toEqual(expect.any(Function)));
  const actual = await vi.importActual("../src/features/onboardingGuideEngine/OrgStartGuide.jsx");
  await act(async () => { delayed.resolve(actual); });
  expect(await screen.findByRole("button", { name: "Continue setup" })).toBeEnabled();
  expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  expect(container.querySelector(".org-start")).not.toHaveAttribute("aria-busy");
});
