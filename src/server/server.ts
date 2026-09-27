import { buildApp } from "./app.js";
import { createOidcTokenVerifier } from "./auth.js";
import { createBrowserAuth } from "./browser-auth.js";
import { env } from "./config.js";
import { createDigitalOceanInfrastructureReader } from "./digitalocean.js";
import { createHubOidcProtocol } from "./oidc-client.js";

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
const infrastructureReader = createDigitalOceanInfrastructureReader({
  ...(env.DIGITALOCEAN_TOKEN ? { token: env.DIGITALOCEAN_TOKEN } : {}),
  timeoutMs: env.DIGITALOCEAN_REQUEST_TIMEOUT_MS,
  cacheMs: env.DIGITALOCEAN_CACHE_TTL_MS,
  metricWindowSeconds: env.DIGITALOCEAN_METRIC_WINDOW_SECONDS,
});
const app = await buildApp({
  ...(tokenVerifier ? { tokenVerifier } : {}),
  ...(browserAuth ? { browserAuth } : {}),
  infrastructureReader,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Stopping LH-Hub");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
