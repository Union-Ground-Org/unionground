import { isIP } from "node:net";

function expandIpv6(address) {
  let source = address.toLowerCase();
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = source.slice(lastColon + 1);
    if (lastColon < 0 || isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    source = `${source.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = halves.length === 2
    ? [...left, ...Array(missing).fill("0"), ...right]
    : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

export function networkBucket(value) {
  let address = String(value || "").trim();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  address = address.split("%")[0];
  if (isIP(address) === 4) return `ipv4:${address}`;
  if (isIP(address) !== 6) return null;

  const parts = expandIpv6(address);
  if (!parts) return null;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    const ipv4 = [parts[6] >> 8, parts[6] & 0xff, parts[7] >> 8, parts[7] & 0xff].join(".");
    return `ipv4:${ipv4}`;
  }
  return `ipv6:${parts.slice(0, 4).map((part) => part.toString(16)).join(":")}::/64`;
}

function requestAddressCandidate(request) {
  const forwarded = String(request?.headers?.["x-vercel-forwarded-for"] || "").split(",")[0].trim();
  const remote = String(request?.socket?.remoteAddress || "").trim();
  return forwarded || remote;
}

export function requestNetworkBucket(request) {
  return networkBucket(requestAddressCandidate(request));
}

// The single end-user address Vercel reports (or the socket peer), as a
// literal IP, or null. Used only where an upstream needs the address itself.
export function requestClientAddress(request) {
  let address = requestAddressCandidate(request);
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  address = address.split("%")[0];
  return isIP(address) ? address : null;
}
