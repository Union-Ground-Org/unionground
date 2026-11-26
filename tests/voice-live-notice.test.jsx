import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useVoiceLiveNotice } from "../src/lib/voiceLiveNotice.js";

describe("useVoiceLiveNotice", () => {
  it("changes the accessible token when the same sentence is published again", () => {
    const { result } = renderHook(() => useVoiceLiveNotice());
    expect(result.current.notice).toEqual({ text: "", token: "" });

    act(() => result.current.publishNotice("Question reserved for editorial review."));
    const first = result.current.notice;
    expect(first.text).toBe("Question reserved for editorial review.");
    expect(first.token).toMatch(/\S/);

    act(() => result.current.publishNotice("Question reserved for editorial review."));
    expect(result.current.notice.text).toBe(first.text);
    expect(result.current.notice.token).not.toBe(first.token);
    expect(result.current.notice.token).toMatch(/\S/);
  });

  it("clears the live notice for an empty or non-string message", () => {
    const { result } = renderHook(() => useVoiceLiveNotice());
    act(() => result.current.publishNotice("Support added."));
    expect(result.current.notice.text).toBe("Support added.");

    act(() => result.current.publishNotice(""));
    expect(result.current.notice).toEqual({ text: "", token: "" });

    act(() => result.current.publishNotice("Support removed."));
    act(() => result.current.publishNotice(null));
    expect(result.current.notice).toEqual({ text: "", token: "" });
  });
});
