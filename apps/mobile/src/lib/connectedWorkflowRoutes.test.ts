import { expect, it } from 'vitest';
import { nativeWorkflowRoute } from './connectedWorkflowRoutes';
it('preserves exact message, task-message and channel-post coordinates', () => {
  expect(nativeWorkflowRoute('/m/messages?conversation=c&message=m')).toBe('/conversation/c?message=m');
  expect(nativeWorkflowRoute('/m/steward?thread=c&message=m')).toBe('/conversation/c?message=m');
  expect(nativeWorkflowRoute('/m/organize?thread=t&post=p')).toBe('/channel/t?post=p');
  expect(nativeWorkflowRoute('/m/messages?taskThread=t&message=m')).toBe('/task-conversation/t?message=m');
  expect(nativeWorkflowRoute('/m/messages?task=t&message=m')).toBe('/task-conversation/t?message=m');
  expect(nativeWorkflowRoute('/m/messages?task=t')).toBe('/task-conversation/t');
  expect(nativeWorkflowRoute('/m/tasks?task=t')).toBe('/feature/tasks?source=t');
  expect(nativeWorkflowRoute('/m/events?event=e')).toBe('/feature/events?source=e');
});
it('refuses external or unknown routes without changing the selected staff identity', () => {
  for (const route of ['https://evil.test/m/events?event=e', '//evil.test', '/m/unknown?event=e', '/m/events?event=%2Fevil']) expect(nativeWorkflowRoute(route)).toBeNull();
});
