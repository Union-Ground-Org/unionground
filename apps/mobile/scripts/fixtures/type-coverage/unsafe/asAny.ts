// A native-module escape hatch spelled `as any`.
const globalScope: object = {};
export const nativeModule = (globalScope as any).ExpoSecureStore;
export const readValue = nativeModule.getValueWithKeyAsync;
