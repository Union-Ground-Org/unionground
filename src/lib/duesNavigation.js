// Union Ground runs no dues: dues need a union that already exists, so the
// dues screens are left out of this edition. The navigation lists still carry
// a Dues key in places shared with the upstream code; this rule removes it
// everywhere by answering "runs no dues" for every organization, with no read.
// No React here: the native app imports this file (apps/mobile).
export async function loadOrganizationRunsDues() {
  return false;
}

// A definite "runs no dues" removes the entry; Union Ground's answer is always false.
export function withoutDuesNav(items, runsDues = false) {
  return runsDues === false ? items.filter((item) => item?.key !== "dues") : items;
}
