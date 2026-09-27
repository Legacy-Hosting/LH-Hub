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

const claimsSchema = z.object({
  sub: z.string().min(1),
  name: z.string().min(1).max(160).optional(),
  email: z.string().email().optional(),
  roles: z.array(z.enum(staffRoles)).default([]),
});

export type HubIdentity = z.infer<typeof claimsSchema>;
export type TokenVerifier = (token: string) => Promise<unknown>;

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
