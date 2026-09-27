import { buildApp } from "./app.js";
import {
  createOidcLogoutTokenVerifier,
  createOidcTokenVerifier,
} from "./auth.js";
import { createBrowserAuth } from "./browser-auth.js";
import { env } from "./config.js";
import { createConfigurableDigitalOceanInfrastructureReader } from "./digitalocean.js";
import { createHubOidcProtocol } from "./oidc-client.js";
import { createAuditReader } from "./audit.js";
import { createOperationsReader, createPublicStatusReader } from "./operations.js";
import { createHubSettingsService } from "./settings.js";

const tokenVerifier =
  env.SSO_ISSUER && env.SSO_JWKS_URL
    ? createOidcTokenVerifier({
        issuer: env.SSO_ISSUER,
        audience: env.SSO_AUDIENCE,
        jwksUrl: env.SSO_JWKS_URL,
      })
    : undefined;
const browserAuth = tokenVerifier && env.SSO_ISSUER && env.SSO_CLIENT_ID &&
    env.SSO_CLIENT_SECRET && env.SSO_REDIRECT_URI && env.SSO_RESOURCE
  ? createBrowserAuth({
      issuer: env.SSO_ISSUER,
      hubOrigin: env.HUB_ORIGIN,
      sessionLifetimeSeconds: env.HUB_SESSION_TTL_SECONDS,
      tokenVerifier,
      protocol: createHubOidcProtocol({
        issuer: env.SSO_ISSUER,
        clientId: env.SSO_CLIENT_ID,
        clientSecret: env.SSO_CLIENT_SECRET,
        redirectUri: env.SSO_REDIRECT_URI,
        resource: env.SSO_RESOURCE,
        timeoutMs: env.SSO_REQUEST_TIMEOUT_MS,
        production: env.NODE_ENV === "production",
      }),
    })
  : undefined;
const logoutTokenVerifier = env.SSO_ISSUER && env.SSO_CLIENT_ID && env.SSO_JWKS_URL
  ? createOidcLogoutTokenVerifier({
      issuer: env.SSO_ISSUER,
      audience: env.SSO_CLIENT_ID,
      jwksUrl: env.SSO_JWKS_URL,
    })
  : undefined;
const settings = env.HUB_SETTINGS_KEY
  ? createHubSettingsService({
      file: env.HUB_SETTINGS_FILE,
      encryptionKey: env.HUB_SETTINGS_KEY,
      ...(env.DIGITALOCEAN_TOKEN
        ? { environmentDigitalOceanToken: env.DIGITALOCEAN_TOKEN }
        : {}),
      timeoutMs: env.DIGITALOCEAN_REQUEST_TIMEOUT_MS,
    })
  : undefined;
const infrastructureReader = createConfigurableDigitalOceanInfrastructureReader({
  tokenProvider: async () => settings?.digitalOceanToken() ?? env.DIGITALOCEAN_TOKEN,
  timeoutMs: env.DIGITALOCEAN_REQUEST_TIMEOUT_MS,
  cacheMs: env.DIGITALOCEAN_CACHE_TTL_MS,
  metricWindowSeconds: env.DIGITALOCEAN_METRIC_WINDOW_SECONDS,
});
const auditReader = createAuditReader({
  apiOrigin: env.API_ORIGIN,
  ...(env.HUB_API_SERVICE_TOKEN ? { serviceToken: env.HUB_API_SERVICE_TOKEN } : {}),
  timeoutMs: env.API_REQUEST_TIMEOUT_MS,
});
const operationsReader = createOperationsReader({
  apiOrigin: env.API_ORIGIN,
  ...(env.HUB_API_SERVICE_TOKEN ? { serviceToken: env.HUB_API_SERVICE_TOKEN } : {}),
  timeoutMs: env.API_REQUEST_TIMEOUT_MS,
});
const publicStatusReader = createPublicStatusReader({
  statusUrl: env.STATUS_API_URL,
  timeoutMs: env.SERVICE_HEALTH_TIMEOUT_MS,
});
const app = await buildApp({
  ...(tokenVerifier ? { tokenVerifier } : {}),
  ...(browserAuth ? { browserAuth } : {}),
  ...(logoutTokenVerifier ? { logoutTokenVerifier } : {}),
  infrastructureReader,
  auditReader,
  operationsReader,
  publicStatusReader,
  ...(settings ? { settings } : {}),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Stopping LH-Hub");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
