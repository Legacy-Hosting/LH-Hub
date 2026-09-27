import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

export const staffRoles = [
  "founder",
  "management",
  "platform_admin",
  "developer",
  "infrastructure",
  "support",
  "sales",
] as const;

export const hubCapabilities = [
  "services:read",
  "infrastructure:read",
  "operations:read",
  "support:read",
  "sales:read",
  "audit:read",
  "discord:manage",
  "maintenance:write",
  "settings:write",
] as const;

export type StaffRole = (typeof staffRoles)[number];
export type HubCapability = (typeof hubCapabilities)[number];

const roleCapabilities: Record<StaffRole, readonly HubCapability[]> = {
  founder: hubCapabilities,
  management: hubCapabilities.filter((capability) => capability !== "settings:write"),
  platform_admin: hubCapabilities,
  developer: ["services:read", "infrastructure:read", "operations:read"],
  infrastructure: ["services:read", "infrastructure:read", "operations:read", "maintenance:write"],
  support: ["services:read", "support:read", "audit:read"],
  sales: ["services:read", "sales:read"],
};

const claimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1).max(160).optional(),
  email: z.string().email().optional(),
  roles: z.array(z.enum(staffRoles)).default([]),
});

export type HubIdentity = z.infer<typeof claimsSchema>;
export type TokenVerifier = (token: string) => Promise<unknown>;
export type LogoutTokenIdentity = { subject: string; eventId: string };
export type LogoutTokenVerifier = (token: string) => Promise<LogoutTokenIdentity>;

const logoutEvent = "http://schemas.openid.net/event/backchannel-logout";

export function readBearerToken(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function authorizeClaims(input: unknown): HubIdentity | null {
  const parsed = claimsSchema.safeParse(input);
  if (!parsed.success || parsed.data.roles.length === 0) return null;
  return parsed.data;
}

export function capabilitiesFor(identity: Pick<HubIdentity, "roles">) {
  return Array.from(
    new Set(identity.roles.flatMap((role) => roleCapabilities[role])),
  );
}

export function hasCapability(
  identity: Pick<HubIdentity, "roles">,
  capability: HubCapability,
) {
  return capabilitiesFor(identity).includes(capability);
}

export function createOidcTokenVerifier(options: {
  issuer: string;
  audience: string;
  jwksUrl: string;
}): TokenVerifier {
  const keySet = createRemoteJWKSet(new URL(options.jwksUrl));
  return async (token) => {
    const result = await jwtVerify(token, keySet, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ["ES256", "RS256"],
    });
    return result.payload satisfies JWTPayload;
  };
}

export function createOidcLogoutTokenVerifier(options: {
  issuer: string;
  audience: string;
  jwksUrl: string;
}): LogoutTokenVerifier {
  const keySet = createRemoteJWKSet(new URL(options.jwksUrl));
  return async (token) => {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: ["ES256"],
      maxTokenAge: "2 minutes",
      clockTolerance: 5,
    });
    const events = payload.events;
    if (
      !events ||
      typeof events !== "object" ||
      Array.isArray(events) ||
      !(logoutEvent in events) ||
      "nonce" in payload ||
      typeof payload.sub !== "string" ||
      payload.sub.length < 1 ||
      payload.sub.length > 255 ||
      typeof payload.jti !== "string" ||
      payload.jti.length < 16 ||
      payload.jti.length > 255
    ) {
      throw new Error("invalid_logout_token");
    }
    return { subject: payload.sub, eventId: payload.jti };
  };
}
