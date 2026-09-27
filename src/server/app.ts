import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  authorizeClaims,
  readBearerToken,
  type HubIdentity,
  type TokenVerifier,
} from "./auth.js";
import { env, healthTargets } from "./config.js";
import {
  createServiceHealthReader,
  type FetchImplementation,
} from "./service-health.js";

export async function buildApp(options: {
  tokenVerifier?: TokenVerifier;
  fetchImplementation?: FetchImplementation;
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

  type AuthorizationResult =
    | { identity: HubIdentity }
    | { error: string; statusCode: 401 | 403 | 503 };

  async function requireStaff(
    authorization: string | undefined,
  ): Promise<AuthorizationResult> {
    if (!options.tokenVerifier) {
      return { error: "sso_not_configured", statusCode: 503 } as const;
    }
    const token = readBearerToken(authorization);
    if (!token) return { error: "authentication_required", statusCode: 401 } as const;
    try {
      const identity = authorizeClaims(await options.tokenVerifier(token));
      if (!identity) return { error: "staff_access_required", statusCode: 403 } as const;
      return { identity } as const;
    } catch {
      return { error: "invalid_access_token", statusCode: 401 } as const;
    }
  }

  app.get("/health", async () => ({
    status: "ok",
    service: "LH-Hub",
    version: "0.1.0",
  }));

  app.get("/api/v1/session", async (request, reply) => {
    const authorization = await requireStaff(request.headers.authorization);
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    return { user: authorization.identity };
  });

  app.get("/api/v1/overview", async (request, reply) => {
    const authorization = await requireStaff(request.headers.authorization);
    if ("error" in authorization) {
      return reply.status(authorization.statusCode).send({ error: authorization.error });
    }
    return {
      generatedAt: new Date().toISOString(),
      services: await readServiceHealth(),
    };
  });

  return app;
}
