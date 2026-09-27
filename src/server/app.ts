import helmet from "@fastify/helmet";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  authorizeClaims,
  capabilitiesFor,
  hasCapability,
  readBearerToken,
  type HubIdentity,
  type LogoutTokenVerifier,
  type TokenVerifier,
} from "./auth.js";
import type { BrowserAuthService } from "./browser-auth.js";
import { env, healthTargets } from "./config.js";
import type { InfrastructureReader } from "./digitalocean.js";
import type { AuditReader } from "./audit.js";
import type { OperationsReader, PublicStatusReader } from "./operations.js";
import {
  createServiceHealthReader,
  type FetchImplementation,
} from "./service-health.js";
import { HUB_VERSION } from "./version.js";
import { githubPushEventSchema, type HubSettingsService } from "./settings.js";
import type { GitHubRepositoryReader } from "./github.js";

export async function buildApp(options: {
  tokenVerifier?: TokenVerifier;
  browserAuth?: BrowserAuthService;
  hubOrigin?: string;
  secureCookies?: boolean;
  fetchImplementation?: FetchImplementation;
  infrastructureReader?: InfrastructureReader;
  logoutTokenVerifier?: LogoutTokenVerifier;
  auditReader?: AuditReader;
  operationsReader?: OperationsReader;
  publicStatusReader?: PublicStatusReader;
  settings?: HubSettingsService;
  discordServiceToken?: string;
  apiServiceToken?: string;
  githubRepositoryReader?: GitHubRepositoryReader;
} = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === "production",
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
  await app.register(formbody);
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
  });

  const readServiceHealth = createServiceHealthReader({
    targets: healthTargets,
    timeoutMs: env.SERVICE_HEALTH_TIMEOUT_MS,
    ...(options.fetchImplementation
      ? { fetchImplementation: options.fetchImplementation }
      : {}),
  });
  const secureCookies = options.secureCookies ?? env.NODE_ENV === "production";
  const hubOrigin = options.hubOrigin ?? env.HUB_ORIGIN;
  const cookieNames = {
    correlation: secureCookies ? "__Host-lh_hub_oidc" : "lh_hub_oidc",
    session: secureCookies ? "__Host-lh_hub_session" : "lh_hub_session",
  };

  function readCookie(header: string | undefined, name: string) {
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
      const value = part.slice(separator + 1).trim();
      return value || undefined;
    }
    return undefined;
  }

  function sessionCookie(name: string, value: string, maxAge: number) {
    return [
      `${name}=${value}`,
      "Path=/",
      `Max-Age=${maxAge}`,
      "HttpOnly",
      "SameSite=Lax",
      ...(secureCookies ? ["Secure"] : []),
    ].join("; ");
  }

  function validDiscordServiceToken(value: string | string[] | undefined) {
    const configured = options.discordServiceToken ?? env.HUB_DISCORD_SERVICE_TOKEN;
    if (!configured || typeof value !== "string") return false;
    const supplied = Buffer.from(value);
    const expected = Buffer.from(configured);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function validApiServiceToken(value: string | string[] | undefined) {
    const configured = options.apiServiceToken ?? env.HUB_API_SERVICE_TOKEN;
    if (!configured || typeof value !== "string") return false;
    const supplied = Buffer.from(value);
    const expected = Buffer.from(configured);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function validBrowserOrigin(origin: string | undefined) {
    return origin === new URL(hubOrigin).origin;
  }

  type AuthorizationResult =
    | { identity: HubIdentity; accessToken: string }
    | { error: string; statusCode: 401 | 403 | 503 };

  async function requireStaff(
    authorization: string | undefined,
    cookie: string | undefined,
  ): Promise<AuthorizationResult> {
    const token = readBearerToken(authorization);
    if (token && options.tokenVerifier) {
      try {
        const identity = authorizeClaims(await options.tokenVerifier(token));
        if (!identity) return { error: "staff_access_required", statusCode: 403 } as const;
        return { identity, accessToken: token } as const;
      } catch {
        return { error: "invalid_access_token", statusCode: 401 } as const;
      }
    }
    if (options.browserAuth) {
      const authorization = await options.browserAuth.authorization(
        readCookie(cookie, cookieNames.session),
      );
      if (authorization) return authorization;
    }
    if (!options.tokenVerifier && !options.browserAuth) {
      return { error: "sso_not_configured", statusCode: 503 } as const;
    }
    return { error: "authentication_required", statusCode: 401 } as const;
  }

  app.get("/auth/login", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!options.browserAuth) return reply.status(503).send({ error: "sso_not_configured" });
    const query = z.object({ return_to: z.string().max(1_024).optional() }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "validation_error" });
    try {
      const login = await options.browserAuth.begin(query.data.return_to);
      reply.header(
        "Set-Cookie",
        sessionCookie(cookieNames.correlation, login.correlation, 600),
      );
      return reply.redirect(login.authorizationUrl, 303);
    } catch {
      request.log.warn("Hub SSO login could not start");
      return reply.status(503).send({ error: "sso_unavailable" });
    }
  });

  app.get("/auth/callback", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!options.browserAuth) return reply.status(503).send({ error: "sso_not_configured" });
    const correlation = readCookie(request.headers.cookie, cookieNames.correlation);
    try {
      const callbackUrl = new URL(request.raw.url ?? request.url, hubOrigin);
      const login = await options.browserAuth.complete(callbackUrl, correlation);
      reply.header("Set-Cookie", [
        sessionCookie(cookieNames.correlation, "", 0),
        sessionCookie(cookieNames.session, login.sessionToken, env.HUB_SESSION_TTL_SECONDS),
      ]);
      return reply.redirect(login.returnPath, 303);
    } catch {
      request.log.warn("Hub SSO callback failed");
      reply.header("Set-Cookie", sessionCookie(cookieNames.correlation, "", 0));
      return reply.redirect("/?auth_error=1", 303);
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin !== new URL(hubOrigin).origin) {
      return reply.status(403).send({ error: "invalid_origin" });
    }
    let logoutUrl = "/";
    try {
      logoutUrl = await options.browserAuth?.logout(
        readCookie(request.headers.cookie, cookieNames.session),
      ) ?? "/";
    } catch {
      request.log.warn("Local Hub logout completed but SSO logout could not start");
    }
    reply.header("Set-Cookie", sessionCookie(cookieNames.session, "", 0));
    return reply.redirect(logoutUrl, 303);
  });

  app.post("/auth/backchannel-logout", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const body = z.object({ logout_token: z.string().min(100).max(16_384) })
      .safeParse(request.body);
    if (!body.success || !options.logoutTokenVerifier || !options.browserAuth) {
      return reply.status(400).send({ error: "invalid_logout_token" });
    }
    try {
      const identity = await options.logoutTokenVerifier(body.data.logout_token);
      await options.browserAuth.revokeSubject(identity.subject);
      return reply.status(200).send();
    } catch {
      request.log.warn("Hub back-channel logout token was rejected");
      return reply.status(400).send({ error: "invalid_logout_token" });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "LH-Hub",
    version: HUB_VERSION,
  }));

  app.get("/api/v1/session", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    return {
      user: authorization.identity,
      capabilities: capabilitiesFor(authorization.identity),
    };
  });

  app.get("/api/v1/overview", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    return {
      generatedAt: new Date().toISOString(),
      services: await readServiceHealth(),
    };
  });

  app.get("/api/v1/infrastructure", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    if (!hasCapability(authorization.identity, "infrastructure:read")) {
      return reply.status(403).send({ error: "insufficient_hub_access" });
    }
    if (!options.infrastructureReader) {
      return { state: "not_configured", fetchedAt: null, droplets: [] };
    }
    return options.infrastructureReader();
  });

  app.get("/api/v1/settings/digitalocean", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    if (!hasCapability(authorization.identity, "settings:write")) {
      return reply.status(403).send({ error: "platform_admin_required" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    return options.settings.digitalOceanStatus();
  });

  app.put("/api/v1/settings/digitalocean", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    if (!hasCapability(authorization.identity, "settings:write")) {
      return reply.status(403).send({ error: "platform_admin_required" });
    }
    if (request.headers.origin !== new URL(hubOrigin).origin) {
      return reply.status(403).send({ error: "invalid_origin" });
    }
    const body = z.object({
      token: z.string().min(32).max(512).regex(/^\S+$/),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_digitalocean_token" });
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    try {
      await options.settings.saveDigitalOceanToken(body.data.token);
      return { configured: true, source: "stored" };
    } catch {
      request.log.warn("DigitalOcean token validation or storage failed");
      return reply.status(400).send({ error: "digitalocean_token_rejected" });
    }
  });

  app.delete("/api/v1/settings/digitalocean", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    if (!hasCapability(authorization.identity, "settings:write")) {
      return reply.status(403).send({ error: "platform_admin_required" });
    }
    if (request.headers.origin !== new URL(hubOrigin).origin) {
      return reply.status(403).send({ error: "invalid_origin" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    await options.settings.clearDigitalOceanToken();
    return options.settings.digitalOceanStatus();
  });

  app.get("/api/v1/settings/discord", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "settings:write")) {
      return reply.status(403).send({ error: "platform_admin_required" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    return options.settings.discordAdminView();
  });

  app.put("/api/v1/settings/discord", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "settings:write")) {
      return reply.status(403).send({ error: "platform_admin_required" });
    }
    if (!validBrowserOrigin(request.headers.origin)) return reply.status(403).send({ error: "invalid_origin" });
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = z.object({
      guildId: z.string().regex(/^\d{17,20}$/),
      botToken: z.string().min(20).max(512).optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_discord_credentials" });
    try {
      await options.settings.saveDiscordCredentials({
        guildId: body.data.guildId,
        ...(body.data.botToken ? { botToken: body.data.botToken } : {}),
      });
      return options.settings.discordAdminView();
    } catch {
      request.log.warn("Discord bot credentials were rejected");
      return reply.status(400).send({ error: "discord_credentials_rejected" });
    }
  });

  app.get("/api/v1/discord", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "discord:manage")) {
      return reply.status(403).send({ error: "discord_management_required" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    return options.settings.discordAdminView();
  });

  app.put("/api/v1/discord", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "discord:manage")) {
      return reply.status(403).send({ error: "discord_management_required" });
    }
    if (!validBrowserOrigin(request.headers.origin)) return reply.status(403).send({ error: "invalid_origin" });
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const channelIds = z.array(z.string().regex(/^\d{17,20}$/)).max(20);
    const body = z.object({
      serviceChannels: z.record(z.string(), channelIds),
      eventChannels: z.record(z.enum(["operational", "degraded", "outage", "maintenance", "maintenanceComplete"]), channelIds),
      testChannelId: z.union([z.string().regex(/^\d{17,20}$/), z.literal("")]).optional(),
      announcements: z.array(z.object({
        key: z.enum(["birthday", "christmas", "newyear"]),
        enabled: z.boolean(),
        title: z.string().trim().min(1).max(256),
        message: z.string().trim().min(1).max(2_000),
        channelIds,
      })).length(3),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_discord_configuration" });
    try {
      await options.settings.saveDiscordConfiguration(body.data);
      return options.settings.discordAdminView();
    } catch {
      return reply.status(400).send({ error: "invalid_discord_configuration" });
    }
  });

  app.post("/api/v1/discord/test", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "discord:manage")) {
      return reply.status(403).send({ error: "discord_management_required" });
    }
    if (!validBrowserOrigin(request.headers.origin)) return reply.status(403).send({ error: "invalid_origin" });
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = z.object({
      channelId: z.string().regex(/^\d{17,20}$/),
      announcements: z.array(z.object({
        key: z.enum(["birthday", "christmas", "newyear"]),
        title: z.string().trim().min(1).max(256),
        message: z.string().trim().min(1).max(2_000),
      })).length(3).optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_test_channel" });
    try {
      const sent = await options.settings.sendDiscordTest(
        body.data.channelId,
        body.data.announcements,
      );
      return { sent };
    } catch {
      request.log.warn("Discord test notification could not be sent");
      return reply.status(400).send({ error: "discord_test_failed" });
    }
  });

  app.get("/api/v1/github", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "github:manage")) {
      return reply.status(403).send({ error: "github_management_required" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    let repositories: Awaited<ReturnType<GitHubRepositoryReader>> = [];
    try {
      repositories = await options.githubRepositoryReader?.() ?? [];
    } catch (error) {
      request.log.warn({ err: error }, "GitHub repository inventory could not be loaded");
    }
    return options.settings.githubAdminView(repositories);
  });

  app.put("/api/v1/github", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "github:manage")) {
      return reply.status(403).send({ error: "github_management_required" });
    }
    if (!validBrowserOrigin(request.headers.origin)) return reply.status(403).send({ error: "invalid_origin" });
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = z.object({
      repositories: z.array(z.object({
        fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(255),
        enabled: z.boolean(),
        channelIds: z.array(z.string().regex(/^\d{17,20}$/)).max(20),
      })).max(1_000),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_github_configuration" });
    try {
      await options.settings.saveGithubConfiguration(body.data.repositories);
      let repositories: Awaited<ReturnType<GitHubRepositoryReader>> = [];
      try {
        repositories = await options.githubRepositoryReader?.() ?? [];
      } catch {
        repositories = [];
      }
      return options.settings.githubAdminView(repositories);
    } catch {
      return reply.status(400).send({ error: "invalid_github_configuration" });
    }
  });

  app.post("/api/v1/internal/github/push", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validApiServiceToken(request.headers["x-lh-hub-token"])) {
      return reply.status(401).send({ error: "invalid_service_token" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = githubPushEventSchema.omit({ channelIds: true }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_github_push" });
    const queued = await options.settings.ingestGithubPush(body.data);
    return reply.status(202).send({ accepted: true, queued });
  });

  app.post("/api/v1/maintenance", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "maintenance:write")) {
      return reply.status(403).send({ error: "maintenance_access_required" });
    }
    if (!validBrowserOrigin(request.headers.origin)) return reply.status(403).send({ error: "invalid_origin" });
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = z.object({
      targetKey: z.enum(["api", "sso", "hub", "panel", "status"]),
      title: z.string().trim().min(3).max(120),
      message: z.string().trim().min(3).max(1_000),
      scheduledFor: z.string().datetime(),
      scheduledUntil: z.string().datetime(),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_maintenance" });
    try {
      await options.settings.createMaintenance(body.data);
      return reply.status(201).send(await options.settings.maintenanceView());
    } catch {
      return reply.status(400).send({ error: "invalid_maintenance" });
    }
  });

  app.patch("/api/v1/maintenance/:id", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "maintenance:write")) {
      return reply.status(403).send({ error: "maintenance_access_required" });
    }
    if (!validBrowserOrigin(request.headers.origin)) return reply.status(403).send({ error: "invalid_origin" });
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const parameters = z.object({ id: z.string().regex(/^maintenance-[a-f0-9]{24}$/) }).safeParse(request.params);
    const body = z.object({ action: z.enum(["complete", "cancel"]) }).safeParse(request.body);
    if (!parameters.success || !body.success) return reply.status(400).send({ error: "invalid_maintenance" });
    if (!await options.settings.finishMaintenance(parameters.data.id, body.data.action)) {
      return reply.status(404).send({ error: "maintenance_not_found" });
    }
    return options.settings.maintenanceView();
  });

  app.get("/api/v1/maintenance", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(request.headers.authorization, request.headers.cookie);
    if ("error" in authorization) return reply.status(authorization.statusCode).send({ error: authorization.error });
    if (!hasCapability(authorization.identity, "maintenance:write")) {
      return reply.status(403).send({ error: "maintenance_access_required" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    return options.settings.maintenanceView();
  });

  app.get("/api/v1/public/status-events", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=15, stale-if-error=300");
    return options.settings ? options.settings.publicStatusEvents() : [];
  });

  app.get("/api/v1/internal/discord/config", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validDiscordServiceToken(request.headers.authorization?.replace(/^Bearer\s+/i, ""))) {
      return reply.status(401).send({ error: "invalid_service_token" });
    }
    const configuration = await options.settings?.discordBotConfiguration();
    return configuration ?? reply.status(503).send({ error: "discord_not_configured" });
  });

  app.put("/api/v1/internal/discord/presence", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validDiscordServiceToken(request.headers.authorization?.replace(/^Bearer\s+/i, ""))) {
      return reply.status(401).send({ error: "invalid_service_token" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = z.object({
      bot: z.object({ id: z.string().regex(/^\d{17,20}$/), username: z.string().min(1).max(100) }),
      channels: z.array(z.object({ id: z.string().regex(/^\d{17,20}$/), name: z.string().min(1).max(100) })).max(500),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_discord_presence" });
    await options.settings.reportDiscordPresence(body.data);
    return reply.status(204).send();
  });

  app.post("/api/v1/internal/discord/announcement-sent", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validDiscordServiceToken(request.headers.authorization?.replace(/^Bearer\s+/i, ""))) {
      return reply.status(401).send({ error: "invalid_service_token" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = z.object({
      key: z.enum(["birthday", "christmas", "newyear"]),
      year: z.number().int().min(2017).max(9999),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_announcement_receipt" });
    await options.settings.recordAnnouncementSent(body.data.key, body.data.year);
    return reply.status(204).send();
  });

  app.get("/api/v1/internal/discord/github-events", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validDiscordServiceToken(request.headers.authorization?.replace(/^Bearer\s+/i, ""))) {
      return reply.status(401).send({ error: "invalid_service_token" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    return { events: await options.settings.githubPushEvents(25) };
  });

  app.post("/api/v1/internal/discord/github-events/ack", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!validDiscordServiceToken(request.headers.authorization?.replace(/^Bearer\s+/i, ""))) {
      return reply.status(401).send({ error: "invalid_service_token" });
    }
    if (!options.settings) return reply.status(503).send({ error: "settings_not_configured" });
    const body = z.object({
      deliveryIds: z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).min(1).max(100),
    }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: "invalid_github_acknowledgement" });
    await options.settings.acknowledgeGithubPushEvents(body.data.deliveryIds);
    return reply.status(204).send();
  });

  app.get("/api/v1/operations", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    if (!hasCapability(authorization.identity, "operations:read")) {
      return reply.status(403).send({ error: "insufficient_hub_access" });
    }
    const [platform, publicStatus] = await Promise.allSettled([
      options.operationsReader?.(authorization.accessToken) ??
        Promise.reject(new Error("operations_not_configured")),
      options.publicStatusReader?.() ??
        Promise.reject(new Error("status_not_configured")),
    ]);
    if (platform.status === "rejected") {
      request.log.warn("LH-API operations summary could not be read");
    }
    if (publicStatus.status === "rejected") {
      request.log.warn("LH-Status snapshot could not be read");
    }
    return {
      generatedAt: new Date().toISOString(),
      platform: platform.status === "fulfilled"
        ? { state: "ready", data: platform.value }
        : { state: "unavailable", data: null },
      publicStatus: publicStatus.status === "fulfilled"
        ? { state: "ready", data: publicStatus.value }
        : { state: "unavailable", data: null },
    };
  });

  app.get("/api/v1/audit-events", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authorization = await requireStaff(
      request.headers.authorization,
      request.headers.cookie,
    );
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    if (!hasCapability(authorization.identity, "audit:read")) {
      return reply.status(403).send({ error: "insufficient_hub_access" });
    }
    if (!options.auditReader) {
      return reply.status(503).send({ error: "audit_not_configured" });
    }
    const query = z.object({
      cursor: z.string().min(1).max(1_024).optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "validation_error" });
    try {
      return await options.auditReader({
        accessToken: authorization.accessToken,
        ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
      });
    } catch {
      request.log.warn("LH-API audit events could not be read");
      return reply.status(502).send({ error: "audit_unavailable" });
    }
  });

  return app;
}
