import React from "react";
import { createRoot } from "react-dom/client";
import { EventAuthoringCard } from "../../src/components/EventAuthoringCard.jsx";
import { MobileTopBar } from "../../src/components/MobileTopBar.jsx";
import { PlaneHeader } from "../../src/components/PlaneHeader.jsx";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { OrganizationNameProvider } from "../../src/lib/organizationName.js";
import "../../src/sg-tokens.css";
import "../../src/styles.css";

const noop = () => {};
const event = { id: "tamarack-meeting", title: "Tamarack planning meeting", startsAt: "2099-11-18T18:00:00Z", location: "Tamarack hall", summary: "Plan the chapter meeting.", checkInCode: "SG-TAMAR" };
createRoot(document.getElementById("root")).render(<LanguageProvider lang="en"><OrganizationNameProvider value="Tamarack Workers Association">
  <div className="sg-app institutional" data-workspace-theme="union-ground">
    <MobileTopBar onHome={noop} onFeatures={noop} onNotifications={noop} onProfile={noop} initials="AE" roleLabel="Steward" hatOptions={[{ key: "member", label: "Member" }, { key: "steward", label: "Steward" }]} activeHat="steward" onHatChange={noop} />
    <main className="app-column"><div className="screen">
      <PlaneHeader title="Events" sub="Create and manage Tamarack chapter events." />
      <EventAuthoringCard events={[event]} api={{}} onNotice={noop} reload={noop} chapterName="Tamarack chapter" />
    </div></main>
  </div>
</OrganizationNameProvider></LanguageProvider>);
