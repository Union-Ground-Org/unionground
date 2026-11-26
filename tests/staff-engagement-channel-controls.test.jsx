import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { engagementApi } from "../src/features/engagement/api.js";

const client = {};
const channel = {
  spaceId: "room",
  name: "Chapter room",
  postingMode: "members",
  slowModeSeconds: 0,
  approvalsRequired: false,
};
const snapshot = { surveys: [], livePolls: [], channels: [channel], pulsePrompts: [] };
const CHANNEL_UPDATE_FAILED = "Channel controls could not be updated.";

async function renderChannels() {
  render(<LanguageProvider lang="en"><StaffEngagement client={client} /></LanguageProvider>);
  await screen.findByTestId("staff-engagement");
  fireEvent.click(screen.getByRole("button", { name: "Channels" }));
  expect(await screen.findByRole("heading", { name: "Chapter room" })).toBeInTheDocument();
  return {
    posting: screen.getByLabelText("Posting"),
    slow: screen.getByLabelText("Slow mode seconds"),
    approvals: screen.getByLabelText("Require post approval"),
  };
}

beforeEach(() => {
  vi.spyOn(engagementApi, "loadStaff").mockResolvedValue(snapshot);
  vi.spyOn(engagementApi, "setChannelControls").mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("channel controls roll back when the RPC is refused", () => {
  it("restores posting mode and shows the catalogue failure notice", async () => {
    engagementApi.setChannelControls.mockRejectedValue(new Error(""));
    const { posting } = await renderChannels();
    expect(posting).toHaveValue("members");
    fireEvent.change(posting, { target: { value: "read_only" } });
    await waitFor(() => expect(screen.getByLabelText("Posting")).toHaveValue("members"));
    expect(screen.getByRole("alert")).toHaveTextContent(CHANNEL_UPDATE_FAILED);
  });

  it("restores slow-mode seconds after a refused blur", async () => {
    engagementApi.setChannelControls.mockRejectedValue(new Error(""));
    const { slow } = await renderChannels();
    fireEvent.change(slow, { target: { value: "30" } });
    fireEvent.blur(slow, { target: { value: "30" } });
    await waitFor(() => expect(screen.getByLabelText("Slow mode seconds")).toHaveValue(0));
    expect(screen.getByRole("alert")).toHaveTextContent(CHANNEL_UPDATE_FAILED);
  });

  it("restores the approvals checkbox after a refused toggle", async () => {
    engagementApi.setChannelControls.mockRejectedValue(new Error(""));
    const { approvals } = await renderChannels();
    expect(approvals).not.toBeChecked();
    fireEvent.click(approvals);
    await waitFor(() => expect(screen.getByLabelText("Require post approval")).not.toBeChecked());
    expect(screen.getByRole("alert")).toHaveTextContent(CHANNEL_UPDATE_FAILED);
  });

  it("sends the snapshot posting mode with a later slow-mode save after a refused posting change", async () => {
    const payloads = [];
    engagementApi.setChannelControls.mockImplementation(async (_client, _spaceId, controls) => {
      payloads.push({ ...controls });
      if (payloads.length === 1) throw new Error("");
    });
    const { posting, slow } = await renderChannels();
    fireEvent.change(posting, { target: { value: "read_only" } });
    await waitFor(() => expect(screen.getByLabelText("Posting")).toHaveValue("members"));
    fireEvent.change(slow, { target: { value: "30" } });
    fireEvent.blur(slow, { target: { value: "30" } });
    await waitFor(() => expect(payloads).toHaveLength(2));
    expect(payloads[1].postingMode).toBe("members");
    expect(Number(payloads[1].slowModeSeconds)).toBe(30);
    expect(screen.getByRole("status")).toHaveTextContent("Slow mode updated.");
  });

  it("awaits the snapshot refresh before accepting another change", async () => {
    let releaseRefresh;
    const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
    engagementApi.loadStaff
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => refresh);
    const { posting, slow } = await renderChannels();
    fireEvent.change(posting, { target: { value: "read_only" } });
    await waitFor(() => expect(engagementApi.setChannelControls).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent("Posting controls updated.");
    await waitFor(() => expect(screen.getByLabelText("Posting")).toHaveAttribute("aria-disabled", "true"));
    fireEvent.change(slow, { target: { value: "30" } });
    fireEvent.blur(slow, { target: { value: "30" } });
    expect(engagementApi.setChannelControls).toHaveBeenCalledTimes(1);
    expect(engagementApi.loadStaff).toHaveBeenCalledTimes(2);
    releaseRefresh({ ...snapshot, channels: [{ ...channel, postingMode: "read_only" }] });
    await waitFor(() => expect(screen.getByLabelText("Posting")).not.toHaveAttribute("aria-disabled"));
    expect(screen.getByLabelText("Posting")).toHaveValue("read_only");
  });
});
