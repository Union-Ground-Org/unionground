import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoVoiceMember } from "../src/components/DemoVoiceMember.jsx";
import { DemoVoiceStudio } from "../src/components/DemoVoiceStudio.jsx";
import { DEMO_VOICE_CAPABILITIES } from "./fixtures/retired-pre-bot/src/lib/demoVoiceParity.js";

describe("clean-room Voice demo contract", () => {
  it("accounts for every CR-001 through CR-019 front-end function without claiming backend readiness", () => {
    expect(DEMO_VOICE_CAPABILITIES).toHaveLength(19);
    expect(DEMO_VOICE_CAPABILITIES.map((item) => item.id)).toEqual(
      Array.from({ length: 19 }, (_, index) => `CR-${String(index + 1).padStart(3, "0")}`),
    );
    expect(new Set(DEMO_VOICE_CAPABILITIES.map((item) => item.interaction)).size).toBe(19);
    expect(DEMO_VOICE_CAPABILITIES.every((item) => item.backendReady === false)).toBe(true);
    expect(new Set(DEMO_VOICE_CAPABILITIES.map((item) => item.surface))).toEqual(new Set(["member", "staff", "both"]));

    const view = render(
      createElement(
        "div",
        null,
        createElement(DemoVoiceMember),
        createElement(DemoVoiceStudio),
      ),
    );
    const renderedCapabilities = new Set(
      [...view.container.querySelectorAll("[data-voice-capabilities]")]
        .flatMap((element) => element.dataset.voiceCapabilities.split(" ")),
    );
    expect(renderedCapabilities).toEqual(
      new Set(DEMO_VOICE_CAPABILITIES.map((item) => item.id)),
    );
  });
});
