import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

const blockedNames = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);
const blockedSuffixes = [".localhost", ".local", ".internal"];
const blockedRanges = new Set(["unspecified", "broadcast", "multicast", "linkLocal", "loopback", "private", "carrierGradeNat", "reserved", "uniqueLocal"]);

export function validateRemoteMediaUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https media URLs are allowed");
  if (url.username || url.password) throw new Error("Media URLs must not contain credentials");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (blockedNames.has(hostname) || blockedSuffixes.some((suffix) => hostname.endsWith(suffix))) throw new Error("Media hostname is not public");
  if (isIP(hostname)) assertPublicAddress(hostname);
  return url;
}

export function assertPublicAddress(address: string): void {
  const parsed = ipaddr.parse(address);
  const ipv6 = parsed.kind() === "ipv6" ? parsed as ipaddr.IPv6 : undefined;
  const normalized = ipv6?.isIPv4MappedAddress() ? ipv6.toIPv4Address() : parsed;
  if (blockedRanges.has(normalized.range())) throw new Error("Media address is not public");
}
