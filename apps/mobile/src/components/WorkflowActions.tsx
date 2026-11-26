import { useRouter } from 'expo-router';
import { useState, type ComponentProps } from 'react';
import { ConnectedRecordActions } from './ConnectedRecordActions';
import { NativeMessageActions } from './NativeMessageActions';
import { connectedStaffAccess, type ConnectedSourceKind } from '../lib/connectedWorkflows';
import { canOpenFeature, isFeatureKey } from '../lib/featureCatalog';
import { useApp } from '../state/AppProvider';
import { resumeDraftReadsConfirmed, useResumeDraftKey } from '../lib/resumeDraftHolder';

export function WorkflowActions({ kind, id, recordTitle, visible, onVisibleChange }: { kind: ConnectedSourceKind; id: string; recordTitle?: string; visible?: boolean; onVisibleChange?: (value: boolean) => void }) {
  const router = useRouter();
  const app = useApp();
  const resumeKey = useResumeDraftKey(app, 'workflow', `${kind}:${id}`);
  const sendKey = useResumeDraftKey(app, 'workflowSend', `${kind}:${id}`);
  const reminderKey = useResumeDraftKey(app, 'workflowReminder', `${kind}:${id}`);
  const reminderSendKey = useResumeDraftKey(app, 'workflowReminderSend', `${kind}:${id}`);
  const contactKey = useResumeDraftKey(app, 'workflowContact', `${kind}:${id}`);
  const contactSendKey = useResumeDraftKey(app, 'workflowContactSend', `${kind}:${id}`);
  const { mode, session, dashboard, organizationID, authorizedRoles, chapterRoles, organizationRoles, previewHat } = app;
  if (mode !== 'authenticated' || !session || !dashboard || !resumeDraftReadsConfirmed(app)) return null;
  const scope = JSON.stringify([session.user.id, organizationID, dashboard.member.chapterID, authorizedRoles, previewHat]);
  // A feature route opens only when the worn role may open that feature; the
  // sheet asks first (#9080) so it can offer another way instead of failing.
  const routeOpens = (route: string) => {
    const feature = /^\/feature\/([^?]+)/.exec(route)?.[1];
    return !feature || (isFeatureKey(feature) && canOpenFeature(mode, feature, previewHat, chapterRoles, organizationRoles));
  };
  return <ConnectedRecordActions
    key={`${resumeKey?.id ?? scope}:${kind}:${id}`}
    scopeKey={scope}
    resumeKey={resumeKey}
    sendKey={sendKey}
    reminderKey={reminderKey}
    reminderSendKey={reminderSendKey}
    contactKey={contactKey}
    contactSendKey={contactSendKey}
    visible={visible}
    onVisibleChange={onVisibleChange}
    renderTrigger={visible === undefined}
    reference={{ kind, id, organizationId: organizationID, chapterId: dashboard.member.chapterID }}
    recordTitle={recordTitle}
    staffAccess={connectedStaffAccess({ mode, authorizedRoles, previewHat })}
    language={dashboard.member.language === 'es' ? 'es' : 'en'}
    canNavigate={routeOpens}
    onNavigate={(route) => {
      if (!routeOpens(route)) throw new Error('Destination unavailable');
      router.push(route as never);
    }}
  />;
}

export function WorkflowMessageActions(props: ComponentProps<typeof NativeMessageActions>) {
  const [open, setOpen] = useState(false);
  return <>
    <NativeMessageActions {...props} onConnectedActions={() => setOpen(true)} />
    <WorkflowActions kind={props.sourceKind === 'private' ? 'private_message' : 'channel_post'} id={props.messageID} visible={open} onVisibleChange={setOpen} />
  </>;
}
