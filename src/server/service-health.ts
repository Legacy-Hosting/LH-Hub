import type { HealthTarget } from "./config.js";

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ServiceHealth = {
  key: string;
  name: string;
  state: "operational" | "unavailable";
  latencyMs: number | null;
  checkedAt: string;
};

export function createServiceHealthReader(options: {
  targets: HealthTarget[];
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
  cacheMs?: number;
}) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const cacheMs = options.cacheMs ?? 15_000;
  let cached: { expiresAt: number; value: ServiceHealth[] } | null = null;

  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await Promise.all(
      options.targets.map(async (target): Promise<ServiceHealth> => {
        const startedAt = performance.now();
        try {
          const response = await fetchImplementation(target.url, {
            method: "GET",
            headers: { accept: "application/json,text/html;q=0.8" },
            signal: AbortSignal.timeout(options.timeoutMs),
            redirect: "follow",
          });
          return {
            key: target.key,
            name: target.name,
            state: response.ok ? "operational" : "unavailable",
            latencyMs: Math.round(performance.now() - startedAt),
            checkedAt: new Date().toISOString(),
          };
        } catch {
          return {
            key: target.key,
            name: target.name,
            state: "unavailable",
            latencyMs: null,
            checkedAt: new Date().toISOString(),
          };
        }
      }),
    );
    cached = { expiresAt: now + cacheMs, value };
    return value;
  };
}
