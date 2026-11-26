import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../../src/lib/LanguageContext.jsx";
import { loadLanguage } from "../../src/lib/i18n.js";
import { TodayView } from "../../src/views/TodayView.jsx";
import { VotingView } from "../../src/views/VotingView.jsx";
import { CasesView } from "../../src/views/CasesView.jsx";
import { MessagesView } from "../../src/views/MessagesView.jsx";
import { MemberFeatureGuide, useMemberGuideLayers } from "../../src/features/onboardingGuideEngine/MemberGuideLayers.jsx";
import { memberFeatureGuides } from "../../src/features/onboardingGuideEngine/memberLayers.js";
import { OnboardingHud } from "../../src/components/OnboardingHud.jsx";
import { fallbackData } from "./retired-pre-bot/src/data/fallback.js";
import "../../src/sg-tokens.css";
import "../../src/styles.css";
import "../../src/coordinator-theme.css";
import "../../src/motion.css";
import "../../src/popups.css";

// The real member views, isolated from every hosted backend. The four pages
// share the same fixture data and callbacks; clicks are observable below.
const params = new URLSearchParams(location.search);
const lang = params.get("lang") || "en";
await loadLanguage(lang);
document.documentElement.lang = lang;
export function MemberActionExample({ view = "home", desktop = false }) {
  const [action, setAction] = React.useState("");
  const note = (name) => () => setAction(name);
  const data = { ...fallbackData, roles: [], chapterStewards: Array.from({ length: 4 }, (_, i) => ({ id: `steward-${i}`, name: `Fictional steward ${i + 1}`, initials: "FS", isPrimary: i === 0 })) };
  const common = { data, desktop, onPlanAction: note("plan"), onMessageSteward: note("message"), onNotice: note("notice") };
  const guide = <MemberFeatureGuide guides={{ showingAs: "first", showing: {
    feature: "home", title: { key: "nav.home" },
    canDo: [], neverDo: [], firstLabel: { key: "guideEngine.fg.memberFirst.home" },
  } }} onPrimary={note("guide")} onGotIt={note("dismiss")}/>;
  return <div className={`sg-app${desktop ? " sg-app--desktop" : ""}`} data-workspace-theme="union-ground">
    <main className="app-column" style={{ width: "100%", maxWidth: 1200, margin: "auto" }}>
      {guide}
      {view === "home" && <TodayView
        {...common}
        onOpenWorkload={note("workload")}
        onAssistant={note("compass")}
        onOpenCases={note("cases")}
        onOpenEvents={note("events")}
        onOpenMessages={note("messages")}
        onOpenOrgStructure={note("organization")}
        onContactSteward={note("steward")}
        homeTakeover={{
          transport: { preview: true },
          onOpenConversation: note("conversation"),
          onOpenBroadcast: note("announcement"),
          onMarkConversationRead: async () => {},
          onMarkBroadcastRead: async () => {},
        }}
      />}
      {view === "voting" && <VotingView {...common} demo onSuggestPoll={note("poll")}/>}
      {view === "cases" && <CasesView {...common} onCreateCase={note("create-case")} onMessages={note("message")}/>}
      {view === "messages" && <MessagesView {...common} onSendMessage={note("send")} onReadConversation={async () => {}} onReadBroadcast={async () => {}} onOpenTopics={note("topics")}/>}
      <output aria-label="Fixture action">{action}</output>
    </main>
  </div>;
}
const root = document.getElementById("root");
export function MemberGuidePage({ onboarding = true, desktop = false }) {
  const { featureMarks, markFeature } = useMemberGuideLayers({ memberId: "guide-priority-proof", featureGuidesOn: true, coachMarksOn: false });
  const guides = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true, view: "voting", marks: featureMarks }).view;
  const complete = { applies: true, showHud: true, stage: "complete", onboardingComplete: true, totalSteps: 4, completedSteps: 4 };
  return <div className={`sg-app${desktop ? " sg-app--desktop" : ""}`} data-workspace-theme="union-ground"><main className="app-column" style={{ width: "100%", maxWidth: 1200, margin: "auto" }}>
    <OnboardingHud guide={onboarding ? complete : null} memberId="guide-priority-proof">
      <MemberFeatureGuide guides={guides} onSeen={(feature) => markFeature("seen", feature)} onGotIt={(item) => markFeature("got", item.feature)} />
    </OnboardingHud>
    <div data-testid="working-content"><VotingView data={fallbackData} desktop={desktop} demo/></div>
  </main></div>;
}
if (root) createRoot(root).render(<LanguageProvider lang={lang}>{params.has("guidance") ? <MemberGuidePage desktop={matchMedia("(min-width: 1000px)").matches}/> : <MemberActionExample view={params.get("view") || "home"} desktop={matchMedia("(min-width: 1000px)").matches}/>}</LanguageProvider>);
