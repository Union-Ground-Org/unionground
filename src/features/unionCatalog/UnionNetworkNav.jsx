import { useLang } from "../../lib/LanguageContext.jsx";
import { useWorkspace, workspaceHref } from "../../components/WorkspacePages.jsx";
import { unionNetworkCopy } from "./unionNetworkCopy.js";
import "./unionNetwork.css";

// One journey over authorized campaign work. Union Ground has no public
// union catalog, so the nav offers only in-app destinations. Navigation
// never switches a hat or turns a public directory entry into a tenant.
export function UnionNetworkNav({ current, staff = false, admin = false }) {
  const { lang } = useLang();
  const tr = unionNetworkCopy(lang);
  const workspace = useWorkspace();
  const links = [
    ...(staff ? [["connections", "/m/organize/connections", "hub"], ["handshakes", "/m/organize/partners", "hub"], ["resources", "/m/organize/library", "hub"]] : []),
    ...((admin || !workspace) ? [["build", "/m/admin/setup-review", "admin"]] : []),
  ];
  return <nav className="union-network-nav" aria-label={tr("network")}>
    <strong>{tr("network")}</strong>
    <div>{links.map(([key, path, view]) => <a key={key} href={view ? workspaceHref(path) : path}
      aria-current={current === key ? "page" : undefined}
      onClick={(event) => {
        if (!view || !workspace || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); workspace.open(path, view);
      }}>{tr(key)}</a>)}</div>
  </nav>;
}
