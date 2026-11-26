export function createResponseQueue<T = unknown>(): {
  request(label: string): Promise<T>;
  resolve(label: string, value: T): void;
  reject(label: string, error: unknown): void;
  pending(): string[];
};
