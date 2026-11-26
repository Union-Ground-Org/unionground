export type ReadState = 'loading' | 'loaded' | 'empty' | 'failed';
export interface ReadResult<T> { state: ReadState; value: T | null; error: unknown }
export declare const READ_STATES: { loading: 'loading'; loaded: 'loaded'; empty: 'empty'; failed: 'failed' };
export declare const READ_LOADING: ReadResult<never>;
export function readResult<T>(read: () => T | Promise<T>, options?: { isEmpty?: (value: T) => boolean }): Promise<ReadResult<T>>;
