interface RouterEnvironment {
  LINEAR_API_KEY: string;
  ROUTED_ENVIRONMENTS: string;
}

export function apiKey(env: RouterEnvironment): string {
  return env.LINEAR_API_KEY || env.ROUTED_ENVIRONMENTS;
}
