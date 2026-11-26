import { defaultWorkloadDefinition } from "../../src/lib/workloadConfiguration.js";

const base = () => defaultWorkloadDefinition().fields.map((f) => ({ ...f, visible: ["workedOn", "hoursWorked"].includes(f.key) }));
const field = (key, label, type, extra = {}) => ({ key, label, type, kind: "field", visible: true, required: true, retired: false, unit: "", summary: "none", options: [], ...extra });

export function largeWorkloadDefinition() {
  const definition = defaultWorkloadDefinition();
  for (let n = 1; n <= 10; n += 1) definition.fields.push(field(`custom_${n}`, `Choice ${n}`, "select", {
    options: Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(58)}`),
  }));
  return definition;
}

// Fictional organizations only. These fixtures create no hosted tenant.
export function fictionalWorkloadConfigurations() {
  return [
    { name: "test-fernbridge-library", definition: { title: "Library service log", period: "week", statuses: ["draft", "complete"], fields: [
      ...base(), field("visits", "Patron visits", "number", { kind: "category", unit: "visits", summary: "sum" }),
      field("shift", "Shift", "select", { options: ["morning", "evening"] }),
    ] } },
    { name: "test-willowmere-parks", definition: { title: "Park maintenance log", period: "quarter", statuses: ["scheduled", "done"], fields: [
      ...base(), field("distance", "Route distance", "number", { kind: "category", unit: "km", summary: "average" }),
      field("equipmentChecked", "Equipment checked", "boolean"),
      field("location", "Park area", "text"),
    ] } },
  ];
}
