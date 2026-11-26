// A double assertion launders an unknown value into a claimed shape.
const raw: unknown = { id: 1 };
export const claimed = raw as unknown as { id: string };
export const identifier = claimed.id;
