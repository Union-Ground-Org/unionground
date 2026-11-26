import { Suspense } from "react";
import { ChunkBoundary } from "../../components/ChunkBoundary.jsx";
import { lazyView } from "../../lib/lazyView.js";
import { OrgStartGuideCard } from "./OrgStartGuideCard.jsx";

const OrgStartGuide = lazyView(() => import("./OrgStartGuide.jsx").then((module) => ({ default: module.OrgStartGuide })));

// The page is reloaded only when the person presses Reload (#9132); the
// boundary never reloads it (canReload stays false), so a failed optional
// guide never takes the rest of the staff home with it.
function reloadPage() {
  window.location.reload();
}

export function DeferredOrgStartGuide(props) {
  return (
    <ChunkBoundary canReload={() => false} fallback={() => <OrgStartGuideCard view={props.guide?.view} loadFailed onReload={reloadPage} />}>
      <Suspense fallback={<OrgStartGuideCard view={props.guide?.view} pending />}>
        <OrgStartGuide {...props} />
      </Suspense>
    </ChunkBoundary>
  );
}
