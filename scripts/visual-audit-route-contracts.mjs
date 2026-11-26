const ROUTE_CONTRACTS = Object.freeze({
  "/m": Object.freeze({ hat: "member", hatLabel: "Member", landmark: ".screen.screen--today.home" }),
  "/m/events": Object.freeze({ hat: "member", hatLabel: "Member", landmark: ".screen.mevents" }),
  // Reports sit behind the quarterly survey gate ("give to view"). A member who
  // has not answered this quarter's survey sees the gate's banner instead of
  // the page, and that is a correct render. A failed gate read is not.
  "/m/numbers": Object.freeze({ hat: "member", hatLabel: "Member", landmark: '.screen.screen--reports, .qsg-banner[data-quarterly-gate="locked"]' }),
  "/m/voice": Object.freeze({ hat: "member", hatLabel: "Member", landmark: ".screen.bevoice-screen" }),
  "/m/rights": Object.freeze({ hat: "member", hatLabel: "Member", landmark: ".screen.learn-screen" }),
  "/m/messages": Object.freeze({ hat: "member", hatLabel: "Member", landmark: ".screen.inbox-screen" }),
  "/m/cases": Object.freeze({ hat: "member", hatLabel: "Member", landmark: ".screen.mcases" }),
  "/m/tasks": Object.freeze({ hat: "coordinator", hatLabel: "Coordinator", landmark: ".screen.tasks-screen" }),
});

export const DEFAULT_VISUAL_AUDIT_ROUTES = Object.freeze(Object.keys(ROUTE_CONTRACTS));

export function visualAuditRouteContract(route) {
  const contract = ROUTE_CONTRACTS[route];
  return contract ? { route, ...contract } : null;
}
