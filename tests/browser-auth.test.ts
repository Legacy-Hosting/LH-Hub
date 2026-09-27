import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserAuthError,
  createBrowserAuth,
  type HubOidcProtocol,
} from "../src/server/browser-auth.js";

function protocol() {
  let state = "";
  let refreshes = 0;
  const implementation: HubOidcProtocol = {
    async authorizationUrl(input) {
      state = input.state;
      return new URL(`https://auth.legacyhosting.xyz/auth?state=${input.state}`);
    },
    async exchange(input) {
      assert.equal(input.state, state);
      return { accessToken: "initial-access", refreshToken: "refresh-1", expiresIn: 60 };
    },
    async refresh(refreshToken) {
      assert.equal(refreshToken, "refresh-1");
      refreshes += 1;
      return { accessToken: "refreshed-access", refreshToken: "refresh-2", expiresIn: 60 };
    },
  };
  return { implementation, state: () => state, refreshes: () => refreshes };
}

test("browser OIDC uses correlation, local redirects, staff roles, and refresh rotation", async () => {
  let timestamp = 1_000_000;
  const oidc = protocol();
  const auth = createBrowserAuth({
    protocol: oidc.implementation,
    issuer: "https://auth.legacyhosting.xyz",
    hubOrigin: "https://hub.legacyhosting.xyz",
    now: () => timestamp,
    tokenVerifier: async (token) => ({
      sub: "staff-1",
      name: "Support User",
      roles: token === "refreshed-access" ? ["support", "infrastructure"] : ["support"],
    }),
  });

  const started = await auth.begin("https://evil.example/steal");
  const callback = new URL("https://hub.legacyhosting.xyz/auth/callback");
  callback.searchParams.set("code", "code-1");
  callback.searchParams.set("state", oidc.state());
  const completed = await auth.complete(callback, started.correlation);
  assert.equal(completed.returnPath, "/");
  assert.deepEqual(await auth.identity(completed.sessionToken), {
    sub: "staff-1",
    name: "Support User",
    roles: ["support"],
  });

  timestamp += 31_000;
  assert.deepEqual((await auth.identity(completed.sessionToken))?.roles, [
    "support",
    "infrastructure",
  ]);
  assert.equal(oidc.refreshes(), 1);

  await auth.logout(completed.sessionToken);
  assert.equal(await auth.identity(completed.sessionToken), undefined);
  await assert.rejects(
    auth.complete(callback, started.correlation),
    (error: unknown) => error instanceof BrowserAuthError && error.statusCode === 401,
  );
});

test("browser OIDC rejects a callback not bound to the initiating browser", async () => {
  const oidc = protocol();
  const auth = createBrowserAuth({
    protocol: oidc.implementation,
    issuer: "https://auth.legacyhosting.xyz",
    hubOrigin: "https://hub.legacyhosting.xyz",
    tokenVerifier: async () => ({ sub: "staff-1", roles: ["support"] }),
  });
  await auth.begin("/");
  const callback = new URL(`https://hub.legacyhosting.xyz/auth/callback?code=x&state=${oidc.state()}`);
  await assert.rejects(
    auth.complete(callback, "x".repeat(43)),
    (error: unknown) => error instanceof BrowserAuthError && error.statusCode === 401,
  );
});

test("browser OIDC never creates a session for non-staff claims", async () => {
  const oidc = protocol();
  const auth = createBrowserAuth({
    protocol: oidc.implementation,
    issuer: "https://auth.legacyhosting.xyz",
    hubOrigin: "https://hub.legacyhosting.xyz",
    tokenVerifier: async () => ({ sub: "customer-1", roles: [] }),
  });
  const started = await auth.begin("/");
  const callback = new URL(`https://hub.legacyhosting.xyz/auth/callback?code=x&state=${oidc.state()}`);
  await assert.rejects(
    auth.complete(callback, started.correlation),
    (error: unknown) => error instanceof BrowserAuthError && error.statusCode === 403,
  );
});
