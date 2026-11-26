import { vi } from "vitest";

export const ok = (value) => Promise.resolve({ ok: true, value });
export const ORG = { org_id: "wor", org_name: "Worcester", role: "member" };
export const ADDRESS = { full_name: "Jo Member", line1: "100 Fictional Way", line2: "Apt 3", city: "Example Borough", state: "PA",
  postal_code: "00000", civic_lookup_status: "resolved" };
export const REP = { user_id: "u", ocd_id: "ocd/pa/cd:1", district_level: "federal", state: "PA", district_number: "1",
  office: "U.S. Representative", full_name: "Morgan Pinebridge", party: "Republican", phone: "202-555-0101",
  contact_form_url: "https://representative.example.invalid/contact", website: "https://representative.example.invalid", email: null,
  level_rank: 2, resolution_stale: false, official_key: "bioguide:X000001", term_end: "2027-01-03" };
export const SENATOR = { ...REP, ocd_id: "ocd/pa", district_number: null, office: "U.S. Senator", full_name: "Jordan Cloudmere",
  party: "Democrat", official_key: "bioguide:X000002", level_rank: 1, contact_form_url: "https://senator.example.invalid/contact" };
export const STATE_REP = { ...REP, ocd_id: "ocd/pa/sldl:29", district_level: "state_lower", district_number: "29",
  office: "State Representative", full_name: "Avery Juniperfield", official_key: "openstates:ocd-person/11111111-2222-3333-4444-555555555555",
  email: "state-representative@example.invalid", contact_form_url: null, level_rank: 4 };
export const STATE_SENATOR = { ...STATE_REP, ocd_id: "ocd/pa/sldu:10", district_level: "state_upper", district_number: "10", office: "State Senator",
  full_name: "Taylor Alderwick", official_key: "openstates:ocd-person/91f290d0-3405-4091-bb16-822a97f45af5", email: "state-senator@example.invalid", level_rank: 3 };
const exec = (office, full_name, id) => ({ ...SENATOR, district_level: "state", office, full_name, party: "Democratic", level_rank: 5, email: null,
  contact_form_url: null, website: "https://executive.example.invalid", phone: "717-555-0102", official_key: `openstates:ocd-person/${id}` });
export const GOVERNOR = exec("Governor", "Riley Fernhaven", "ac7497c7-0a0d-495f-98ce-75dedbfeb0c7");
export const ATTORNEY_GENERAL = exec("Attorney General", "Casey Willowfen", "d880fd50-7249-4f5d-b7d4-193a4ae8319e");
export const LT_GOVERNOR = exec("Lieutenant Governor", "Cameron Birchmere", "e5de67f9-3e82-4e65-89ce-47aa0772d1f8");
export const MAYOR = { ...REP, ocd_id: "local:j1", district_level: "local", district_name: "Doylestown Borough", district_number: null, office: "Mayor",
  full_name: "Robin Cedarfall", party: null, email: "mayor@example.invalid", contact_form_url: null, website: "https://borough.example.invalid/",
  phone: "(215) 555-0103", level_rank: 6, official_key: "local:11111111-2222-4333-8444-555555555555", term_end: null, match_exact: false,
  external_ids: { local: "11111111-2222-4333-8444-555555555555", jurisdiction: "j1" } };
export const PLACES = [
  { geoid: "4219784", kind: "place", name: "Doylestown borough", state: "PA", members: 12, entered_by: null, officials: 0, own_jurisdiction_id: null },
  { geoid: "42017", kind: "county", name: "Bucks County", state: "PA", members: 40, entered_by: "Local 1", officials: 3, own_jurisdiction_id: null },
  { geoid: "4205310", kind: "school_district", name: "Central Bucks School District", state: "PA", members: null, entered_by: null, officials: 0, own_jurisdiction_id: null },
];
export const CAMPAIGN = { id: "e1000000-0000-4000-8000-000000000001", org_id: ORG.org_id, title: "Safe staffing now", topic: "Safe staffing ratios",
  summary: "Minimum nurse-to-patient ratios.", talking_points: ["One.", "Two."], bill_key: "us/119/hr/2530", union_position: "support",
  target_offices: [], status: "active" };

export function fakeApi(over = {}) {
  const api = {
    getAddress: vi.fn(() => ok(ADDRESS)), saveAddress: vi.fn(() => ok({ civic_lookup_status: "needs_lookup" })),
    withdrawAddress: vi.fn(() => ok(null)), getQuarantine: vi.fn(() => ok(null)),
    listMyOfficials: vi.fn(() => ok([SENATOR, REP, STATE_REP])), listAllOfficials: vi.fn(() => ok([])),
    listMyOrgs: vi.fn(() => ok([ORG])), listCampaigns: vi.fn(() => ok([CAMPAIGN])),
    saveCampaign: vi.fn((campaign) => ok({ ...campaign, id: campaign.id || "new" })), deleteCampaign: vi.fn(() => ok(null)),
    campaignStats: vi.fn(() => ok([])), listBills: vi.fn(() => ok([{ bill_key: "us/119/hr/2530", jurisdiction: "us", session: "119", source: "govinfo_billstatus", identifier: "H.R. 2530", title: "Nurse Staffing Standards Act", status: "introduced" }])),
    listBillStates: vi.fn(() => ok(["pa"])),
    listMyMessages: vi.fn(() => ok([])), saveMessage: vi.fn((message) => ok({ id: message.id || "m1", status: message.status, sent_at: message.sent_at })),
    deleteMessage: vi.fn(() => ok(null)), listOutcomes: vi.fn(() => ok([])), listMyOfficialRatings: vi.fn(() => ok([])),
    listOrgRatings: vi.fn(() => ok([])), listAlignment: vi.fn(() => ok([])), listVotesForOfficial: vi.fn(() => ok([])),
    listLocalJurisdictions: vi.fn(() => ok([])), saveJurisdiction: vi.fn(() => ok({ id: "j1" })), deleteJurisdiction: vi.fn(() => ok(null)),
    saveLocalOfficial: vi.fn(() => ok({ id: "lo1" })), deleteLocalOfficial: vi.fn(() => ok(null)),
    listMemberPlaces: vi.fn(() => ok([])), markJurisdictionReviewed: vi.fn(() => ok(null)), flagLocal: vi.fn(() => ok({ id: "f1" })),
    listMyFlags: vi.fn(() => ok([])), listLocalFlags: vi.fn(() => ok([])), resolveLocalFlag: vi.fn(() => ok(null)),
    saveRating: vi.fn(() => ok({ id: "r1" })), deleteRating: vi.fn(() => ok(null)),
    ...over,
  };
  return api;
}
