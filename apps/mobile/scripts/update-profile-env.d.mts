export type EasProfile = {
  extends?: string;
  channel?: string;
  distribution?: string;
  environment?: string;
  env?: Record<string, string>;
};
export type EasConfig = { build: Record<string, EasProfile> };

export function resolveEasProfile(easConfig: EasConfig, name: string, seen?: string[]): EasProfile & { env: Record<string, string> };
export function updateEnvironment(easConfig: EasConfig, profileName: string, hostedEnvironment: Record<string, string | undefined>): Record<string, string | undefined>;
export function updateCommandProblems(profileName: string, command: string[]): string[];
