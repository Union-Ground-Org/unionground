// Configurable thresholds (REQ-UG-CONFIGURABLE-THRESHOLDS-20261001).
//
// Every value is an organization setting registered by
// supabase/migrations/20261002017000_feature_switches_and_limits.sql and read
// through the member-safe switches map. Defaults are the old app's effective
// production values; a malformed or misordered configuration degrades the way
// the old parsers did (per-field fallback, then clamped monotonic) so a closer
// deadline or a lower score can never grade less severe than a farther one.
import { featureLimit, featureTextList } from "./featureSwitches.js";

export const DEADLINE_SETTING_KEYS = Object.freeze({
  red: "limits.casework.deadline_red_days",
  amber: "limits.casework.deadline_amber_days",
  critical: "limits.casework.deadline_risk_critical_days",
  high: "limits.casework.deadline_risk_high_days",
  medium: "limits.casework.deadline_risk_medium_days",
  lookahead: "limits.casework.deadline_lookahead_days",
});

// Old lib/grievances/deadlines-server.ts:10-11 (red 5, amber 14) and
// lib/crm/deadline-risk-thresholds.ts DEFAULT_DEADLINE_RISK_THRESHOLDS
// (critical 0, high 7, medium 14), dashboard_lookahead_days 7.
export const DEFAULT_DEADLINE_COLORS = Object.freeze({ red: 5, amber: 14 });
export const DEFAULT_DEADLINE_RISK = Object.freeze({ critical: 0, high: 7, medium: 14 });
export const DEFAULT_DEADLINE_LOOKAHEAD = 7;
export const MAX_DEADLINE_LOOKAHEAD = 30;

export const HEALTH_SETTING_KEYS = Object.freeze({
  criticalMax: "limits.analytics.health_critical_max",
  concerningMax: "limits.analytics.health_concerning_max",
  moderateMax: "limits.analytics.health_moderate_max",
  healthyMax: "limits.analytics.health_healthy_max",
});
// Old supabase/migrations/0024_tier1_polish.sql:56-59 (five tiers).
export const DEFAULT_HEALTH_BANDS = Object.freeze({ criticalMax: 24, concerningMax: 44, moderateMax: 64, healthyMax: 84 });
export const HEALTH_BANDS = Object.freeze(["critical", "concerning", "moderate", "healthy", "excellent"]);

export const MANAGEMENT_CATEGORY_KEY = "lists.casework.management_behavior_categories";
export const MANAGEMENT_WINDOW_KEY = "limits.casework.management_behavior_window_days";
// Old supabase/migrations/0022_features_all.sql:456 and 0024_tier1_polish.sql:51.
// "Weingarten denial" stays as a STORED value so existing entries and the
// shared database default keep matching (owner decision on PR #8). Workers
// never read it: its catalogue label is organizing language ("Denied right to
// act together"), because Weingarten rights belong to a recognized union.
// "Retaliation" stays as it is: it is central to organizing.
export const DEFAULT_MANAGEMENT_CATEGORIES = Object.freeze([
  "Verbal threat", "Intimidation", "Policy change (unilateral)", "Weingarten denial",
  "Retaliation", "Discrimination", "Other",
]);
export const DEFAULT_MANAGEMENT_WINDOW_DAYS = 90;

function days(configuration, key, fallback, min = 0, max = 3650) {
  const value = featureLimit(configuration, key, fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function deadlineColorThresholds(configuration) {
  const red = days(configuration, DEADLINE_SETTING_KEYS.red, DEFAULT_DEADLINE_COLORS.red);
  const amber = Math.max(days(configuration, DEADLINE_SETTING_KEYS.amber, DEFAULT_DEADLINE_COLORS.amber), red);
  return { red, amber };
}

export function deadlineRiskThresholds(configuration) {
  const critical = days(configuration, DEADLINE_SETTING_KEYS.critical, DEFAULT_DEADLINE_RISK.critical);
  const high = Math.max(days(configuration, DEADLINE_SETTING_KEYS.high, DEFAULT_DEADLINE_RISK.high), critical);
  const medium = Math.max(days(configuration, DEADLINE_SETTING_KEYS.medium, DEFAULT_DEADLINE_RISK.medium), high);
  return { critical, high, medium };
}

export function deadlineLookaheadDays(configuration) {
  return days(configuration, DEADLINE_SETTING_KEYS.lookahead, DEFAULT_DEADLINE_LOOKAHEAD, 1, MAX_DEADLINE_LOOKAHEAD);
}

// Old lib/grievances/deadlines.ts tierFor: overdue, then red, amber, green.
export function deadlineColorTier(daysRemaining, thresholds = DEFAULT_DEADLINE_COLORS) {
  if (!Number.isFinite(daysRemaining)) return null;
  if (daysRemaining < 0) return "overdue";
  if (daysRemaining <= thresholds.red) return "red";
  if (daysRemaining <= thresholds.amber) return "amber";
  return "green";
}

// Old lib/crm/deadline-risk-thresholds.ts deadlineRiskSeverity: overdue is
// always critical because every window includes everything below it.
export function deadlineRiskSeverity(daysRemaining, thresholds = DEFAULT_DEADLINE_RISK) {
  if (!Number.isFinite(daysRemaining)) return null;
  if (daysRemaining <= thresholds.critical) return "critical";
  if (daysRemaining <= thresholds.high) return "high";
  if (daysRemaining <= thresholds.medium) return "medium";
  return "low";
}

export function healthBandThresholds(configuration) {
  const criticalMax = days(configuration, HEALTH_SETTING_KEYS.criticalMax, DEFAULT_HEALTH_BANDS.criticalMax, 0, 100);
  const concerningMax = Math.max(days(configuration, HEALTH_SETTING_KEYS.concerningMax, DEFAULT_HEALTH_BANDS.concerningMax, 0, 100), criticalMax);
  const moderateMax = Math.max(days(configuration, HEALTH_SETTING_KEYS.moderateMax, DEFAULT_HEALTH_BANDS.moderateMax, 0, 100), concerningMax);
  const healthyMax = Math.max(days(configuration, HEALTH_SETTING_KEYS.healthyMax, DEFAULT_HEALTH_BANDS.healthyMax, 0, 100), moderateMax);
  return { criticalMax, concerningMax, moderateMax, healthyMax };
}

// Old app/dashboard/report-card/score-dial.tsx tierFor.
export function healthBand(score, thresholds = DEFAULT_HEALTH_BANDS) {
  if (!Number.isFinite(score)) return "not_ready";
  if (score <= thresholds.criticalMax) return "critical";
  if (score <= thresholds.concerningMax) return "concerning";
  if (score <= thresholds.moderateMax) return "moderate";
  if (score <= thresholds.healthyMax) return "healthy";
  return "excellent";
}

export function managementBehaviorCategories(configuration) {
  const list = featureTextList(configuration, MANAGEMENT_CATEGORY_KEY, DEFAULT_MANAGEMENT_CATEGORIES);
  return list.length ? list : [...DEFAULT_MANAGEMENT_CATEGORIES];
}

export function managementBehaviorWindowDays(configuration) {
  return days(configuration, MANAGEMENT_WINDOW_KEY, DEFAULT_MANAGEMENT_WINDOW_DAYS, 1, 3650);
}

// Category values are stored as entered. The original six tokens and the old
// default list have catalogue translations; anything an admin typed shows as
// typed.
export function managementCategoryMessageKey(category) {
  const slug = String(category ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug ? `casework.tools.category.${slug}` : null;
}
