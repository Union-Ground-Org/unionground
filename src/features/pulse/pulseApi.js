// The website's Pulse reads and writes: the same RPCs the app calls
// (apps/mobile/src/services/savedPulseCharts.ts). Every figure comes from
// preview_pulse_chart or read_pulse_chart, which apply the floor server-side;
// a failed read is an error, never an empty chart.
import { pulseChartFigures, pulseChartOptions, savedPulseCharts } from "./pulseCharts.js";

export class PulseReadError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "PulseReadError";
    this.cause = cause;
  }
}

export function createPulseApi(client) {
  // Each call site names its RPC literally, so the read-RPC drift guard can
  // match every website read against the database.
  async function settle(request) {
    if (!client || typeof client.rpc !== "function") throw new PulseReadError("Pulse is not connected.");
    let result;
    try {
      result = await request();
    } catch (error) {
      throw new PulseReadError("Pulse could not be verified.", error);
    }
    if (result?.error) throw new PulseReadError("Pulse could not be verified.", result.error);
    return result?.data;
  }
  return {
    async options(hat) {
      return pulseChartOptions(await settle(() => client.rpc("pulse_chart_options", { p_hat: hat })));
    },
    async preview(hat, spec) {
      return pulseChartFigures(await settle(() => client.rpc("preview_pulse_chart", { p_spec: spec, p_hat: hat })), spec);
    },
    async list(hat) {
      return savedPulseCharts(await settle(() => client.rpc("list_pulse_charts", { p_hat: hat })));
    },
    async save(hat, chart) {
      return settle(() => client.rpc("save_pulse_chart", {
        p_id: chart.id ?? null,
        p_title: chart.title,
        p_spec: chart.spec,
        p_scope: chart.scope,
        p_pinned: chart.pinned === true,
        p_home: chart.pinned === true && chart.home === true,
        p_hat: hat,
      }));
    },
    async remove(id, undo = false) {
      await settle(() => client.rpc("remove_pulse_chart", { p_id: id, p_undo: undo }));
    },
  };
}
