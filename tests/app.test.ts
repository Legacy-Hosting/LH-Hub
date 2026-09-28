import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";

let app: FastifyInstance;
let loggedOutToken: string | undefined;
let revokedSubject: string | undefined;
let storedDigitalOceanToken: string | undefined;
let visibleGithubOwner = "";
let createdMaintenance: { targetKeys: string[]; impact: string } | undefined;
let storedStatusComponents: Array<Record<string, unknown>> = [];

const githubRepositories = [
  {
    fullName: "Legacy-Hosting/LH-Hub",
    url: "https://github.com/Legacy-Hosting/LH-Hub",
    defaultBranch: "main",
    private: true,
  },
  {
    fullName: "Angel/Private-Tool",
    url: "https://github.com/Angel/Private-Tool",
    defaultBranch: "main",
    private: true,
  },
];

before(async () => {
  app = await buildApp({
    tokenVerifier: async (token) =>
      token === "staff-token"
        ? { sub: "user-1", name: "Support", roles: ["support"] }
        : token === "infrastructure-token"
          ? { sub: "user-3", name: "Infrastructure", roles: ["infrastructure"] }
          : token === "admin-token"
            ? { sub: "user-4", name: "Administrator", roles: ["platform_admin"] }
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
    discordServiceToken: "d".repeat(32),
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
    githubRepositoryReader: async () => githubRepositories,
    settings: {
      digitalOceanToken: async () => storedDigitalOceanToken,
      digitalOceanStatus: async () => ({
        configured: Boolean(storedDigitalOceanToken),
        source: storedDigitalOceanToken ? "stored" : "none",
      }),
      saveDigitalOceanToken: async (token) => {
        storedDigitalOceanToken = token;
      },
      clearDigitalOceanToken: async () => {
        storedDigitalOceanToken = undefined;
      },
      statusComponentAdminView: async (servers = []) => ({
        components: storedStatusComponents.length > 0
          ? storedStatusComponents
          : servers.map((server, index) => ({
              server: server.name,
              componentKey: index === 0 ? "hub" : `service-${index}`,
              visible: false,
              primary: false,
              displayName: "Staff Hub",
              datacenter: "Amsterdam 3",
              service: "Hub",
              number: "01",
              primaryOrder: 0,
              publicUrl: "https://hub.legacyhosting.xyz/health",
              originFqdn: "ams3.hub-01.legacyh.fyi",
            })),
        datacenters: ["Amsterdam 3"],
        services: ["Hub"],
      }),
      saveStatusComponents: async (components) => {
        storedStatusComponents = components.map((component, index) => ({
          ...component,
          componentKey: component.server === "ams3-hub-01" ? "hub" : `service-${index}`,
          primaryOrder: component.primary ? index : 0,
        }));
      },
      publicStatusComponents: async () => storedStatusComponents
        .filter((component) => component.visible)
        .map((component) => ({
          key: component.componentKey,
          name: component.displayName,
          url: component.publicUrl,
          connectHostname: component.originFqdn,
          primary: component.primary,
          datacenter: component.datacenter,
          service: component.service,
          number: component.number,
          order: component.primaryOrder,
        })),
      discordAdminView: async () => ({ configured: false, services: [], announcements: [], maintenance: [] }),
      maintenanceView: async () => ({ services: [], maintenance: createdMaintenance ? [createdMaintenance] : [] }),
      saveDiscordCredentials: async () => undefined,
      saveDiscordConfiguration: async () => undefined,
      sendDiscordTest: async () => 8,
      createMaintenance: async (input) => {
        createdMaintenance = input;
      },
      finishMaintenance: async () => true,
      publicStatusEvents: async () => [],
      discordBotConfiguration: async () => ({
        configured: true,
        botToken: "bot-token-value-for-testing",
        guildId: "123456789012345678",
        services: [],
        announcements: [],
        maintenance: [],
        assets: {},
      }),
      reportDiscordPresence: async () => undefined,
      recordAnnouncementSent: async () => undefined,
      githubVisibilityView: async () => ({
        visibleOwner: visibleGithubOwner,
        owners: ["Angel", "Legacy-Hosting"],
      }),
      saveGithubVisibility: async (owner) => {
        if (owner && !["Angel", "Legacy-Hosting"].some((candidate) => candidate.toLowerCase() === owner.toLowerCase())) {
          throw new Error("unknown_github_owner");
        }
        visibleGithubOwner = ["Angel", "Legacy-Hosting"].find(
          (candidate) => candidate.toLowerCase() === owner.toLowerCase(),
        ) ?? "";
      },
      githubAdminView: async () => ({
        repositories: githubRepositories
          .filter((repository) => !visibleGithubOwner || repository.fullName.startsWith(`${visibleGithubOwner}/`))
          .map((repository) => ({ ...repository, enabled: false, channelIds: [] })),
        channels: [],
        pendingEvents: 0,
      }),
      saveGithubConfiguration: async () => undefined,
      ingestGithubPush: async () => true,
      githubPushEvents: async () => [],
      acknowledgeGithubPushEvents: async () => undefined,
    },
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
    version: "0.7.13",
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
  assert.equal(infrastructure.json().statusComponents.components[0].originFqdn, "ams3.hub-01.legacyh.fyi");
  assert.equal(JSON.stringify(infrastructure.json()).includes("token"), false);
});

test("platform administrators configure Status services with direct origin FQDNs", async () => {
  const denied = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/status-components",
    headers: { authorization: "Bearer infrastructure-token", origin: "https://hub.legacyhosting.xyz" },
    payload: { components: [] },
  });
  assert.equal(denied.statusCode, 403);

  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/status-components",
    headers: { authorization: "Bearer admin-token", origin: "https://hub.legacyhosting.xyz" },
    payload: {
      components: [{
        server: "ams3-hub-01",
        visible: true,
        primary: true,
        displayName: "Staff Hub",
        datacenter: "Amsterdam 3",
        service: "Hub",
        number: "01",
        publicUrl: "https://hub.legacyhosting.xyz/health",
        originFqdn: "ams3.hub-01.legacyh.fyi",
      }],
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().components[0].originFqdn, "ams3.hub-01.legacyh.fyi");

  const publicView = await app.inject({ method: "GET", url: "/api/v1/public/status-components" });
  assert.equal(publicView.statusCode, 200);
  assert.equal(publicView.json()[0].connectHostname, "ams3.hub-01.legacyh.fyi");
  assert.equal(publicView.headers["cache-control"], "public, max-age=15, stale-if-error=300");
});

test("client render failures are accepted only from an authenticated Hub page", async () => {
  const payload = {
    name: "TypeError",
    message: "A component failed to render",
    componentStack: "at StatusComponentManager",
    path: "/infrastructure",
  };
  const unauthenticated = await app.inject({
    method: "POST",
    url: "/api/v1/client-errors",
    headers: { origin: "https://hub.legacyhosting.xyz" },
    payload,
  });
  assert.equal(unauthenticated.statusCode, 401);

  const foreignOrigin = await app.inject({
    method: "POST",
    url: "/api/v1/client-errors",
    headers: { authorization: "Bearer admin-token", origin: "https://attacker.invalid" },
    payload,
  });
  assert.equal(foreignOrigin.statusCode, 403);

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/client-errors",
    headers: { authorization: "Bearer admin-token", origin: "https://hub.legacyhosting.xyz" },
    payload,
  });
  assert.equal(accepted.statusCode, 204);
});

test("only platform administrators can manage the encrypted DigitalOcean token", async () => {
  const denied = await app.inject({
    method: "GET",
    url: "/api/v1/settings/digitalocean",
    headers: { authorization: "Bearer infrastructure-token" },
  });
  assert.equal(denied.statusCode, 403);

  const invalidOrigin = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/digitalocean",
    headers: { authorization: "Bearer admin-token", origin: "https://attacker.invalid" },
    payload: { token: "x".repeat(40) },
  });
  assert.equal(invalidOrigin.statusCode, 403);

  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/digitalocean",
    headers: { authorization: "Bearer admin-token", origin: "https://hub.legacyhosting.xyz" },
    payload: { token: "x".repeat(40) },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().configured, true);
  assert.equal(JSON.stringify(saved.json()).includes("x".repeat(40)), false);

  const removed = await app.inject({
    method: "DELETE",
    url: "/api/v1/settings/digitalocean",
    headers: { authorization: "Bearer admin-token", origin: "https://hub.legacyhosting.xyz" },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().configured, false);
});

test("platform administrators can limit the GitHub workspace to one repository owner", async () => {
  const denied = await app.inject({
    method: "GET",
    url: "/api/v1/settings/github",
    headers: { authorization: "Bearer infrastructure-token" },
  });
  assert.equal(denied.statusCode, 403);

  const available = await app.inject({
    method: "GET",
    url: "/api/v1/settings/github",
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(available.statusCode, 200);
  assert.deepEqual(available.json().owners, ["Angel", "Legacy-Hosting"]);

  const invalidOrigin = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/github",
    headers: { authorization: "Bearer admin-token", origin: "https://attacker.invalid" },
    payload: { visibleOwner: "Legacy-Hosting" },
  });
  assert.equal(invalidOrigin.statusCode, 403);

  const saved = await app.inject({
    method: "PUT",
    url: "/api/v1/settings/github",
    headers: { authorization: "Bearer admin-token", origin: "https://hub.legacyhosting.xyz" },
    payload: { visibleOwner: "legacy-hosting" },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().visibleOwner, "Legacy-Hosting");

  const github = await app.inject({
    method: "GET",
    url: "/api/v1/github",
    headers: { authorization: "Bearer admin-token" },
  });
  assert.equal(github.statusCode, 200);
  assert.deepEqual(github.json().repositories.map((repository: { fullName: string }) => repository.fullName), ["Legacy-Hosting/LH-Hub"]);
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

test("maintenance can cover multiple services with a selected impact", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/maintenance",
    headers: {
      authorization: "Bearer infrastructure-token",
      origin: "https://hub.legacyhosting.xyz",
    },
    payload: {
      targetKeys: ["api", "sso"],
      impact: "major",
      title: "Platform maintenance",
      message: "Updating shared infrastructure.",
      scheduledFor: "2026-12-01T10:00:00.000Z",
      scheduledUntil: "2026-12-01T11:00:00.000Z",
    },
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(createdMaintenance?.targetKeys, ["api", "sso"]);
  assert.equal(createdMaintenance?.impact, "major");

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/v1/maintenance",
    headers: {
      authorization: "Bearer infrastructure-token",
      origin: "https://hub.legacyhosting.xyz",
    },
    payload: {
      targetKeys: ["api", "api"],
      impact: "minor",
      title: "Invalid maintenance",
      message: "Duplicate services are rejected.",
      scheduledFor: "2026-12-01T10:00:00.000Z",
      scheduledUntil: "2026-12-01T11:00:00.000Z",
    },
  });
  assert.equal(duplicate.statusCode, 400);
});

test("LH-Discord configuration is available only to the internal bot service", async () => {
  const missing = await app.inject({ method: "GET", url: "/api/v1/internal/discord/config" });
  assert.equal(missing.statusCode, 401);

  const allowed = await app.inject({
    method: "GET",
    url: "/api/v1/internal/discord/config",
    headers: { authorization: `Bearer ${"d".repeat(32)}` },
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().guildId, "123456789012345678");
  assert.equal(allowed.json().botToken, "bot-token-value-for-testing");
});
