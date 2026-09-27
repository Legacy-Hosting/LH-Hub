import { z } from "zod";
import type { FetchImplementation } from "./service-health.js";

const dropletSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  memory: z.number().nonnegative(),
  vcpus: z.number().int().nonnegative(),
  disk: z.number().nonnegative(),
  status: z.string().min(1),
  region: z.object({ slug: z.string().min(1) }),
});

const dropletListSchema = z.object({
  droplets: z.array(dropletSchema),
  links: z.object({
    pages: z.object({ next: z.string().url().optional() }).optional(),
  }).optional(),
});

const metricResponseSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("matrix"),
    result: z.array(z.object({
      metric: z.record(z.string(), z.string()),
      values: z.array(z.tuple([z.number(), z.union([z.string(), z.number()])])),
    })),
  }),
});

type MetricResponse = z.infer<typeof metricResponseSchema>;
type Droplet = z.infer<typeof dropletSchema>;

export type InfrastructureDroplet = {
  name: string;
  status: string;
  region: string;
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  metricsState: "ready" | "partial" | "unavailable";
  metricsUpdatedAt: string | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  load1: number | null;
  publicBandwidthInMbps: number | null;
  publicBandwidthOutMbps: number | null;
};

export type InfrastructureSnapshot = {
  state: "ready" | "stale" | "unavailable" | "not_configured";
  fetchedAt: string | null;
  droplets: InfrastructureDroplet[];
  error?: "provider_unavailable";
};

export type InfrastructureReader = () => Promise<InfrastructureSnapshot>;

type ReaderOptions = {
  token?: string;
  timeoutMs: number;
  cacheMs: number;
  metricWindowSeconds: number;
  fetchImplementation?: FetchImplementation;
  apiBaseUrl?: string;
  now?: () => number;
  concurrency?: number;
};

function clampPercentage(value: number) {
  return Math.min(100, Math.max(0, value));
}

function rounded(value: number | null, digits = 1) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function points(response: MetricResponse | null) {
  if (!response) return [];
  return response.data.result.flatMap((series) =>
    series.values.flatMap(([timestamp, rawValue]) => {
      const value = Number(rawValue);
      return Number.isFinite(value) ? [{ timestamp, value, metric: series.metric }] : [];
    }),
  );
}

function latestValue(
  response: MetricResponse | null,
  predicate: (metric: Record<string, string>) => boolean = () => true,
) {
  const candidates = points(response).filter((point) => predicate(point.metric));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, point) =>
    point.timestamp > latest.timestamp ? point : latest
  );
}

function averageRecent(response: MetricResponse | null, count = 5) {
  const candidates = points(response)
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, count);
  if (candidates.length === 0) return null;
  return candidates.reduce((total, point) => total + point.value, 0) / candidates.length;
}

function cpuPercentage(response: MetricResponse | null) {
  if (!response) return null;
  let totalDelta = 0;
  let idleDelta = 0;
  for (const series of response.data.result) {
    const valid = series.values
      .map(([timestamp, rawValue]) => ({ timestamp, value: Number(rawValue) }))
      .filter((point) => Number.isFinite(point.value))
      .sort((left, right) => left.timestamp - right.timestamp);
    const first = valid[0];
    const last = valid.at(-1);
    if (!first || !last || last.timestamp <= first.timestamp) continue;
    const delta = last.value - first.value;
    if (delta < 0) continue;
    totalDelta += delta;
    if (series.metric.mode === "idle") idleDelta += delta;
  }
  if (totalDelta <= 0) return null;
  return clampPercentage(((totalDelta - idleDelta) / totalDelta) * 100);
}

function newestTimestamp(responses: Array<MetricResponse | null>) {
  const timestamps = responses.flatMap((response) =>
    points(response).map((point) => point.timestamp)
  );
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps) * 1_000).toISOString();
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await mapper(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function createDigitalOceanInfrastructureReader(
  options: ReaderOptions,
): InfrastructureReader {
  if (!options.token) {
    return async () => ({ state: "not_configured", fetchedAt: null, droplets: [] });
  }

  const token = options.token;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.digitalocean.com";
  const now = options.now ?? Date.now;
  const concurrency = options.concurrency ?? 4;
  let cached: { expiresAt: number; value: InfrastructureSnapshot } | null = null;
  let pending: Promise<InfrastructureSnapshot> | null = null;

  async function request(path: string) {
    const url = new URL(path, apiBaseUrl);
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`digitalocean_http_${response.status}`);
    return response.json() as Promise<unknown>;
  }

  async function listDroplets() {
    const droplets: Droplet[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = dropletListSchema.parse(
        await request(`/v2/droplets?per_page=200&page=${page}`),
      );
      droplets.push(...response.droplets);
      if (!response.links?.pages?.next) return droplets;
    }
    throw new Error("digitalocean_pagination_limit");
  }

  async function metric(
    endpoint: string,
    dropletId: number,
    start: number,
    end: number,
    extra: Record<string, string> = {},
  ) {
    const query = new URLSearchParams({
      host_id: String(dropletId),
      start: String(start),
      end: String(end),
      ...extra,
    });
    return metricResponseSchema.parse(
      await request(`/v2/monitoring/metrics/droplet/${endpoint}?${query}`),
    );
  }

  async function dropletSnapshot(droplet: Droplet): Promise<InfrastructureDroplet> {
    const common = {
      name: droplet.name,
      status: droplet.status,
      region: droplet.region.slug,
      vcpus: droplet.vcpus,
      memoryMiB: droplet.memory,
      diskGiB: droplet.disk,
    };
    if (droplet.status !== "active") {
      return {
        ...common,
        metricsState: "unavailable",
        metricsUpdatedAt: null,
        cpuPercent: null,
        memoryPercent: null,
        diskPercent: null,
        load1: null,
        publicBandwidthInMbps: null,
        publicBandwidthOutMbps: null,
      };
    }

    const end = Math.floor(now() / 1_000);
    const start = end - options.metricWindowSeconds;
    const requests = [
      metric("cpu", droplet.id, start, end),
      metric("memory_total", droplet.id, start, end),
      metric("memory_free", droplet.id, start, end),
      metric("memory_cached", droplet.id, start, end),
      metric("filesystem_size", droplet.id, start, end),
      metric("filesystem_free", droplet.id, start, end),
      metric("load_1", droplet.id, start, end),
      metric("bandwidth", droplet.id, start, end, {
        interface: "public",
        direction: "inbound",
      }),
      metric("bandwidth", droplet.id, start, end, {
        interface: "public",
        direction: "outbound",
      }),
    ];
    const settled = await Promise.allSettled(requests);
    const responses = settled.map((result) =>
      result.status === "fulfilled" ? result.value : null
    );
    const successful = responses.filter(Boolean).length;
    const [cpu, memoryTotal, memoryFree, memoryCached, filesystemSize,
      filesystemFree, load1, bandwidthIn, bandwidthOut] = responses;
    const totalMemory = latestValue(memoryTotal ?? null)?.value ?? null;
    const freeMemory = latestValue(memoryFree ?? null)?.value ?? null;
    const cachedMemory = latestValue(memoryCached ?? null)?.value ?? null;
    const rootSize = latestValue(
      filesystemSize ?? null,
      (labels) => labels.mountpoint === "/",
    )?.value ?? null;
    const rootFree = latestValue(
      filesystemFree ?? null,
      (labels) => labels.mountpoint === "/",
    )?.value ?? null;

    return {
      ...common,
      metricsState: successful === requests.length
        ? "ready"
        : successful === 0 ? "unavailable" : "partial",
      metricsUpdatedAt: newestTimestamp(responses),
      cpuPercent: rounded(cpuPercentage(cpu ?? null)),
      memoryPercent: totalMemory && freeMemory !== null && cachedMemory !== null
        ? rounded(clampPercentage(
          ((totalMemory - freeMemory - cachedMemory) / totalMemory) * 100,
        ))
        : null,
      diskPercent: rootSize && rootFree !== null
        ? rounded(clampPercentage(((rootSize - rootFree) / rootSize) * 100))
        : null,
      load1: rounded(latestValue(load1 ?? null)?.value ?? null, 2),
      publicBandwidthInMbps: rounded(averageRecent(bandwidthIn ?? null), 2),
      publicBandwidthOutMbps: rounded(averageRecent(bandwidthOut ?? null), 2),
    };
  }

  async function refresh(): Promise<InfrastructureSnapshot> {
    try {
      const droplets = await listDroplets();
      const values = await mapWithConcurrency(
        droplets.sort((left, right) => left.name.localeCompare(right.name)),
        concurrency,
        dropletSnapshot,
      );
      const value: InfrastructureSnapshot = {
        state: "ready",
        fetchedAt: new Date(now()).toISOString(),
        droplets: values,
      };
      cached = { expiresAt: now() + options.cacheMs, value };
      return value;
    } catch {
      if (cached) {
        const stale: InfrastructureSnapshot = {
          ...cached.value,
          state: "stale",
          error: "provider_unavailable",
        };
        cached = {
          expiresAt: now() + Math.min(options.cacheMs, 30_000),
          value: stale,
        };
        return stale;
      }
      return {
        state: "unavailable",
        fetchedAt: null,
        droplets: [],
        error: "provider_unavailable",
      };
    }
  }

  return async () => {
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!pending) {
      pending = refresh().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
