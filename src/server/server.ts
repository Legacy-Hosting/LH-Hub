import { buildApp } from "./app.js";
import { createOidcTokenVerifier } from "./auth.js";
import { env } from "./config.js";

const tokenVerifier =
  env.SSO_ISSUER && env.SSO_JWKS_URL
    ? createOidcTokenVerifier({
        issuer: env.SSO_ISSUER,
        audience: env.SSO_AUDIENCE,
        jwksUrl: env.SSO_JWKS_URL,
      })
    : undefined;
const app = await buildApp(tokenVerifier ? { tokenVerifier } : {});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Stopping LH-Hub");
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: env.HOST, port: env.PORT });
