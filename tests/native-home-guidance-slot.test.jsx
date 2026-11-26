import { createElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: { mode: "authenticated", session: { user: { id: "member-1", user_metadata: { union_ground_password_issued_at: "2026-10-19T14:00:00.000Z" } } } },
  dismissed: false,
  dismiss: vi.fn(),
  push: vi.fn(),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles) => styles },
  View: ({ children }) => createElement("div", null, children),
  Text: ({ children }) => createElement("span", null, children),
  Pressable: ({ children, onPress }) => createElement("button", { onClick: onPress }, typeof children === "function" ? children({ pressed: false }) : children),
}));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("../apps/mobile/src/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("../apps/mobile/src/theme/ThemeProvider", () => ({ useTheme: () => ({ primary: "black", mutedForeground: "black" }) }));
vi.mock("../apps/mobile/src/services/haptics", () => ({ haptics: { select: async () => {} } }));
vi.mock("../apps/mobile/src/services/supabase", () => ({ getSupabaseClient: () => null }));
vi.mock("../apps/mobile/src/services/homeNudges", () => ({
  isPasswordPromptDismissed: async () => mocks.dismissed,
  dismissPasswordPrompt: (...args) => { mocks.dismissed = true; mocks.dismiss(...args); return Promise.resolve(); },
  loadHomeNudges: async () => ({ onboarding: { completed: 1, total: 4 }, passkey: false, guidedFirstRun: false, snoozeDays: 28 }),
  readHomeNudgeHistory: async () => ({}),
  markHomeNudgeShown: async () => {},
  dismissHomeNudge: async () => {},
}));
vi.mock("../apps/mobile/src/components/ui", () => ({
  Card: ({ children }) => createElement("section", null, children),
  Heading: ({ children }) => createElement("h2", null, children),
  Body: ({ children }) => createElement("p", null, children),
  Button: ({ label, onPress }) => createElement("button", { onClick: onPress }, label),
}));

import { ChoosePasswordNudge } from "../apps/mobile/src/features/home/ChoosePasswordNudge";
import { HomeNudge } from "../apps/mobile/src/features/home/HomeNudge";
import { OnboardingGuideHomeSlot } from "../apps/mobile/src/features/onboardingGuide/OnboardingGuideCard";
import { INACTIVE_ONBOARDING_GUIDE } from "../apps/mobile/src/lib/onboardingGuide";

const stamp = "2026-10-19T14:00:00.000Z";
const activeGuide = { ...INACTIVE_ONBOARDING_GUIDE, applies: true, showHud: true, stage: "welcome", onboardingComplete: false, totalSteps: 4, completedSteps: 1, featureDrip: true };
const tree = (guide = activeGuide) => <ChoosePasswordNudge><OnboardingGuideHomeSlot guide={guide}><HomeNudge /></OnboardingGuideHomeSlot></ChoosePasswordNudge>;

beforeEach(() => {
  mocks.dismissed = false;
  mocks.app.session = { user: { id: "member-1", user_metadata: { union_ground_password_issued_at: stamp } } };
  mocks.dismiss.mockClear();
});

describe("native Home guidance", () => {
  it("selects password, guide, then regular onboarding without losing dismissal", async () => {
    const view = render(tree());
    expect(await screen.findByRole("heading", { name: "Choose your own password" })).toBeInTheDocument();
    expect(screen.queryByText("Start with one clear next step")).toBeNull();
    expect(screen.queryByText("Complete your onboarding")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByText("Start with one clear next step")).toBeInTheDocument();
    expect(screen.queryByText("Complete your onboarding")).toBeNull();
    expect(mocks.dismiss).toHaveBeenCalledWith("member-1", stamp);
    view.rerender(tree(INACTIVE_ONBOARDING_GUIDE));
    expect(await screen.findByText("Complete your onboarding")).toBeInTheDocument();
    view.rerender(tree());
    expect(screen.getByText("Start with one clear next step")).toBeInTheDocument();
    expect(screen.queryByText("Choose your own password")).toBeNull();
    view.unmount();
    render(tree());
    expect(await screen.findByText("Start with one clear next step")).toBeInTheDocument();
  });

  it("releases the slot to regular onboarding when the password stamp clears", async () => {
    const view = render(tree(INACTIVE_ONBOARDING_GUIDE));
    await screen.findByText("Choose your own password");
    mocks.app.session = { user: { id: "member-1", user_metadata: {} } };
    view.rerender(tree(INACTIVE_ONBOARDING_GUIDE));
    expect(await screen.findByText("Complete your onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Choose your own password")).toBeNull();
  });

  it("yields the Home slot when the guide completes", async () => {
    mocks.app.session = { user: { id: "member-1", user_metadata: {} } };
    render(tree({ ...activeGuide, stage: "complete", onboardingComplete: true, completedSteps: 4 }));
    expect(await screen.findByText("Complete your onboarding")).toBeInTheDocument();
    expect(screen.queryByText("Start with one clear next step")).toBeNull();
  });

  it("rechecks a new password stamp rather than carrying the previous dismissal", async () => {
    const view = render(tree());
    await screen.findByText("Choose your own password");
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    mocks.dismissed = false;
    mocks.app.session = { user: { id: "member-1", user_metadata: { union_ground_password_issued_at: "2026-10-23T12:00:00.000Z" } } };
    await act(async () => { view.rerender(tree()); });
    expect(await screen.findByText("Choose your own password")).toBeInTheDocument();
    expect(screen.queryByText("Start with one clear next step")).toBeNull();
  });
});
