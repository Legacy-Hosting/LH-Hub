import { z } from "zod";
import type { FetchImplementation } from "./service-health.js";

const auditEventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  team: z.object({ id: z.string().uuid(), name: z.string().min(1).max(160) }).nullable(),
  actor: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(160),
    email: z.string().email(),
  }).nullable(),
  product: z.string().min(1).max(50),
  action: z.string().min(1).max(120),
  resource: z.object({
    type: z.string().min(1).max(80),
    id: z.string().max(191).nullable(),
  }).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

const pageSchema = z.object({
  data: z.object({
    events: z.array(auditEventSchema).max(100),
    nextCursor: z.string().max(1_024).nullable(),
  }),
});

export type AuditPage = z.infer<typeof pageSchema>["data"];
export type AuditReader = (input: {
  accessToken: string;
  cursor?: string;
  limit?: number;
}) => Promise<AuditPage>;

export function createAuditReader(options: {
  apiOrigin: string;
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
}): AuditReader {
  const apiOrigin = new URL(options.apiOrigin);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return async (input) => {
    const url = new URL("/api/v1/hub/audit-events", apiOrigin);
    url.searchParams.set("limit", String(input.limit ?? 50));
    if (input.cursor) url.searchParams.set("cursor", input.cursor);
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`audit_api_${response.status}`);
    return pageSchema.parse(await response.json()).data;
  };
}
