import { useMemo } from "react";
import { IntegrationControlPlane } from "../features/integrations/IntegrationControlPlane.jsx";
import { GoogleActivationsPanel } from "../features/integrations/GoogleActivationsPanel.jsx";
import {
  createSupabaseIntegrationStore,
  createUnsetIntegrationStore,
  useMi1ScopedActor,
} from "../lib/mi1FeatureWiring.js";
import { useLang } from "../lib/LanguageContext.jsx";

const unsetStore = createUnsetIntegrationStore();

export function IntegrationsView({ actor, client = null, store = null, embedded = false }) {
  const { t } = useLang();
  const scopedActor = useMi1ScopedActor(client, actor);
  const clientStore = useMemo(() => client ? createSupabaseIntegrationStore(client) : unsetStore, [client]);
  const effectiveStore = store || clientStore;
  const oauthNotice = useMemo(() => {
    if (typeof window === "undefined") return "";
    const status = new URLSearchParams(window.location.search).get("constant_contact");
    if (status === "denied") return t("integrations.constantContactCanceled");
    if (status === "error") return t("integrations.constantContactError");
    return "";
  }, [t]);
  const notice = oauthNotice || (effectiveStore.persistenceKind === "unset" ? t("integrations.unsetNotice") : "");
  return (
    <div className={embedded ? "" : "screen"} data-mi1-surface="integrations">
      <header className="phead">
        <div className="phead__copy">
          <h1 className="phead__title">{t("integrations.title")}</h1>
          <p className="phead__sub">{t("integrations.sub")}</p>
        </div>
      </header>
      <IntegrationControlPlane
        store={effectiveStore}
        actor={scopedActor}
        notice={notice}
        noticeRole={oauthNotice ? "alert" : "status"}
        googleActivations={client ? <GoogleActivationsPanel client={client} /> : null}
      />
    </div>
  );
}
