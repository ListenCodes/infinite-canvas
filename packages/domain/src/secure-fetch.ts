import { lookup as systemLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

import { Agent } from "undici";

import { assertPublicAddress, validateRemoteMediaUrl } from "./ssrf.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface SecureFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  trustedPrivateOrigins?: readonly string[];
  resolver?: AddressResolver;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

const defaultResolver: AddressResolver = async (hostname) => {
  const addresses = await systemLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

export async function resolvePublicAddresses(hostname: string, resolver: AddressResolver = defaultResolver): Promise<readonly ResolvedAddress[]> {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const literal = validateRemoteMediaUrl(`https://${normalized.includes(":") ? `[${normalized}]` : normalized}/`);
  if (literal.hostname.replace(/^\[|\]$/g, "") !== normalized) throw new Error("Media hostname normalization failed");
  const addresses = await resolver(normalized);
  if (addresses.length === 0) throw new Error("Media hostname did not resolve");
  for (const { address } of addresses) assertPublicAddress(address);
  return addresses;
}

function pinnedLookup(addresses: readonly ResolvedAddress[]): LookupFunction {
  return ((_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, addresses.map(({ address, family }) => ({ address, family })));
      return;
    }
    const selected = addresses[0];
    if (!selected) {
      callback(Object.assign(new Error("Media hostname did not resolve"), { code: "ENOTFOUND" }), "", 4);
      return;
    }
    callback(null, selected.address, selected.family);
  }) as LookupFunction;
}

function trustedOrigin(url: URL, allowed: readonly string[]): boolean {
  return allowed.some((origin) => {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  });
}

function validateFetchUrl(url: URL, allowed: readonly string[]): URL {
  if (trustedOrigin(url, allowed)) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
    if (url.username || url.password) throw new Error("URLs must not contain credentials");
    return url;
  }
  return validateRemoteMediaUrl(url.toString());
}

async function fetchPinned(url: URL, init: RequestInit, options: SecureFetchOptions): Promise<Response> {
  const allowed = options.trustedPrivateOrigins ?? [];
  validateFetchUrl(url, allowed);
  const trusted = trustedOrigin(url, allowed);
  const addresses = trusted
    ? await (options.resolver ?? defaultResolver)(url.hostname.replace(/^\[|\]$/g, ""))
    : await resolvePublicAddresses(url.hostname, options.resolver);
  if (addresses.length === 0) throw new Error("Media hostname did not resolve");
  const dispatcher = new Agent({
    connect: { lookup: pinnedLookup(addresses), timeout: Math.min(options.timeoutMs ?? 30_000, 30_000) },
    headersTimeout: options.timeoutMs ?? 30_000,
    bodyTimeout: options.timeoutMs ?? 30_000,
    pipelining: 0,
  });
  try {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const request: RequestInit = { ...init, signal, redirect: "manual", dispatcher: dispatcher as never };
    const response = await fetch(url, request);
    void dispatcher.close();
    return response as unknown as Response;
  } catch (error) {
    await dispatcher.destroy(error instanceof Error ? error : new Error("Secure fetch failed"));
    throw error;
  }
}

export async function secureFetch(input: string | URL, init: RequestInit = {}, options: SecureFetchOptions = {}): Promise<Response> {
  const allowed = options.trustedPrivateOrigins ?? [];
  let current = validateFetchUrl(new URL(input), allowed);
  let requestInit = { ...init };
  const maxRedirects = options.maxRedirects ?? 0;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchPinned(current, requestInit, options);
    if (!redirectStatuses.has(response.status)) return response;
    response.body?.cancel().catch(() => undefined);
    if (redirects >= maxRedirects) throw new Error("HTTP redirect limit exceeded");
    const method = String(requestInit.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error("Redirects are not allowed for non-idempotent requests");
    const location = response.headers.get("location");
    if (!location) throw new Error("HTTP redirect did not include Location");
    const next = validateFetchUrl(new URL(location, current), allowed);
    if (next.origin !== current.origin) {
      const headers = new Headers(requestInit.headers);
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
      requestInit = { ...requestInit, headers } as RequestInit;
    }
    current = next;
  }
}
