export function requiresBackendConfig({ hasConfig, testPreview, demoActive }) {
  return !hasConfig && !testPreview && !demoActive;
}
