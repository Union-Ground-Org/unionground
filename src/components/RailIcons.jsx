// The promo package's line icons (kit/brand/theme/icons.json), copied exactly,
// for every desktop rail row: a 24-unit box, 1.75 stroke, round caps and joins,
// no fill, currentColor. UX-UG-FOLDED-RAIL-AND-COMMAND-PALETTE-ICONS-REPEAT-20261122
// (#9565): folded, the rail is read by its icons, and six Admin pages drew one
// people icon. The owner chose option A ("rail icons A", Mon Nov 23, 2026, about
// 3:06 PM ET): every row its own icon, drawn from the package, with the missing
// ones drawn into the package first. tests/desktop-rail-distinct-icons.test.jsx
// renders every role's rail from the navigation definitions and fails when a
// row has no icon here or two rows that open different pages share one.

const RAIL_ICON_SHAPES = {
  "bell": <><path d="M6.2 16.4V11a5.8 5.8 0 0 1 11.6 0v5.4l1.6 2H4.6z"/><path d="M10 20.4a2.1 2.1 0 0 0 4 0"/></>,
  "bulb": <><path d="M8.6 15.2a5.8 5.8 0 1 1 6.8 0c-.5.4-.8 1-.8 1.6v.4H9.4v-.4c0-.6-.3-1.2-.8-1.6z"/><path d="M9.8 20.2h4.4"/></>,
  "calendar": <><rect x="3.8" y="5.2" width="16.4" height="15" rx="2.6"/><path d="M3.8 9.9h16.4M8.2 3.4v3.5M15.8 3.4v3.5"/></>,
  "calendar-check": <><rect x="3.8" y="5.2" width="16.4" height="15" rx="2.6"/><path d="M3.8 9.9h16.4M8.2 3.4v3.5M15.8 3.4v3.5"/><path d="m9.2 15.1 2 2 3.7-4"/></>,
  "card": <><rect x="3.6" y="5" width="16.8" height="14" rx="2.8"/><path d="M3.6 9.8h16.8M7.4 14.6h4.2"/></>,
  "cases": <><path d="M3.8 8.6a2 2 0 0 1 2-2h12.4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2z"/><path d="M9 6.6V5.4A1.4 1.4 0 0 1 10.4 4h3.2A1.4 1.4 0 0 1 15 5.4v1.2"/><path d="M3.8 12.4h16.4M12 11.2v2.4"/></>,
  "chapters": <><circle cx="9" cy="8.6" r="3.2"/><path d="M3.4 19.6c.4-3.3 2.6-5.3 5.6-5.3s5.2 2 5.6 5.3"/><path d="M15.4 5.7a3.2 3.2 0 0 1 0 5.9M17.2 14.6c1.9.7 3.1 2.4 3.4 5"/></>,
  "chev-right": <path d="m9.4 5.8 6.2 6.2-6.2 6.2"/>,
  "chart": <><path d="M4.2 19.8h15.6"/><path d="M7.2 16.4v-4.6M12 16.4V6.2M16.8 16.4V9.6"/></>,
  "checklist": <><path d="m4.4 6.6 1.6 1.6 2.8-3M4.4 12.6l1.6 1.6 2.8-3M4.4 18.6l1.6 1.6 2.8-3M11.6 7h8M11.6 13h8M11.6 19h8"/></>,
  "civic": <><path d="M3.8 9.2 12 4.2l8.2 5z"/><path d="M5.8 9.2v8.2M9.9 9.2v8.2M14.1 9.2v8.2M18.2 9.2v8.2M3.8 19.8h16.4"/></>,
  "clock": <><circle cx="12" cy="12" r="8.6"/><path d="M12 7.3V12l3.1 1.9"/></>,
  "command": <><path d="M9.2 9.2V6.8a2.4 2.4 0 1 0-2.4 2.4zM14.8 9.2V6.8a2.4 2.4 0 1 1 2.4 2.4zM9.2 14.8v2.4a2.4 2.4 0 1 1-2.4-2.4zM14.8 14.8v2.4a2.4 2.4 0 1 0 2.4-2.4z"/><path d="M9.2 9.2h5.6v5.6H9.2z"/></>,
  "compass": <><circle cx="12" cy="12" r="8.6"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z"/></>,
  "compass-shield": <><path d="M12 3.6 5 6.3v5.2c0 4.3 2.9 7.4 7 8.9 4.1-1.5 7-4.6 7-8.9V6.3z"/><path d="m14.8 8.8-1.6 3.8-3.8 1.6 1.6-3.8z"/></>,
  "contract": <><path d="M6.4 3.8h7.4l4.4 4.4v10a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2z"/><path d="M13.6 3.8v4.6h4.6M8 12.4h7M8 15.8h4.6"/></>,
  "copy": <><rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.2"/><path d="M15.6 8.4V6.2a2 2 0 0 0-2-2H6.2a2 2 0 0 0-2 2v7.4a2 2 0 0 0 2 2h2.2"/></>,
  "desk-admin": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4.9 0 1.7.2 2.5.5"/><rect x="13.6" y="12.8" width="7" height="7" rx="1.6"/><path d="M13.6 16.3h7M17.1 12.8v7"/></>,
  "desk-advisor": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4.9 0 1.7.2 2.5.5"/><circle cx="17" cy="16.4" r="3.8"/><path d="m18.4 15-1 2.4-2.4 1 1-2.4z"/></>,
  "desk-coordinator": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4.9 0 1.7.2 2.5.5"/><path d="m14.4 16.4 2 2 3.8-4.2"/></>,
  "desk-steward": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4.9 0 1.7.2 2.5.5"/><path d="M17.2 12.4l-3.2 1.3v2.3c0 2 1.3 3.4 3.2 4.1 1.9-.7 3.2-2.1 3.2-4.1v-2.3z"/></>,
  "desk-vp": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4.9 0 1.7.2 2.5.5"/><path d="M17.2 12.6l1.1 2.2 2.4.35-1.75 1.7.42 2.4-2.17-1.14-2.17 1.14.42-2.4-1.75-1.7 2.4-.35z"/></>,
  "fist": <><path d="M7.4 11.2V8.4a1.5 1.5 0 0 1 3 0v2.2M10.4 10.2V7.2a1.5 1.5 0 0 1 3 0v3M13.4 10.2V8a1.5 1.5 0 0 1 3 0v2.4M16.4 10.4V9.6a1.5 1.5 0 0 1 3 0v3.6a6.2 6.2 0 0 1-2.4 4.9V21H9.2v-2.6a5.8 5.8 0 0 1-2.2-4.5v-2.1a1.5 1.5 0 0 1 3 0"/><path d="M7.4 12.6h4.2a1.7 1.7 0 0 1 0 3.4H10"/></>,
  "folder": <><path d="M3.6 7.4a2 2 0 0 1 2-2h3.6l2.1 2.3h7.1a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z"/></>,
  "form": <><rect x="4.4" y="3.8" width="15.2" height="16.4" rx="2.2"/><rect x="7.6" y="7.2" width="8.8" height="3.2" rx="1"/><rect x="7.6" y="13.2" width="8.8" height="3.2" rx="1"/></>,
  "funnel": <><path d="M4 5h16l-6.2 7.4v5.4l-3.6 2.2v-7.6z"/></>,
  "globe": <><circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.5 2.4 3.8 5.3 3.8 8.6s-1.3 6.2-3.8 8.6c-2.5-2.4-3.8-5.3-3.8-8.6S9.5 5.8 12 3.4z"/></>,
  "grid": <><rect x="4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6"/></>,
  "hand": <><path d="M8.4 12.2V6.4a1.4 1.4 0 0 1 2.8 0v4.8M11.2 11V4.8a1.4 1.4 0 0 1 2.8 0V11M14 11.2V6.4a1.4 1.4 0 0 1 2.8 0v8.2a5.4 5.4 0 0 1-5.4 5.4h-.6a5.6 5.6 0 0 1-4.6-2.4l-3-4.4a1.5 1.5 0 0 1 2.3-1.9l1.7 1.9"/></>,
  "history": <><path d="M4.4 12a7.6 7.6 0 1 0 2.4-5.5"/><path d="M4.2 4.7v3.9h3.9"/><path d="M12 8.1v4.2l2.7 1.7"/></>,
  "home": <><path d="M4.2 11.2 12 4.4l7.8 6.8"/><path d="M6.4 9.6v9.6h11.2V9.6"/><path d="M10 19.2v-5h4v5"/></>,
  "inbox": <><path d="M3.8 13.4 6.3 6a1.6 1.6 0 0 1 1.5-1.1h8.4a1.6 1.6 0 0 1 1.5 1.1l2.5 7.4v4.8a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2z"/><path d="M3.8 13.4h4.4l1.4 2.4h4.8l1.4-2.4h4.4"/></>,
  "key": <><circle cx="8" cy="15.6" r="3.8"/><path d="m10.7 12.9 8.9-8.9M16.4 7.2l2.4 2.4M14 9.6l1.8 1.8"/></>,
  "layers": <><path d="m12 3.6 8.4 4.5-8.4 4.5-8.4-4.5z"/><path d="m3.6 12.2 8.4 4.5 8.4-4.5"/><path d="m3.6 16.1 8.4 4.5 8.4-4.5"/></>,
  "lifering": <><circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="3.6"/><path d="m5.9 5.9 3.6 3.6M14.5 14.5l3.6 3.6M18.1 5.9l-3.6 3.6M9.5 14.5l-3.6 3.6"/></>,
  "linked": <><circle cx="6.2" cy="7" r="2.4"/><circle cx="17.8" cy="7" r="2.4"/><circle cx="12" cy="17.4" r="2.4"/><path d="M8.6 7h6.8M7.4 9.1l3.4 6.2M16.6 9.1l-3.4 6.2"/></>,
  "mail": <><rect x="3.6" y="5.6" width="16.8" height="12.8" rx="2.2"/><path d="m4.4 7.2 7.6 5.8 7.6-5.8"/></>,
  "map": <><path d="M3.8 6.6 9 4.4l6 2.2 5.2-2.2v13L15 19.6l-6-2.2-5.2 2.2z"/><path d="M9 4.4v13M15 6.6v13"/></>,
  "megaphone": <><path d="M4.4 10.2v3.6a1.4 1.4 0 0 0 1.4 1.4h2.4l7.6 3.9V4.9L8.2 8.8H5.8a1.4 1.4 0 0 0-1.4 1.4z"/><path d="M18.6 9.4a3.6 3.6 0 0 1 0 5.2M8.4 15.4l1 4h2.3"/></>,
  "memberships": <><circle cx="8.8" cy="12" r="5.6"/><circle cx="15.2" cy="12" r="5.6"/><circle cx="12" cy="10.4" r="1.3"/><path d="M10.3 14.4c.4-.9 1-1.3 1.7-1.3s1.3.4 1.7 1.3"/></>,
  "menu": <><path d="M4.2 7h15.6M4.2 12h15.6M4.2 17h15.6"/></>,
  "messages": <><path d="M4.2 6.4a2 2 0 0 1 2-2h11.6a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2h-6.3L7.4 20v-3.4H6.2a2 2 0 0 1-2-2z"/><path d="M8.2 9h7.6M8.2 12.2h4.6"/></>,
  "open": <><circle cx="12" cy="12" r="8.6"/><path d="m8.4 12.3 2.4 2.4 4.8-5.2"/></>,
  "person-clock": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4.9 0 1.7.2 2.5.5"/><circle cx="17" cy="16.4" r="3.8"/><path d="M17 14.6v1.9l1.3.9"/></>,
  "person-gear": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4 1.2 0 2.3.3 3.2.9"/><circle cx="17.2" cy="16.6" r="1.8"/><path d="M17.2 12.8v1.1M17.2 19.3v1.1M13.4 16.6h1.1M19.9 16.6H21M14.5 13.9l.8.8M19.1 18.5l.8.8M14.5 19.3l.8-.8M19.1 14.7l.8-.8"/></>,
  "person-plus": <><circle cx="9.4" cy="8.4" r="3.4"/><path d="M3.6 19.6c.5-3.4 2.8-5.4 5.8-5.4s5.3 2 5.8 5.4"/><path d="M18.4 7.4v5.2M15.8 10h5.2"/></>,
  "plug": <><path d="M9 3.8V8M15 3.8V8M6.6 8h10.8v3.2a5.4 5.4 0 0 1-10.8 0z"/><path d="M12 16.6v3.6"/></>,
  "poll": <><path d="M4.4 4.8v14.4"/><path d="M4.4 7.6h9.4M4.4 12h14.2M4.4 16.4h6.4"/></>,
  "pulse": <><path d="M3.4 12.4h3.7l2.3-6.2 4.3 12 2.4-5.8h4.5"/></>,
  "question": <><circle cx="12" cy="12" r="8.6"/><path d="M9.6 9.6a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17.1h.01"/></>,
  "receipt": <><path d="M6 3.6h12v16.8l-2.4-1.6-2.4 1.6-2.4-1.6-2.4 1.6-2.4-1.6z"/><path d="M9 8.4h6M9 12h6M9 15.6h3.4"/></>,
  "replay": <><path d="M19.6 12a7.6 7.6 0 1 1-2.4-5.5"/><path d="M19.8 4.7v3.9h-3.9"/></>,
  "rights": <><path d="M12 3.6 5 6.3v5.2c0 4.3 2.9 7.4 7 8.9 4.1-1.5 7-4.6 7-8.9V6.3z"/><path d="m9.1 12 2 2 3.8-4.1"/></>,
  "robot": <><rect x="4.6" y="8.4" width="14.8" height="10.8" rx="3"/><path d="M12 8.4V5.2M9.4 13h.01M14.6 13h.01M9.6 16.2h4.8"/><circle cx="12" cy="4.2" r="1"/></>,
  "seal-check": <><path d="M12 3.4l2.68 2.13 3.4.39.39 3.4L20.6 12l-2.13 2.68-.39 3.4-3.4.39L12 20.6l-2.68-2.13-3.4-.39-.39-3.4L3.4 12l2.13-2.68.39-3.4 3.4-.39z"/><path d="m9.2 12.2 2 2 3.8-4.1"/></>,
  "seal-stack": <><path d="M12 3.2l1.88 1.47 2.36.29.29 2.36L18 9.2l-1.47 1.88-.29 2.36-2.36.29L12 15.2l-1.88-1.47-2.36-.29-.29-2.36L6 9.2l1.47-1.88.29-2.36 2.36-.29z"/><path d="m4.6 15.4 7.4 3.8 7.4-3.8"/></>,
  "search": <><circle cx="11" cy="11" r="6.4"/><path d="m15.8 15.8 4 4"/></>,
  "settings": <><path d="M4.4 7.4h9.2M17.6 7.4h2M4.4 16.6h2M10.4 16.6h9.2"/><circle cx="15.6" cy="7.4" r="2"/><circle cx="8.4" cy="16.6" r="2"/></>,
  "signin": <><path d="M13.5 4.4h4a2 2 0 0 1 2 2v11.2a2 2 0 0 1-2 2h-4"/><path d="M4.5 12h10.2"/><path d="m11 8.2 3.8 3.8L11 15.8"/></>,
  "star": <><path d="M12 3.7l2.5 5.1 5.7.85-4.1 4 .97 5.65L12 16.6l-5.07 2.7.97-5.65-4.1-4 5.7-.85z"/></>,
  "star-lines": <><path d="M8.6 4.2l1.35 3.54 3.79.19-2.95 2.38.98 3.66-3.17-2.07-3.17 2.07.98-3.66-2.95-2.38 3.79-.19z"/><path d="M16 7.4h4M16 11h4M4.2 17.6h15.8"/></>,
  "tasks": <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.4 12.2 2.4 2.4 4.9-5.2"/></>,
  "thumb": <><path d="M7.6 10.6H4.6v9.2h3z"/><path d="M7.6 10.6 11 4.2c1.3 0 2.2 1 2 2.3l-.6 3.4h5.1a2 2 0 0 1 2 2.3l-1.1 5.9a2 2 0 0 1-2 1.7H7.6z"/></>,
  "upload": <><path d="M6.4 3.8h7.4l4.4 4.4v10a2 2 0 0 1-2 2H6.4a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2z"/><path d="M13.6 3.8v4.6h4.6"/><path d="M11.3 17.2v-6.4M8.6 13.4l2.7-2.7 2.7 2.7"/></>,
  "vote": <><path d="M4.4 13.2h15.2v5.4a1.6 1.6 0 0 1-1.6 1.6H6a1.6 1.6 0 0 1-1.6-1.6z"/><path d="m8 13.2 1.4-8h5.2l1.4 8"/><path d="m10.4 8.8 1.3 1.3 2.2-2.4"/></>,
  "wallet": <><path d="M4.2 8.8V7.4a2 2 0 0 1 2-2h10.6v3.4"/><rect x="4.2" y="8.8" width="15.6" height="10.4" rx="2.2"/><path d="M15.6 14h.01"/></>,
  "week": <><rect x="3.8" y="5.2" width="16.4" height="15" rx="2.6"/><path d="M3.8 9.9h16.4M8.2 3.4v3.5M15.8 3.4v3.5M7.6 14.9h8.8"/></>,
};

// One icon per nav item key. Different keys may share an icon only when they
// never appear on the same rail (for example "requests", the admin and VP
// Requests page, and "cases", the member's My cases). The desk rows (steward,
// coordinator, advisor, admin, vp) are listed in the Desks group of every rail
// on the live site, so their icons are used by no other row.
export const RAIL_ICON_FOR = {
  // rows outside the item lists
  compass: "compass", "command-palette": "command",
  // member rail
  today: "home", voting: "vote", rewards: "star", cases: "cases", forms: "form", voice: "megaphone",
  workload: "clock", numbers: "chart", pulse: "pulse", rights: "rights", "org-structure": "layers",
  network: "globe", card: "card", search: "search", "site-guide": "question", accessHistory: "history",
  settings: "settings", work: "grid", organize: "thumb",
  // phone-directory pages a member can pin to the rail
  appointments: "calendar", events: "calendar-check", qa: "bulb",
  // shared workspace rows
  messages: "messages", requests: "cases", hub: "hand", "events-desk": "calendar-check", campaigns: "megaphone",
  coordination: "linked", "member-support": "lifering", analytics: "chart", "organization-map": "map",
  actions: "fist", clauses: "contract", civic: "civic", "qa-queue": "question", integrations: "plug",
  dues: "receipt", pay: "wallet", automations: "robot", tasks: "tasks",
  // steward
  steward: "desk-steward", "steward-caseload": "folder", "steward-requests": "chapters", "steward-appointments": "calendar",
  "steward-forms": "form", "steward-messages": "mail", "steward-checkins": "signin", "steward-broadcasts": "bell",
  "steward-qa": "bulb", "steward-email-intake": "inbox", "steward-workload": "clock", "steward-casework-hub": "grid",
  // coordinator
  coordinator: "desk-coordinator", "coordinator-cases": "cases", "coordinator-deadlines": "clock", "coordinator-funnel": "funnel",
  "coordinator-articles": "poll", "coordinator-appointments": "calendar", "coordinator-settings": "settings",
  "coordinator-macros": "copy", "coordinator-casework-hub": "grid",
  // advisor
  advisor: "desk-advisor", "advisor-workload": "clock", "advisor-turnout": "poll", "advisor-risks": "bell",
  "advisor-leadership": "chapters", "advisor-appointments": "calendar",
  // admin: the owner's choice page, except its desk row, Set up your organization (the Member desk row has home) and the shared Dues
  admin: "desk-admin", "admin-access": "chapters", "admin-mfa": "signin", "admin-events": "calendar-check",
  "admin-form-templates": "form", "admin-rewards": "star", "admin-audit": "history", "admin-organization-audit": "poll",
  "admin-job-health": "pulse", "admin-member-directory": "search", "admin-organization": "layers",
  "admin-chapter-handshake": "globe", "admin-handshake-documents": "copy", "admin-chapter-memberships": "memberships",
  "admin-configuration": "settings", "admin-labels": "menu", "admin-failed-logins": "bell", "admin-lifecycle": "replay",
  "admin-invitations": "person-plus", "admin-roster-import": "upload", "admin-signin-recovery": "key",
  "admin-governance": "rights", "admin-compass-governance": "compass-shield", "admin-evidence-operations": "folder",
  "admin-member-operations": "person-gear", "admin-retention-engine": "clock", "admin-leadership-reviews": "open",
  "admin-reward-economy": "star-lines", "admin-appointments": "calendar", "admin-setup-review": "checklist",
  "admin-catalog-verification": "seal-check", "admin-catalog-vouch": "thumb", "admin-catalog-verifier": "seal-stack",
  "admin-people-waiting": "person-clock",
  // vp
  vp: "desk-vp", "vp-trend": "pulse", "vp-attention": "bell", "vp-leadership": "chapters", "vp-priorities": "star",
  "vp-events": "week", "vp-invitations": "person-plus", "vp-member-directory": "search",
  // Palette commands without an ordinary rail row.
  "find-steward": "chapters", "support-handoffs": "chev-right",
  "coordination-mobilize": "compass", "campaigns-polls": "vote",
  "attention:attention": "search", "attention:actions": "open", "attention:risk": "rights",
};

export function railIconName(key) {
  return Object.hasOwn(RAIL_ICON_FOR, key) ? RAIL_ICON_FOR[key] : null;
}

export function RailIcon({ name, size = 17 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-rail-icon={name}>
      {RAIL_ICON_SHAPES[name]}
    </svg>
  );
}
