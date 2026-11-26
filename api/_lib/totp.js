// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), the same algorithm the Tamarack staff
// bots answer their authenticator with (bots/lib/totp.mjs). Server-only: the
// SAMPLE demo entry completes a staff persona's two-step sign-in with it.
import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(secret) {
  const clean = String(secret).replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  if (!clean) throw new Error("Invalid base32 TOTP secret");
  let bits = "";
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new Error("Invalid base32 TOTP secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret, { now = Date.now(), step = 30, digits = 6 } = {}) {
  const counter = Math.floor(now / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const start = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(start) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
