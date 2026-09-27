import * as oidc from "openid-client";
import type { HubOidcProtocol, OidcTokenResult } from "./browser-auth.js";

function tokenResult(tokens: oidc.TokenEndpointResponse): OidcTokenResult {
  if (typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new Error("missing_access_token");
  }
  return {
    accessToken: tokens.access_token,
    ...(typeof tokens.refresh_token === "string" && tokens.refresh_token
      ? { refreshToken: tokens.refresh_token }
      : {}),
    expiresIn: typeof tokens.expires_in === "number" && tokens.expires_in > 0
      ? tokens.expires_in
      : 300,
  };
}

export function createHubOidcProtocol(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  resource: string;
  timeoutMs: number;
  production: boolean;
}): HubOidcProtocol {
  let configurationPromise: Promise<oidc.Configuration> | undefined;

  function boundedFetch(url: string, request: oidc.CustomFetchOptions) {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    return fetch(url, { ...request, signal } as unknown as RequestInit);
  }

  function configuration() {
    if (!configurationPromise) {
      const issuer = new URL(options.issuer);
      const execute = issuer.protocol === "http:" && !options.production
        ? [oidc.allowInsecureRequests]
        : undefined;
      configurationPromise = oidc.discovery(
        issuer,
        options.clientId,
        {
          client_secret: options.clientSecret,
          redirect_uris: [options.redirectUri],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_basic",
        },
        oidc.ClientSecretBasic(options.clientSecret),
        {
          [oidc.customFetch]: boundedFetch,
          ...(execute ? { execute } : {}),
        },
      ).then((value) => {
        value.timeout = Math.ceil(options.timeoutMs / 1_000);
        return value;
      }).catch((error) => {
        configurationPromise = undefined;
        throw error;
      });
    }
    return configurationPromise;
  }

  return {
    async authorizationUrl(input) {
      return oidc.buildAuthorizationUrl(await configuration(), {
        redirect_uri: options.redirectUri,
        scope: "openid profile email roles offline_access",
        resource: options.resource,
        prompt: "consent",
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
        state: input.state,
        nonce: input.nonce,
      });
    },

    async exchange(input) {
      const tokens = await oidc.authorizationCodeGrant(
        await configuration(),
        input.callbackUrl,
        {
          pkceCodeVerifier: input.codeVerifier,
          expectedState: input.state,
          expectedNonce: input.nonce,
          idTokenExpected: true,
        },
        { resource: options.resource },
      );
      return tokenResult(tokens);
    },

    async refresh(refreshToken) {
      const tokens = await oidc.refreshTokenGrant(
        await configuration(),
        refreshToken,
        { resource: options.resource },
      );
      return tokenResult(tokens);
    },

    async endSessionUrl() {
      return oidc.buildEndSessionUrl(await configuration(), {
        client_id: options.clientId,
        post_logout_redirect_uri: new URL("/", options.redirectUri).toString(),
      });
    },
  };
}
