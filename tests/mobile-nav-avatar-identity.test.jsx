import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { primeDemoHat } from "./helpers/demoHat.js";

it("uses the desktop rail's SAMPLE Member identity in the small-screen drawer", async () => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/m?demo=1");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  primeDemoHat("member");
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "All features" }));
  expect(document.querySelector(".card-nav__avatar")).toHaveAccessibleName("DF Profile");
  expect(document.querySelector(".card-nav__avatar")).toHaveTextContent("DF");
});
