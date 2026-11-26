import { useMemo } from "react";
import { useOrganizationName } from "../lib/organizationName.js";
import { createPulseApi } from "../features/pulse/pulseApi.js";
import { pulseHat } from "../features/pulse/pulseCharts.js";
import { createPreviewPulseApi, PULSE_PREVIEW_ORGANIZATION } from "../features/pulse/pulsePreview.js";
import { PulseExplorer } from "../features/pulse/ui/PulseExplorer.jsx";

// /m/pulse: the website Pulse explorer for the signed-in hat. The fixture
// demo uses the labeled Tamarack fixture; a live session reads the same RPCs
// as the app, and the server decides what the hat may see. A live page with
// no client says Pulse is unavailable rather than showing fixture figures.
export function PulseView({ client = null, preview = false, hat = "member", api = null }) {
  const organizationName = useOrganizationName();
  const pulseApi = useMemo(() => api || (preview ? createPreviewPulseApi() : createPulseApi(client)), [api, client, preview]);
  return (
    <PulseExplorer
      api={pulseApi}
      hat={pulseHat(hat)}
      organizationName={pulseApi.isPreview ? PULSE_PREVIEW_ORGANIZATION : organizationName}
    />
  );
}

export default PulseView;
