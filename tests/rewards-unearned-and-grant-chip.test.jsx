import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCosmetics } from "../src/components/FreeCosmetics.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { rewardsGrantChipCopy, rewardsGrantChipFor } from "../src/lib/rewardsGrantChipCopy.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// BUG-UG-REWARDS-TIER-GATED-AND-DISABLED-APPLY-20261106: Rewards
// showed the label "Tier-gated" and a greyed Apply under a badge the member had
// not earned. An unearned cosmetic shows its "Not earned yet" state without a
// control; earned ones keep Apply and Remove; the chip reads as plain copy.
afterEach(cleanup);

const rewards = (items) => ({
  available: true, busy: false, error: null,
  workspace: { canGrant: false, recipients: [], history: [], items },
  load: vi.fn(), select: vi.fn(), grant: vi.fn(),
});

describe("free cosmetics controls", () => {
  it("offers no control on an unearned cosmetic and keeps Apply and Remove on earned ones", () => {
    render(<LanguageProvider lang="en"><FreeCosmetics rewards={rewards([
      { kind: "badge", key: "learning-spark", labelEn: "Learning Spark", labelEs: "Chispa", earned: false, selected: false },
      { kind: "badge", key: "gold-star", labelEn: "Gold Star", labelEs: "Estrella dorada", earned: true, selected: false },
      { kind: "badge", key: "star", labelEn: "Star", labelEs: "Estrella", earned: true, selected: true },
    ])} /></LanguageProvider>);
    expect(screen.queryByRole("button", { name: "Apply Learning Spark" })).toBeNull();
    expect(screen.getByText("Not earned yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply Gold Star" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Star" })).toBeEnabled();
  });
});

describe("rewards grant chip", () => {
  it("reads as plain copy in both languages, outside the locale barrels", () => {
    expect(rewardsGrantChipCopy.en).toBe("Rewards are granted by your chapter admin");
    expect(rewardsGrantChipCopy.es).toBe("Las recompensas las otorga el administrador de tu capítulo");
    for (const lang of ["en", "es"]) expect(rewardsGrantChipCopy[lang]).not.toMatch(/tier-gated|por nivel/i);
    expect(rewardsGrantChipFor("fr")).toBe(rewardsGrantChipCopy.en);
    // The barrel key is untouched (the release guard), and the view no longer reads it.
    expect(catalogue.en["rewards.grantChip"]).toBe("Granted by your campaign admin");
    expect(catalogue.es["rewards.grantChip"]).toBe("Otorgado por tu administrador de la campaña");
    expect(readFileSync(resolve(process.cwd(), "src/views/RewardsView.jsx"), "utf8")).not.toContain("rewards.grantChip");
  });
});
