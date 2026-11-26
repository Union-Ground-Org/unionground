import type { Dispatch, SetStateAction } from 'react';
import { completeBusinessOperation } from '../lib/useBusinessWriter';

// Source-extracted handlers use the production control implementation, with
// the same captured setters that a mounted business hook hands them.
export function businessHandlerContext(context: Record<string, unknown>, component: string) {
  const control = { current: false };
  const stringIdle = component === 'CollectiveActionsScreen' || component === 'ConnectionSession';
  const nullIdle = ['LiveSurveyCard', 'LiveCampaignsScreen', 'LivePartnersFeature', 'RequestsSection', 'FormsSection', 'CatalogPublisherCard', 'OperationsHealthScreen', 'LiveRightsScreen', 'LiveEventsScreen', 'LiveChapterScreen'].includes(component);
  const idle = stringIdle ? '' : nullIdle ? null : false;
  const key = component === 'LiveBeHeardScreen' ? 'setSending' : component === 'RequestsSection' ? 'setBusyID'
    : component === 'OperationsHealthScreen' ? 'setBusyJobName' : component === 'NotificationPreferencesCard' ? 'setSaving' : 'setBusy';
  const setter = context[key] as Dispatch<SetStateAction<unknown>> | undefined;
  return { mode: 'authenticated', preview: false, control, unconfirmedWrite: false, setUnconfirmedWrite: () => {}, accepted: false, setAccepted: () => {}, acceptedEntries: new Set<string>(), setAcceptedEntries: () => {}, checkoutControl: { current: false }, providerControl: { current: false }, acceptedOperations: new Set<string>(), acceptedActions: new Set<string>(), setAcceptedActions: () => {}, setAcceptedOperations: () => {}, request: { current: 0 }, setPage: () => {}, setTitle: () => {}, setBody: () => {}, setReply: () => {}, reread: context.refresh ?? context.onSaved, queue: { refreshThrough: context.setReload, reread: context.setReload }, operate: (active: unknown, work: () => Promise<void>) =>
    completeBusinessOperation(control, active, idle, setter ?? (() => {}), work), ...context };
}
