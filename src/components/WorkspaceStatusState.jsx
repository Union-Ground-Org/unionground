import { StateBlock } from "./Primitives.jsx";
import { useWorkspace, workspaceHref } from "./WorkspacePages.jsx";

// A workspace page that cannot show its content (Lovable audit Batch A
// pattern 1, REQ-UG-LOVABLE-AUDIT-WEBAPP-FIXES-20261103): a status
// heading, the dependency in plain words, a next step and a route back as real
// links, and who can fix it. Never a lone sentence above a blank area.
//
// Each link is { label, path, view?, onClick? }. Inside a workspace the link
// opens through the workspace router (in `view` when it leaves this plane);
// an explicit onClick replaces that (a tab switch on the same page). A
// modified click keeps the browser's own behaviour.
export function WorkspaceStatusState({ title, body, hint = null, links = [], headingLevel = 2 }) {
  const workspace = useWorkspace();
  const routed = links.map(({ label, path, view, onClick }) => ({
    label,
    href: workspaceHref(path),
    onClick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (onClick) { event.preventDefault(); onClick(); return; }
      if (!workspace) return;
      event.preventDefault();
      workspace.open(path, view || workspace.view);
    },
  }));
  return <StateBlock kind="unavailable" title={title} body={body} hint={hint} links={routed} headingLevel={headingLevel} />;
}
