export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN?: string;
      readonly EXPO_PUBLIC_POSTHOG_HOST?: string;
    }
  }
}
