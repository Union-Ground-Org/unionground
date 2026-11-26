// REQ-UG-SIGNED-OUT-SITE-PINE-LOOK-COMPARED-WITH-LIGHT-20261117: Home's
// walkthrough link goes to /press#video. The information pages load lazily, so
// the browser's own jump to the fragment runs before the section exists; the
// document shell jumps once the section is drawn.
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicDocumentShell } from "../src/components/PublicDocumentShell.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { scrollToFragment } from "../src/lib/scrollToFragment.js";

function renderAt(hash) {
  window.history.replaceState(null, "", `/press${hash}`);
  return render(
    <LanguageProvider lang="en">
      <PublicDocumentShell eyebrow="Eyebrow" title="Title" intro="Intro" sections={[{ id: "one", heading: "One" }, { id: "video", heading: "Video" }]}>
        <section id="one"><h2>One</h2></section>
        <section id="video"><h2>Video</h2></section>
      </PublicDocumentShell>
    </LanguageProvider>,
  );
}

describe("scrollToFragment", () => {
  const page = (elements) => ({ getElementById: (id) => elements[id] ?? null });

  it("scrolls to the named element and says so", () => {
    const video = { scrollIntoView: vi.fn() };
    expect(scrollToFragment("#video", page({ video }))).toBe(true);
    expect(video.scrollIntoView).toHaveBeenCalledTimes(1);
    // A percent-encoded name is decoded first.
    const named = { scrollIntoView: vi.fn() };
    expect(scrollToFragment("#about%20team", page({ "about team": named }))).toBe(true);
  });

  it("does nothing for no fragment, a malformed one, an unknown one or an element that cannot scroll", () => {
    const video = { scrollIntoView: vi.fn() };
    expect(scrollToFragment("", page({ video }))).toBe(false);
    expect(scrollToFragment("#", page({ video }))).toBe(false);
    expect(scrollToFragment("#%E0%A4%A", page({ video }))).toBe(false);
    expect(scrollToFragment("#nowhere", page({ video }))).toBe(false);
    expect(scrollToFragment("#still", page({ still: {} }))).toBe(false);
    expect(video.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("a link to a section of an information page", () => {
  const jumped = [];
  const scrollIntoView = vi.fn(function scroll() { jumped.push(this.id); });
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scrollIntoView;
  afterEach(() => {
    jumped.length = 0;
    scrollIntoView.mockClear();
    window.history.replaceState(null, "", "/");
  });

  it("jumps to the named section once the page has drawn it", () => {
    renderAt("#video");
    expect(jumped).toEqual(["video"]);
  });

  it("stays at the top with no fragment, an unknown one or a malformed one", () => {
    renderAt("");
    renderAt("#nowhere");
    renderAt("#%E0%A4%A");
    expect(scrollIntoView).not.toHaveBeenCalled();
    Element.prototype.scrollIntoView = original;
  });
});
