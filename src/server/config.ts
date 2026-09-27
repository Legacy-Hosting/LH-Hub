import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const defaultTargets = JSON.stringify([
  { key: "panel", name: "Control panel", url: "https://panel.legacyhosting.xyz/" },
  { key: "api", name: "API", url: "https://api.legacyhosting.xyz/health" },
  { key: "identity", name: "Identity", url: "https://auth.legacyhosting.xyz/health" },
  { key: "status", name: "Public status", url: "https://status.legacyhosting.xyz/health" },
]);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
    TRUST_PROXY: booleanFromString,
    SSO_ISSUER: z.string().url().optional(),
    SSO_AUDIENCE: z.string().min(1).default("lh-hub"),
    SSO_JWKS_URL: z.string().url().optional(),
    SSO_CLIENT_ID: z.string().min(1).optional(),
    SSO_CLIENT_SECRET: z.string().min(32).optional(),
    SSO_REDIRECT_URI: z.string().url().optional(),
    SSO_RESOURCE: z.string().url().optional(),
    SSO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(15_000).default(5_000),
    HUB_ORIGIN: z.string().url().default("http://localhost:5174"),
    HUB_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(28_800).default(28_800),
    API_ORIGIN: z.string().url().default("http://localhost:8080"),
    API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(15_000).default(5_000),
    STATUS_API_URL: z.string().url().default("https://status.legacyhosting.xyz/api/v1/status"),
    SERVICE_HEALTH_TARGETS: z.string().default(defaultTargets),
    SERVICE_HEALTH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(15_000)
      .default(5_000),
    DIGITALOCEAN_TOKEN: z.string().min(32).regex(/^\S+$/).optional(),
    HUB_SETTINGS_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    HUB_SETTINGS_FILE: z.string().min(1).default("./data/settings.enc.json"),
    DIGITALOCEAN_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(15_000)
      .default(5_000),
    DIGITALOCEAN_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(900_000)
      .default(120_000),
    DIGITALOCEAN_METRIC_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(600)
      .max(86_400)
      .default(900),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;
    for (const field of [
      "SSO_ISSUER",
      "SSO_JWKS_URL",
      "SSO_CLIENT_ID",
      "SSO_CLIENT_SECRET",
      "SSO_REDIRECT_URI",
      "SSO_RESOURCE",
      "HUB_SETTINGS_KEY",
    ] as const) {
      if (!value[field]) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required in production`,
        });
      }
    }
    if (value.HOST !== "127.0.0.1") {
      context.addIssue({
        code: "custom",
        path: ["HOST"],
        message: "LH-Hub must listen on the local reverse-proxy interface",
      });
    }
    const apiOrigin = new URL(value.API_ORIGIN);
    const statusApiUrl = new URL(value.STATUS_API_URL);
    if (
      apiOrigin.protocol !== "https:" ||
      apiOrigin.pathname !== "/" ||
      apiOrigin.search ||
      apiOrigin.hash ||
      apiOrigin.username ||
      apiOrigin.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["API_ORIGIN"],
        message: "API_ORIGIN must be a credential-free HTTPS origin in production",
      });
    }
    if (
      statusApiUrl.protocol !== "https:" ||
      statusApiUrl.pathname !== "/api/v1/status" ||
      statusApiUrl.search ||
      statusApiUrl.hash ||
      statusApiUrl.username ||
      statusApiUrl.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["STATUS_API_URL"],
        message: "STATUS_API_URL must be a credential-free HTTPS status endpoint in production",
      });
    }
    if (value.DIGITALOCEAN_TOKEN?.includes("replace-with")) {
      context.addIssue({
        code: "custom",
        path: ["DIGITALOCEAN_TOKEN"],
        message: "DIGITALOCEAN_TOKEN must be a real scoped token",
      });
    }
    if (
      !value.SSO_ISSUER ||
      !value.SSO_JWKS_URL ||
      !value.SSO_REDIRECT_URI ||
      !value.SSO_RESOURCE
    ) return;
    const issuer = new URL(value.SSO_ISSUER);
    const jwks = new URL(value.SSO_JWKS_URL);
    const hubOrigin = new URL(value.HUB_ORIGIN);
    const redirect = new URL(value.SSO_REDIRECT_URI);
    const resource = new URL(value.SSO_RESOURCE);
    if (issuer.protocol !== "https:" || jwks.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        path: ["SSO_ISSUER"],
        message: "SSO endpoints must use HTTPS in production",
      });
    }
    if (jwks.origin !== issuer.origin) {
      context.addIssue({
        code: "custom",
        path: ["SSO_JWKS_URL"],
        message: "SSO_JWKS_URL must use the configured issuer origin",
      });
    }
    if (resource.origin !== hubOrigin.origin) {
      context.addIssue({
        code: "custom",
        path: ["SSO_RESOURCE"],
        message: "SSO_RESOURCE must identify the Hub origin",
      });
    }
    if (
      hubOrigin.protocol !== "https:" ||
      redirect.origin !== hubOrigin.origin ||
      redirect.pathname !== "/auth/callback" ||
      redirect.search ||
      redirect.hash
    ) {
      context.addIssue({
        code: "custom",
        path: ["SSO_REDIRECT_URI"],
        message: "SSO redirect must be the HTTPS Hub /auth/callback URL",
      });
    }
  });

const healthTargetSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(2).max(80),
  url: z.string().url(),
});

export type HealthTarget = z.infer<typeof healthTargetSchema>;
export const env = schema.parse(process.env);

function parseHealthTargets(raw: string): HealthTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SERVICE_HEALTH_TARGETS must be valid JSON");
  }
  const targets = z.array(healthTargetSchema).min(1).max(20).parse(parsed);
  if (env.NODE_ENV === "production") {
    for (const target of targets) {
      if (!target.url.startsWith("https://")) {
        throw new Error("Production health targets must use HTTPS");
      }
    }
  }
  if (new Set(targets.map((target) => target.key)).size !== targets.length) {
    throw new Error("SERVICE_HEALTH_TARGETS keys must be unique");
  }
  return targets;
}

export const healthTargets = parseHealthTargets(env.SERVICE_HEALTH_TARGETS);
