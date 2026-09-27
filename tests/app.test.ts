import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";

let app: FastifyInstance;
let loggedOutToken: string | undefined;
let revokedSubject: string | undefined;

before(async () => {
  app = await buildApp({
    tokenVerifier: async (token) =>
      token === "staff-token"
        ? { sub: "user-1", name: "Support", roles: ["support"] }
        : token === "infrastructure-token"
          ? { sub: "user-3", name: "Infrastructure", roles: ["infrastructure"] }
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
      authorization: async (token) => token === "s".repeat(43)
        ? {
            identity: { sub: "user-1", name: "Support", roles: ["support"] },
            accessToken: "browser-access-token",
          }
        : undefined,
      logout: async (token) => {
        loggedOutToken = token;
        return "https://auth.legacyhosting.xyz/session/end?client_id=lh-hub";
      },
      revokeSubject: async (subject) => {
        revokedSubject = subject;
        return 1;
      },
    },
    logoutTokenVerifier: async (token) => {
      assert.equal(token, "x".repeat(120));
      return { subject: "user-1", eventId: "logout-event-123456789" };
    },
    hubOrigin: "https://hub.legacyhosting.xyz",
    secureCookies: true,
    fetchImplementation: async () => new Response("ok", { status: 200 }),
    infrastructureReader: async () => ({
      state: "ready",
      fetchedAt: "2026-09-27T09:00:00.000Z",
      droplets: [{
        name: "ams3-hub-01",
        status: "active",
        region: "ams3",
        vcpus: 1,
        memoryMiB: 1024,
        diskGiB: 25,
        metricsState: "ready",
        metricsUpdatedAt: "2026-09-27T08:59:00.000Z",
        cpuPercent: 4.2,
        memoryPercent: 21.5,
        diskPercent: 12.1,
        load1: 0.08,
        publicBandwidthInMbps: 0.3,
        publicBandwidthOutMbps: 0.1,
      }],
    }),
    auditReader: async ({ accessToken }) => {
      assert.ok(["staff-token", "browser-access-token"].includes(accessToken));
      return {
        events: [{
          id: "1",
          team: null,
          actor: null,
          product: "panel",
          action: "team.updated",
          resource: { type: "team", id: "team-1" },
          metadata: null,
          createdAt: "2026-09-27T09:00:00.000Z",
        }],
        nextCursor: null,
      };
    },
    operationsReader: async (accessToken) => {
      assert.ok([
        "staff-token",
        "infrastructure-token",
        "browser-access-token",
      ].includes(accessToken));
      return {
        generatedAt: "2026-09-27T10:00:00.000Z",
        database: { state: "connected" },
        applications: { total: 3, running: 2, failed: 1, deploying: 0, stopped: 0, pending: 0 },
        agents: { total: 2, online: 2, offline: 0, pending: 0, draining: 0, lastHeartbeatAt: "2026-09-27T09:59:55.000Z" },
        deployments: { windowHours: 24, total: 2, succeeded: 1, failed: 1, inProgress: 0, queued: 0, cancelled: 0, successRate: 50, recent: [] },
      };
    },
    publicStatusReader: async () => ({
      version: 2,
      overall: "operational",
      generatedAt: "2026-09-27T10:00:00.000Z",
      stale: false,
      components: [],
      events: [],
    }),
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
      version: "0.6.5",
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
  assert.deepEqual(staff.json().capabilities, ["services:read", "support:read", "audit:read"]);

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
  assert.equal(
    logout.headers.location,
    "https://auth.legacyhosting.xyz/session/end?client_id=lh-hub",
  );

  const crossOriginLogout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { origin: "https://attacker.invalid" },
  });
  assert.equal(crossOriginLogout.statusCode, 403);

  const backchannel = await app.inject({
    method: "POST",
    url: "/auth/backchannel-logout",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ logout_token: "x".repeat(120) }).toString(),
  });
  assert.equal(backchannel.statusCode, 200);
  assert.equal(revokedSubject, "user-1");
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

  const deniedInfrastructure = await app.inject({
    method: "GET",
    url: "/api/v1/infrastructure",
    headers: { authorization: "Bearer staff-token" },
  });
  assert.equal(deniedInfrastructure.statusCode, 403);
  assert.equal(deniedInfrastructure.json().error, "insufficient_hub_access");

  const infrastructure = await app.inject({
    method: "GET",
    url: "/api/v1/infrastructure",
    headers: { authorization: "Bearer infrastructure-token" },
  });
  assert.equal(infrastructure.statusCode, 200);
  assert.equal(infrastructure.json().state, "ready");
  assert.equal(infrastructure.json().droplets[0].name, "ams3-hub-01");
  assert.equal(JSON.stringify(infrastructure.json()).includes("token"), false);
});

test("audit events are proxied only for audit-capable staff", async () => {
  const allowed = await app.inject({
    method: "GET",
    url: "/api/v1/audit-events",
    headers: { authorization: "Bearer staff-token" },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().events[0].action, "team.updated");

  const denied = await app.inject({
    method: "GET",
    url: "/api/v1/audit-events",
    headers: { authorization: "Bearer infrastructure-token" },
  });
  assert.equal(denied.statusCode, 403);
});

test("operations combine the protected API summary and public status snapshot", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/operations",
    headers: { authorization: "Bearer infrastructure-token" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().platform.state, "ready");
  assert.equal(response.json().platform.data.agents.online, 2);
  assert.equal(response.json().publicStatus.data.overall, "operational");

  const denied = await app.inject({
    method: "GET",
    url: "/api/v1/operations",
    headers: { authorization: "Bearer staff-token" },
  });
  assert.equal(denied.statusCode, 403);
});
