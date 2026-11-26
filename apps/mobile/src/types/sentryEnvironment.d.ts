export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly EXPO_PUBLIC_SENTRY_DSN_IOS?: string;
      readonly EXPO_PUBLIC_SENTRY_DSN_ANDROID?: string;
    }
  }
}
