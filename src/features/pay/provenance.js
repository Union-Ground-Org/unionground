export const PAY_DONOR_BASELINE = "donor-baseline-20260721";

export const PAY_DONOR_UNITS = Object.freeze([
  {
    auditId: "CR-045",
    disposition: "reuse_direct",
    donorPath: "lib/util/wage-calculator.ts",
    destination: "src/features/pay/calculator.js",
    adapted: "Night, weekend, overtime, and standby formula skeleton; integer-cent math; first-class underpayment and raise retro.",
    rejected: [
      "placeholder G1/G2/G3 base rates",
      "placeholder S1-S5 multipliers as product defaults",
      "new Date() effective_date",
      "hardcoded contract_year 2024",
    ],
  },
  {
    auditId: "CR-045",
    disposition: "port_adapt",
    donorPath: "lib/schemas/wage.ts",
    destination: "src/features/pay/rules.js",
    adapted: "Grade/step/rate input validation without Zod or Next.js query parsing.",
    rejected: ["Next.js searchParams", "URL-crafted grade/step as the only input"],
  },
  {
    auditId: "CR-045",
    disposition: "spec_only",
    donorPath: "app/dashboard/wage-calculator/page.tsx",
    destination: "src/features/pay/presenters.js",
    adapted: "Member-facing calculator states and honest back-pay results.",
    rejected: [
      "requireMember Next.js guard",
      "unrecovered-earnings marketing copy as a product default",
      "rate-card-only UI that never computed back pay",
    ],
  },
  {
    auditId: "CR-045",
    disposition: "discard",
    donorPath: "app/api/rates/route.ts",
    destination: null,
    adapted: null,
    rejected: [
      "Next.js route handler",
      "CSRF/origin cookie boundary",
      "1h cache of placeholder rates",
    ],
  },
  {
    auditId: "CR-046",
    disposition: "port_adapt",
    donorPath: "supabase/migrations/0304_metrics_schema.sql",
    destination: "src/features/pay/catalog.js",
    adapted: "Grade × step × effective-date catalog, explicit as-of lookup, and query/comparison views with entered annualization rules.",
    rejected: [
      "donor migration replay",
      "global grade primary key",
      "anon+authenticated using(true) read-all",
      "organization-less pay_scale tables",
      "2087-hour and 26-check product defaults",
    ],
  },
  {
    auditId: "CR-046",
    disposition: "discard",
    donorPath: "supabase/migrations/0311_seed_pay_scales.sql",
    destination: null,
    adapted: null,
    rejected: [
      "the donor's real-union bargaining-unit pay-scale seed",
      "Commonwealth bi-weekly rates as live defaults",
      "any fictional or real-organization pay-scale seed",
    ],
  },
  {
    auditId: "CR-046",
    disposition: "discard",
    donorPath: "lib/claude/tools/data-tools.ts",
    destination: null,
    adapted: null,
    rejected: [
      "unscoped service-role get_pay_scale",
      "single-agency tool description",
      "trusted-data client in the browser/agent path",
    ],
  },
]);
