import { createRemoteJWKSet, jwtVerify } from "jose";

import { AppError } from "./errors.js";

export interface AuthUser {
  userId: string;
  email?: string;
  expiresAt: number;
}

export interface Authenticator {
  authenticate(authorization: string | undefined): Promise<AuthUser>;
}

export class SupabaseAuthenticator implements Authenticator {
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #issuer: string;

  constructor(supabaseUrl: string, private readonly audience: string) {
    const base = supabaseUrl.replace(/\/$/, "");
    this.#issuer = `${base}/auth/v1`;
    this.#jwks = createRemoteJWKSet(new URL(`${this.#issuer}/.well-known/jwks.json`));
  }

  async authenticate(authorization: string | undefined): Promise<AuthUser> {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    if (!match?.[1]) throw new AppError(401, "authentication_required", "A valid access token is required");
    try {
      const { payload } = await jwtVerify(match[1], this.#jwks, {
        issuer: this.#issuer,
        audience: this.audience,
      });
      if (!payload.sub || typeof payload.exp !== "number") throw new Error("JWT has no subject or expiry");
      return { userId: payload.sub, expiresAt: payload.exp * 1000, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
    } catch {
      throw new AppError(401, "invalid_access_token", "The access token is invalid or expired");
    }
  }
}
