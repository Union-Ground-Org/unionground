// Structural declarations also support mobile-only dependency installations.
export interface SentryTechnicalMetadata {
  release?: string;
  environment?: string;
  surface?: string;
}

export interface TechnicalErrorEvent {
  type: undefined;
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' | 'log';
  message: string;
  event_id?: string;
  timestamp?: number;
  platform?: string;
  exception?: { values: Array<{ type: string; value: string; stacktrace?: { frames: Array<{ filename?: string; lineno?: number; colno?: number; in_app?: boolean }> } }> };
}
interface PrivateSdkMetadata {
  name: 'sentry.javascript.unionground-private-errors';
  version: '1.0.0';
  settings: { infer_ip: 'never' };
}
interface PrivateEnvelopeEvent extends TechnicalErrorEvent {
  sdk: PrivateSdkMetadata;
  release?: string;
  environment?: 'production' | 'preview' | 'development';
  tags?: { surface: 'web' | 'api' | 'ios' | 'android' };
  user: { geo: { lookup: 'disabled' } };
}
interface PrivateEnvelopeHeader {
  sdk: PrivateSdkMetadata;
  event_id?: string;
  dsn?: string;
  sent_at?: string;
}
export function sanitizeSentryBreadcrumb(breadcrumb?: unknown): null;
export function sanitizeSentryEvent(event: unknown): TechnicalErrorEvent | null;
export function sanitizeSentrySpan(span?: unknown): {
  span_id: string; trace_id: string; start_timestamp: number; timestamp: number; op: string; data: Record<string, never>;
};
declare function sanitizeSentryEnvelope(envelope: unknown, metadata?: SentryTechnicalMetadata): [PrivateEnvelopeHeader, Array<[{ type: 'event' }, PrivateEnvelopeEvent]>] | null;
declare function privateSentryTransport<Options, Transport extends { send(envelope: never): PromiseLike<unknown>; flush(timeout?: number): PromiseLike<boolean> }>(makeTransport: (options: Options) => Transport, metadata?: SentryTechnicalMetadata): (options: Options) => Pick<Transport, 'send' | 'flush'>;
export function privateSentryOptions(): {
  sendDefaultPii: false;
  sampleRate: 1;
  tracesSampleRate: 0;
  tracePropagationTargets: string[];
  replaysSessionSampleRate: 0;
  replaysOnErrorSampleRate: 0;
  enableLogs: false;
  enableMetrics: false;
  sendClientReports: false;
  autoSessionTracking: false;
  maxBreadcrumbs: 0;
  beforeBreadcrumb: typeof sanitizeSentryBreadcrumb;
  beforeSend: typeof sanitizeSentryEvent;
  beforeSendTransaction: () => null;
  beforeSendSpan: typeof sanitizeSentrySpan;
};

export function createSentryPrivacy(sdkName: PrivateSdkMetadata['name']): {
  sanitizeSentryEnvelope: typeof sanitizeSentryEnvelope;
  privateSentryTransport: typeof privateSentryTransport;
};
