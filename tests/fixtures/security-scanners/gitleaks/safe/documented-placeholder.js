// Gitleaks fixture: the safe counterpart. A named, obviously empty placeholder
// carries no entropy and must not be reported.
export const apiKey = process.env.EXAMPLE_API_KEY ?? "";
