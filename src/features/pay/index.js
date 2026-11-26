import {
  createMemoryPayCatalog,
  createPayCatalogFromRpcPayload,
  createPayRpcAdapter,
  PAY_PERSISTENCE_CONTRACT,
} from "./adapter.js";
import { authorizePay, PAY_AUDIT_METADATA_KEYS, PAY_CAPABILITIES, PAY_WRITE_ROLES } from "./authorization.js";
import { calculatePay } from "./calculator.js";
import { compareCatalogYearOverYear, comparePayScaleRecords, queryPayScale } from "./catalog.js";
import { PAY_FAILURE_REASONS } from "./errors.js";
import { presentCalculation, presentCatalog, presentComparison, presentLoading, presentRetry, PAY_VIEW_STATES } from "./presenters.js";
import { PAY_DONOR_BASELINE, PAY_DONOR_UNITS } from "./provenance.js";
import { CALCULATION_RULE_FIELDS, UNSET_CALCULATION_RULES } from "./rules.js";

export {
  CALCULATION_RULE_FIELDS,
  PAY_AUDIT_METADATA_KEYS,
  PAY_CAPABILITIES,
  PAY_DONOR_BASELINE,
  PAY_DONOR_UNITS,
  PAY_FAILURE_REASONS,
  PAY_PERSISTENCE_CONTRACT,
  PAY_VIEW_STATES,
  PAY_WRITE_ROLES,
  authorizePay,
  calculatePay,
  compareCatalogYearOverYear,
  comparePayScaleRecords,
  createMemoryPayCatalog,
  createPayCatalogFromRpcPayload,
  createPayRpcAdapter,
  presentCalculation,
  presentCatalog,
  presentComparison,
  presentLoading,
  presentRetry,
  queryPayScale,
  UNSET_CALCULATION_RULES,
};

export function createPayTools({ actor, catalog = createMemoryPayCatalog() }) {
  const organizationId = actor?.selectedOrganizationId ?? null;

  return {
    catalog,
    persistence: PAY_PERSISTENCE_CONTRACT,
    calculate(input, rules) {
      return calculatePay({ actor, catalog, organizationId, input, rules });
    },
    query(filters) {
      return queryPayScale({ actor, catalog, organizationId, filters });
    },
    compare(left, right, rules) {
      return comparePayScaleRecords({ actor, catalog, organizationId, left, right, rules });
    },
    compareYears({ grade, stepNumber, fromYear, toYear, rules }) {
      return compareCatalogYearOverYear({
        actor,
        catalog,
        organizationId,
        grade,
        stepNumber,
        fromYear,
        toYear,
        rules,
      });
    },
    presentCalculator(input, rules) {
      return presentCalculation(calculatePay({ actor, catalog, organizationId, input, rules }));
    },
    presentTables(filters) {
      return presentCatalog(queryPayScale({ actor, catalog, organizationId, filters }));
    },
    presentCompare(left, right, rules) {
      return presentComparison(comparePayScaleRecords({
        actor,
        catalog,
        organizationId,
        left,
        right,
        rules,
      }));
    },
    authorize(capability) {
      return authorizePay({ actor, organizationId, capability });
    },
    auditKeys: PAY_AUDIT_METADATA_KEYS,
    capabilities: PAY_CAPABILITIES,
  };
}
