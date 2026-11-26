// What each demo bot does. A script names its persona and the catalog
// functions it covers; its steps drive the page the way that person would,
// through visible controls only, and check the app's own copy.
//
// Checks read copy from the i18n catalogue rather than repeating literals, so a
// wording change fails here the same way it changes for members.
// allLanguages registers the lazily loaded Spanish chunk, which Node needs.
import { catalogue } from "../src/lib/i18n/allLanguages.js";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The app's copy for a key as a pattern, in the persona's language: the
// whole text, or with `exact: false` text that starts with it (an accessible
// name the app extends, like "Switch hat, current: Worker"). "{var}"
// placeholders match any text.
export function copy(key, lang = "en", { exact = true } = {}) {
  const text = catalogue[lang]?.[key] ?? catalogue.en[key];
  if (typeof text !== "string") throw new Error(`No app copy for ${key}`);
  return new RegExp(`^\\s*${escape(text).replace(/\\\{\w+\\\}/g, ".+")}${exact ? "\\s*$" : ""}`);
}

export const SCRIPTS = [
  {
    id: "W-MEMBER-01",
    bot: "bot-01",
    title: "Darnell checks home, votes, reads a committee message and his issue",
    covers: ["DM-001", "DM-002", "DM-003", "DM-004", "DM-006"],
    async run(ui) {
      await ui.seeHeading(/Darnell/);
      await ui.click(copy("today.castVote"));
      await ui.voteOnce();
      // The demo keeps the vote: the open ballot leaves the home list.
      await ui.gone(copy("today.castVote"));
      await ui.click(/^Messages$/);
      await ui.seeHeading("Messages");
      await ui.click(/Rosa Boateng · Committee/);
      // Her name is on the inbox row too; the composer exists only once the
      // conversation is open.
      await ui.seeIn(copy("inbox.detailRegion"), copy("inbox.composerPlaceholder"));
      await ui.dismissDialogs();
      await ui.click(/^Issues/);
      await ui.seeHeading("My issues");
      await ui.seeText("Supervisor meeting with no stated reason");
      await ui.click(/Full issue ›$/);
      // The card already shows the reference; the notes belong to the full issue.
      await ui.seeInDialog(copy("cases.caseNotes"));
      await ui.closeDialog();
      await ui.seeBanner();
    },
  },
  {
    id: "W-MEMBER-02",
    bot: "bot-01",
    title: "Darnell reads his organizing rights",
    covers: ["DM-005", "DM-006"],
    async run(ui) {
      await ui.openRights();
      await ui.seeHeading("Organizing rights");
      await ui.seeHeading("You can talk about forming a union");
      await ui.click(/^Supervisor questions/);
      await ui.seeText("You do not have to say who signed a card or what was said at a meeting.");
      await ui.seeBanner();
    },
  },
  {
    id: "W-MEMBER-03",
    bot: "bot-02",
    title: "Miguel's Spanish phone opens the demo in Spanish and he reads his rights",
    covers: ["DM-007", "DM-008", "DM-005"],
    async run(ui) {
      await ui.seeBanner("es");
      await ui.openRights();
      await ui.seeHeading(copy("learningContent.library.title", "es"));
      await ui.seeBanner("es");
    },
  },
  {
    id: "W-COMMITTEE-01",
    bot: "bot-03",
    title: "Priya works the committee desk: worker requests, messages and broadcasts",
    covers: ["DM-010", "DM-011", "DM-012", "DM-013"],
    async run(ui) {
      await ui.hat("demo.hatSteward");
      await ui.seeHeading("Committee desk");
      await ui.section(/^Worker requests/, "Requests for committee support from workers");
      await ui.section(/^Committee messages/, /^Private worker conversations/);
      await ui.section(/^Broadcasts/, /^Reaches every worker's Broadcasts tab/);
      await ui.noPageErrors();
    },
  },
  {
    id: "W-LEAD-01",
    bot: "bot-04",
    title: "Sam reads the issue queue and its deadlines",
    covers: ["DM-020", "DM-021"],
    async run(ui) {
      await ui.hat("demo.hatCoordinator");
      await ui.seeHeading("Issue queue");
      await ui.section(/^Upcoming deadlines/, "Deadlines across open issues.");
      await ui.section(/^Active issues/, "Issues ordered by urgency and follow-up need.");
      await ui.noPageErrors();
    },
  },
  {
    id: "W-ADVISOR-01",
    bot: "bot-05",
    title: "Avery reads campaign health and the collective workplace log",
    covers: ["DM-030"],
    async run(ui) {
      await ui.hat("demo.hatAdvisor");
      await ui.seeHeading("Campaign health");
      await ui.section(/^Collective workplace log/, /latest log per worker/);
      await ui.noPageErrors();
    },
  },
  {
    id: "W-ADMIN-01",
    bot: "bot-06",
    title: "Alex reviews roles, two-step sign-in and events",
    covers: ["DM-040", "DM-041", "DM-042"],
    async run(ui) {
      await ui.hat("demo.hatAdmin");
      await ui.seeHeading("Campaign admin");
      await ui.section(/roles & access/i, /^Organization-wide roles apply across every campaign/);
      await ui.section(/^Two-step/, /^Staff hold the most sensitive access/);
      await ui.section(/^Meetings & check-in codes/, /for on-site self check-in/);
      await ui.noPageErrors();
    },
  },
  {
    id: "W-CHAIR-01",
    bot: "bot-07",
    title: "Taylor reads the leadership overview and exec attention list",
    covers: ["DM-050", "DM-051"],
    async run(ui) {
      await ui.hat("demo.hatVp");
      await ui.seeHeading("Leadership overview");
      await ui.section(/^Needs exec attention/, "Active issues past their target date.");
      await ui.noPageErrors();
    },
  },
  {
    id: "W-ORGANIZE-01",
    bot: "bot-08",
    title: "Jun walks every tab of the lifecycle workspace",
    covers: ["DM-060", "DM-061", "DM-062"],
    async run(ui) {
      await ui.hat("demo.hatOrganize");
      await ui.seeHeading("Organizing operations");
      await ui.seeText("Counts show how the workspace behaves");
      await ui.seeText("Harborview Care United");
      const tabs = [
        ["Worksites", "Worksite coverage"],
        ["Resistance", "Reported employer conduct"],
        ["Bargaining", "First-contract workspace"],
        ["Engagement", "30/90-day onboarding"],
        ["Coalitions", "Care and Safety Table"],
        ["Impact", "Ten-year impact"],
        ["Campaigns", "Recorded lifecycle"],
      ];
      for (const [tab, heading] of tabs) {
        await ui.tab(tab, heading);
        await ui.noPageErrors();
      }
    },
  },
  {
    id: "W-PUBLIC-01",
    bot: "bot-09",
    title: "Ruth opens the demo from the sign-in screen and leaves",
    covers: ["DM-070", "DM-071"],
    entry: "signin",
    async run(ui) {
      await ui.click(copy("auth.demo"));
      await ui.dismissWelcome();
      await ui.seeBanner();
      await ui.exitDemo();
    },
  },
];
