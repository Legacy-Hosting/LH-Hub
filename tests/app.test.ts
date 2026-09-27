import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";

let app: FastifyInstance;
let loggedOutToken: string | undefined;

before(async () => {
  app = await buildApp({
    tokenVerifier: async (token) =>
      token === "staff-token"
        ? { sub: "user-1", name: "Support", roles: ["support"] }
        : { sub: "user-2", roles: [] },
    browserAuth: {
      begin: async () => ({
        authorizationUrl: "https://auth.legacyhosting.xyz/auth?state=test",
        correlation: "c".repeat(43),
      }),
      complete: async () => ({ sessionToken: "s".repeat(43), returnPath: "/" }),
      identity: async (token) => token === "s".repeat(43)
        ? { sub: "user-1", name: "Support", roles: ["support"] }
        : undefined,
      logout: async (token) => {
        loggedOutToken = token;
      },
    },
    hubOrigin: "https://hub.legacyhosting.xyz",
    secureCookies: true,
    fetchImplementation: async () => new Response("ok", { status: 200 }),
  });
});

after(async () => {
  await app.close();
});

test("health is public and contains no protected configuration", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "LH-Hub",
    version: "0.2.0",
  });
});

test("Hub APIs require an SSO bearer token and a staff role", async () => {
  const missing = await app.inject({ method: "GET", url: "/api/v1/session" });
  assert.equal(missing.statusCode, 401);

  const customer = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { authorization: "Bearer customer-token" },
  });
  assert.equal(customer.statusCode, 403);

  const staff = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { authorization: "Bearer staff-token" },
  });
  assert.equal(staff.statusCode, 200);
  assert.deepEqual(staff.json().user.roles, ["support"]);

  const browserSession = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { cookie: `__Host-lh_hub_session=${"s".repeat(43)}` },
  });
  assert.equal(browserSession.statusCode, 200);
  assert.deepEqual(browserSession.json().user.roles, ["support"]);
});

test("browser login binds the callback and creates an HttpOnly session", async () => {
  const started = await app.inject({
    method: "GET",
    url: "/auth/login?return_to=%2F",
  });
  assert.equal(started.statusCode, 303);
  assert.equal(started.headers.location, "https://auth.legacyhosting.xyz/auth?state=test");
  assert.match(String(started.headers["set-cookie"]), /__Host-lh_hub_oidc=/);
  assert.match(String(started.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(started.headers["set-cookie"]), /Secure/);

  const completed = await app.inject({
    method: "GET",
    url: "/auth/callback?code=test&state=test",
    headers: { cookie: `__Host-lh_hub_oidc=${"c".repeat(43)}` },
  });
  assert.equal(completed.statusCode, 303);
  assert.equal(completed.headers.location, "/");
  assert.match(String(completed.headers["set-cookie"]), /__Host-lh_hub_session=/);

  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      cookie: `__Host-lh_hub_session=${"s".repeat(43)}`,
      origin: "https://hub.legacyhosting.xyz",
    },
  });
  assert.equal(logout.statusCode, 303);
  assert.equal(loggedOutToken, "s".repeat(43));
});

test("service checks run server-side for authorized staff", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/overview",
    headers: { authorization: "Bearer staff-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().services.length, 4);
  assert.ok(response.json().services.every((service: { state: string }) => service.state === "operational"));
});
