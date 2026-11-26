import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/AppRouter.jsx";
import { deniedHostsIn } from "../scripts/lib/denied-identity.mjs";
import { FORBIDDEN_APP_HOST_DIGESTS } from "../src/lib/providerContract.js";

afterEach(() => window.history.replaceState({}, "", "/m"));

describe("legacy route isolation", () => {
  for (const route of [
    "/contractsurvey",
    "/contractsurvey/",
    "/contractsurvey/legacy",
    "/design",
    "/design/Solid%20Ground%20Hub.dc.html",
  ]) {
    it(`does not load inherited providers at ${route}`, () => {
      window.history.replaceState({}, "", route);
      render(<App />);
      expect(
        screen.getByRole("heading", {
          name: "This inherited page is not part of Union Ground.",
        }),
      ).toBeInTheDocument();
      expect(document.querySelector("iframe")).toBeNull();
      // No link names a sibling product's site (checked by digest, so the
      // retired hosts are not spelled out here).
      const hrefs = [...document.querySelectorAll("a[href]")].map((link) => link.getAttribute("href"));
      expect(hrefs.flatMap((href) => deniedHostsIn(href.toLowerCase(), FORBIDDEN_APP_HOST_DIGESTS))).toEqual([]);
    });
  }
});
