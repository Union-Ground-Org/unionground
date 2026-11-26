import { ANALYTICS_CORRELATION_STRENGTH, analyticsAnonymityFloor } from "./contract.js";
import { keepOrganizationRows, protectedCohort, roundRate } from "./privacy.js";

export function pearsonCorrelation(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 2) {
    return null;
  }
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < n; index += 1) {
    if (!Number.isFinite(xs[index]) || !Number.isFinite(ys[index])) return null;
    sumX += xs[index];
    sumY += ys[index];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    numerator += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denominator = Math.sqrt(dx2 * dy2);
  if (denominator === 0) return 0;
  return roundRate(numerator / denominator, 3);
}

const SERIES_PAIRS = [
  {
    id: "attendance_vs_cases",
    x: "attendanceRate",
    y: "openCases",
    title: "Attendance and open issues",
    negative: "Campaigns with lower attendance also carry more open issues.",
    positive: "Campaigns with higher attendance also carry more open issues.",
  },
  {
    id: "engagement_vs_attendance",
    x: "engagementMean",
    y: "attendanceRate",
    title: "Engagement and attendance",
    negative: "Higher engagement scores are not lining up with attendance.",
    positive: "Higher engagement scores travel with higher attendance.",
  },
  {
    id: "usage_vs_engagement",
    x: "usageViews",
    y: "engagementMean",
    title: "Portal use and engagement",
    negative: "Portal use is rising where engagement scores are lower.",
    positive: "Portal use and engagement scores move together.",
  },
];

function insightSeverity(r) {
  if (r <= -0.7) return "warning";
  if (r >= 0.7) return "info";
  return "info";
}

export function buildCorrelationInsights(snapshot = {}, viewer = {}) {
  const organizationId = viewer.organizationId;
  const floor = analyticsAnonymityFloor(snapshot.privacyThreshold);
  const series = keepOrganizationRows(snapshot.series, organizationId);

  if (series.length < floor) {
    return {
      ...protectedCohort("anonymity_floor", floor),
      findings: [],
    };
  }

  const findings = [];
  for (const pair of SERIES_PAIRS) {
    const xs = series.map((row) => row[pair.x]);
    const ys = series.map((row) => row[pair.y]);
    const r = pearsonCorrelation(xs, ys);
    if (r == null || Math.abs(r) < ANALYTICS_CORRELATION_STRENGTH) continue;
    findings.push({
      id: pair.id,
      title: pair.title,
      description: r < 0 ? pair.negative : pair.positive,
      r,
      n: series.length,
      severity: insightSeverity(r),
    });
  }

  return {
    enoughData: true,
    reason: null,
    minCohort: floor,
    findings,
  };
}
