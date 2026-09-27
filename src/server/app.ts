import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z } from "zod";
import {
  authorizeClaims,
  readBearerToken,
  type HubIdentity,
  type TokenVerifier,
} from "./auth.js";
import type { BrowserAuthService } from "./browser-auth.js";
import { env, healthTargets } from "./config.js";
import type { InfrastructureReader } from "./digitalocean.js";
import {
  createServiceHealthReader,
  type FetchImplementation,
} from "./service-health.js";

export async function buildApp(options: {
  tokenVerifier?: TokenVerifier;
  browserAuth?: BrowserAuthService;
  hubOrigin?: string;
  secureCookies?: boolean;
  fetchImplementation?: FetchImplementation;
  infrastructureReader?: InfrastructureReader;
} = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === "production",
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
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

  type AuthorizationResult =
    | { identity: HubIdentity }
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
        return { identity } as const;
      } catch {
        return { error: "invalid_access_token", statusCode: 401 } as const;
      }
    }
    if (options.browserAuth) {
      const identity = await options.browserAuth.identity(
        readCookie(cookie, cookieNames.session),
      );
      if (identity) return { identity } as const;
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
    if (origin && origin !== new URL(hubOrigin).origin) {
      return reply.status(403).send({ error: "invalid_origin" });
    }
    await options.browserAuth?.logout(readCookie(request.headers.cookie, cookieNames.session));
    reply.header("Set-Cookie", sessionCookie(cookieNames.session, "", 0));
    return reply.redirect("/", 303);
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "LH-Hub",
    version: "0.3.0",
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
    return { user: authorization.identity };
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
    if (!options.infrastructureReader) {
      return { state: "not_configured", fetchedAt: null, droplets: [] };
    }
    return options.infrastructureReader();
  });

  return app;
}
