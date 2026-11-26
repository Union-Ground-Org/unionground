import { expect } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

// Selection is deliberately local until the member confirms the upload.
export async function confirmEvidenceUpload() {
  const button = await screen.findByRole("button", { name: /^Upload(?: file)?$/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
