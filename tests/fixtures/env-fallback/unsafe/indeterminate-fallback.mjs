import { legacyConfig } from "./config.mjs";

export const jwtSigningKey = process.env.SESSION_JWT_SECRET || legacyConfig.signingKey;
