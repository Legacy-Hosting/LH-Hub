import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { authorizeClaims, type HubIdentity, type TokenVerifier } from "./auth.js";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const loginLifetimeMs = 10 * 60 * 1_000;
const refreshBeforeExpiryMs = 30 * 1_000;
const maximumPendingLogins = 2_000;
const maximumSessions = 5_000;

type LoginRequest = {
  nonce: string;
  codeVerifier: string;
  correlationHash: string;
  returnPath: string;
  expiresAt: number;
};

type BrowserSession = {
  identity: HubIdentity;
  refreshToken?: string;
  accessTokenExpiresAt: number;
  expiresAt: number;
};

export type OidcTokenResult = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
};

export type HubOidcProtocol = {
  authorizationUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
  }): Promise<URL>;
  exchange(input: {
    callbackUrl: URL;
    state: string;
    nonce: string;
    codeVerifier: string;
  }): Promise<OidcTokenResult>;
  refresh(refreshToken: string): Promise<OidcTokenResult>;
};

export type BrowserAuthService = {
  begin(returnTo?: string): Promise<{ authorizationUrl: string; correlation: string }>;
  complete(
    callbackUrl: URL,
    correlation: string | undefined,
  ): Promise<{ sessionToken: string; returnPath: string }>;
  identity(sessionToken: string | undefined): Promise<HubIdentity | undefined>;
  logout(sessionToken: string | undefined): Promise<void>;
};

export class BrowserAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 401 | 403 | 503 = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function equalHashes(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function localReturnPath(value: string | undefined, hubOrigin: string) {
  if (!value || value.length > 1_024 || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  try {
    const origin = new URL(hubOrigin);
    const destination = new URL(value, origin);
    if (destination.origin !== origin.origin) return "/";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/";
  }
}

export function createBrowserAuth(options: {
  protocol: HubOidcProtocol;
  tokenVerifier: TokenVerifier;
  issuer: string;
  hubOrigin: string;
  sessionLifetimeSeconds?: number;
  now?: () => number;
}): BrowserAuthService {
  const loginRequests = new Map<string, LoginRequest>();
  const sessions = new Map<string, BrowserSession>();
  const refreshes = new Map<string, Promise<HubIdentity | undefined>>();
  const now = options.now ?? Date.now;
  const sessionLifetimeMs = (options.sessionLifetimeSeconds ?? 28_800) * 1_000;
  const issuerOrigin = new URL(options.issuer).origin;

  function cleanup() {
    const timestamp = now();
    for (const [key, request] of loginRequests) {
      if (request.expiresAt <= timestamp) loginRequests.delete(key);
    }
    for (const [key, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(key);
    }
  }

  async function verifiedIdentity(accessToken: string) {
    let identity: HubIdentity | null;
    try {
      identity = authorizeClaims(await options.tokenVerifier(accessToken));
    } catch (error) {
      throw new BrowserAuthError("invalid_access_token", 401, { cause: error });
    }
    if (!identity) throw new BrowserAuthError("staff_access_required", 403);
    return identity;
  }

  async function refreshSession(sessionKey: string, session: BrowserSession) {
    if (!session.refreshToken) {
      sessions.delete(sessionKey);
      return undefined;
    }
    try {
      const tokens = await options.protocol.refresh(session.refreshToken);
      const identity = await verifiedIdentity(tokens.accessToken);
      const timestamp = now();
      if (session.expiresAt <= timestamp) {
        sessions.delete(sessionKey);
        return undefined;
      }
      sessions.set(sessionKey, {
        ...session,
        identity,
        refreshToken: tokens.refreshToken ?? session.refreshToken,
        accessTokenExpiresAt: timestamp + tokens.expiresIn * 1_000,
      });
      return identity;
    } catch {
      sessions.delete(sessionKey);
      return undefined;
    }
  }

  return {
    async begin(returnTo) {
      cleanup();
      if (loginRequests.size >= maximumPendingLogins) {
        throw new BrowserAuthError("authentication_capacity_exceeded", 503);
      }
      const state = randomToken();
      const nonce = randomToken();
      const codeVerifier = randomToken();
      const correlation = randomToken();
      const stateKey = tokenHash(state);
      loginRequests.set(stateKey, {
        nonce,
        codeVerifier,
        correlationHash: tokenHash(correlation),
        returnPath: localReturnPath(returnTo, options.hubOrigin),
        expiresAt: now() + loginLifetimeMs,
      });
      try {
        const codeChallenge = createHash("sha256")
          .update(codeVerifier, "utf8")
          .digest("base64url");
        const authorizationUrl = await options.protocol.authorizationUrl({
          state,
          nonce,
          codeChallenge,
        });
        if (authorizationUrl.origin !== issuerOrigin) {
          throw new BrowserAuthError("invalid_authorization_url", 503);
        }
        return { authorizationUrl: authorizationUrl.toString(), correlation };
      } catch (error) {
        loginRequests.delete(stateKey);
        if (error instanceof BrowserAuthError) throw error;
        throw new BrowserAuthError("sso_unavailable", 503, { cause: error });
      }
    },

    async complete(callbackUrl, correlation) {
      cleanup();
      const state = callbackUrl.searchParams.get("state") ?? "";
      if (!tokenPattern.test(state) || !correlation || !tokenPattern.test(correlation)) {
        throw new BrowserAuthError("invalid_or_expired_state", 401);
      }
      const stateKey = tokenHash(state);
      const request = loginRequests.get(stateKey);
      loginRequests.delete(stateKey);
      if (
        !request ||
        request.expiresAt <= now() ||
        !equalHashes(request.correlationHash, tokenHash(correlation))
      ) {
        throw new BrowserAuthError("invalid_or_expired_state", 401);
      }

      let tokens: OidcTokenResult;
      try {
        tokens = await options.protocol.exchange({
          callbackUrl,
          state,
          nonce: request.nonce,
          codeVerifier: request.codeVerifier,
        });
      } catch (error) {
        throw new BrowserAuthError("sso_callback_failed", 401, { cause: error });
      }
      const identity = await verifiedIdentity(tokens.accessToken);
      cleanup();
      if (sessions.size >= maximumSessions) {
        throw new BrowserAuthError("authentication_capacity_exceeded", 503);
      }
      const timestamp = now();
      const sessionToken = randomToken();
      sessions.set(tokenHash(sessionToken), {
        identity,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        accessTokenExpiresAt: timestamp + tokens.expiresIn * 1_000,
        expiresAt: timestamp + sessionLifetimeMs,
      });
      return { sessionToken, returnPath: request.returnPath };
    },

    async identity(sessionToken) {
      cleanup();
      if (!sessionToken || !tokenPattern.test(sessionToken)) return undefined;
      const sessionKey = tokenHash(sessionToken);
      const session = sessions.get(sessionKey);
      if (!session) return undefined;
      if (session.accessTokenExpiresAt > now() + refreshBeforeExpiryMs) {
        return session.identity;
      }
      let refresh = refreshes.get(sessionKey);
      if (!refresh) {
        refresh = refreshSession(sessionKey, session).finally(() => {
          refreshes.delete(sessionKey);
        });
        refreshes.set(sessionKey, refresh);
      }
      return refresh;
    },

    async logout(sessionToken) {
      if (sessionToken && tokenPattern.test(sessionToken)) {
        sessions.delete(tokenHash(sessionToken));
      }
    },
  };
}
