import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChunkBoundary } from "../src/components/ChunkBoundary.jsx";
import { lazyView } from "../src/lib/lazyView.js";

describe("lazyView hang deadline", () => {
  it("reaches ChunkBoundary view-error after a hung chunk deadline", async () => {
    const Hung = lazyView(() => new Promise(() => {}), 40);
    render(
      <ChunkBoundary fallback={(dismiss) => (
        <div className="view-error" role="alert">
          <h1>Load failed</h1>
          <button type="button" onClick={dismiss}>Try again</button>
        </div>
      )}>
        <Suspense fallback={<div className="view-loading" role="status">Loading</div>}>
          <Hung />
        </Suspense>
      </ChunkBoundary>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(await screen.findByRole("alert")).toHaveTextContent("Load failed");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
