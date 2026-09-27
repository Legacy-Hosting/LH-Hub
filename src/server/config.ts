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
    SERVICE_HEALTH_TARGETS: z.string().default(defaultTargets),
    SERVICE_HEALTH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(15_000)
      .default(5_000),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;
    for (const field of ["SSO_ISSUER", "SSO_JWKS_URL"] as const) {
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
