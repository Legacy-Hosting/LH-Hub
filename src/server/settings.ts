import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { FetchImplementation } from "./service-health.js";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/);
const channelIdsSchema = z.array(snowflakeSchema).max(20);
const encryptedSecretSchema = z.object({
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

const githubRepositoryNameSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(255);
const githubRepositorySettingSchema = z.object({
  fullName: githubRepositoryNameSchema,
  enabled: z.boolean(),
  channelIds: channelIdsSchema,
});
const githubRepositorySchema = z.object({
  fullName: githubRepositoryNameSchema,
  url: z.string().url(),
  defaultBranch: z.string().min(1).max(255),
  private: z.boolean(),
  lastEventAt: z.string().datetime().optional(),
});
const githubPersonSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().max(320).nullable().optional(),
});
const githubCommitSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{40}$/i),
  message: z.string().max(20_000),
  timestamp: z.string(),
  url: z.string().url(),
  author: z.object({
    name: z.string().max(255).nullable().optional(),
    email: z.string().max(320).nullable().optional(),
    username: z.string().max(255).nullable().optional(),
  }).nullable().optional(),
  committer: z.object({
    name: z.string().max(255).nullable().optional(),
    email: z.string().max(320).nullable().optional(),
    username: z.string().max(255).nullable().optional(),
  }).nullable().optional(),
  distinct: z.boolean().optional(),
});
export const githubPushEventSchema = z.object({
  deliveryId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  repository: githubRepositorySchema.omit({ lastEventAt: true }),
  ref: z.string().max(500),
  branch: z.string().min(1).max(255),
  before: z.string().regex(/^[a-f0-9]{40}$/i),
  after: z.string().regex(/^[a-f0-9]{40}$/i),
  compareUrl: z.string().url(),
  created: z.boolean(),
  deleted: z.boolean(),
  forced: z.boolean(),
  pusher: githubPersonSchema,
  sender: z.object({
    login: z.string().min(1).max(255),
    avatar_url: z.string().url().optional(),
    html_url: z.string().url().optional(),
  }),
  headCommit: githubCommitSchema.nullable(),
  commits: z.array(githubCommitSchema).max(50),
  receivedAt: z.string().datetime(),
  channelIds: channelIdsSchema.optional(),
});
const githubSettingsSchema = z.object({
  visibleOwner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).or(z.literal("")).default(""),
  repositories: z.array(githubRepositorySettingSchema).default([]),
  knownRepositories: z.array(githubRepositorySchema).default([]),
  pendingEvents: z.array(githubPushEventSchema.extend({ channelIds: channelIdsSchema })).default([]),
}).default({ visibleOwner: "", repositories: [], knownRepositories: [], pendingEvents: [] });

const statusComponentSchema = z.object({
  server: z.string().trim().regex(/^[A-Za-z0-9.-]{1,120}$/),
  componentKey: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  visible: z.boolean(),
  primary: z.boolean(),
  displayName: z.string().trim().min(2).max(80),
  datacenter: z.string().trim().min(2).max(80),
  service: z.string().trim().min(2).max(80),
  number: z.string().trim().regex(/^[A-Za-z0-9-]{1,12}$/),
  primaryOrder: z.number().int().min(0).max(999),
  publicUrl: z.string().url().or(z.literal("")),
  originFqdn: z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
});
const statusComponentInputSchema = statusComponentSchema.omit({
  componentKey: true,
  primaryOrder: true,
});
const statusSettingsSchema = z.object({
  components: z.array(statusComponentSchema).max(100).default([]),
}).default({ components: [] });

export const discordServiceDefinitions = [
  { key: "api", name: "API", server: "ams3-api-01", url: "https://api.legacyhosting.xyz/health" },
  { key: "sso", name: "SSO", server: "ams3-sso-01", url: "https://auth.legacyhosting.xyz/health" },
  { key: "hub", name: "Staff Hub", server: "ams3-hub-01", url: "https://hub.legacyhosting.xyz/health" },
  { key: "panel", name: "Web Panel", server: "ams3-panel-01", url: "https://panel.legacyhosting.xyz/" },
  { key: "status", name: "Status", server: "fra1-status-01", url: "https://status.legacyhosting.xyz/health" },
] as const;

export const discordEventDefinitions = [
  { key: "operational", name: "Operational / recovery", description: "A service has recovered and is operational." },
  { key: "degraded", name: "Degraded", description: "A service is responding slowly or with reduced capacity." },
  { key: "outage", name: "Outage", description: "A service is unavailable." },
  { key: "maintenance", name: "Maintenance", description: "Scheduled maintenance has started." },
  { key: "maintenanceComplete", name: "Maintenance complete", description: "Scheduled maintenance has been completed." },
] as const;

export const discordAssetUrls = {
  operational: "https://legacyhosting.xyz/assets/icons/Up.png",
  outage: "https://legacyhosting.xyz/assets/icons/Down.png",
  degraded: "https://legacyhosting.xyz/assets/icons/Maintainance_Emergency.png",
  maintenance: "https://legacyhosting.xyz/assets/icons/Maintainance.png",
  maintenanceComplete: "https://legacyhosting.xyz/assets/icons/Maintainance_Finished.png",
  logo: "https://legacyhosting.xyz/assets/icons/LegacyHostingLogo.png",
  birthday: "https://legacyhosting.xyz/assets/icons/Birthday.png",
  christmas: "https://legacyhosting.xyz/assets/icons/Christmas.png",
  newyear: "https://legacyhosting.xyz/assets/icons/Newyear.png",
} as const;

const announcementDefaults = {
  birthday: {
    key: "birthday",
    title: "Legacy Hosting birthday",
    message: "Legacy Hosting is {years} years old today. Thank you for being part of our community!",
    month: 12,
    day: 13,
    imageUrl: discordAssetUrls.birthday,
  },
  christmas: {
    key: "christmas",
    title: "Merry Christmas",
    message: "Legacy Hosting wishes everyone a very merry Christmas!",
    month: 12,
    day: 24,
    imageUrl: discordAssetUrls.christmas,
  },
  newyear: {
    key: "newyear",
    title: "Happy New Year",
    message: "Legacy Hosting wishes everyone a happy new year!",
    month: 1,
    day: 1,
    imageUrl: discordAssetUrls.newyear,
  },
} as const;

const announcementKeySchema = z.enum(["birthday", "christmas", "newyear"]);
const eventKeySchema = z.enum(["operational", "degraded", "outage", "maintenance", "maintenanceComplete"]);
const discordServiceKeySchema = z.enum(["api", "sso", "hub", "panel", "status"]);
const maintenanceImpactSchema = z.enum(["none", "minor", "major", "critical"]);
const announcementSchema = z.object({
  key: announcementKeySchema,
  enabled: z.boolean(),
  title: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(2_000),
  channelIds: channelIdsSchema,
  lastSentYear: z.number().int().min(2017).max(9999).optional(),
});
const maintenanceSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const item = value as Record<string, unknown>;
  if (Array.isArray(item.targetKeys) || typeof item.targetKey !== "string") return value;
  return { ...item, targetKeys: [item.targetKey] };
}, z.object({
  id: z.string().regex(/^maintenance-[a-f0-9]{24}$/),
  targetKeys: z.array(discordServiceKeySchema).min(1).max(discordServiceKeySchema.options.length),
  impact: maintenanceImpactSchema.default("none"),
  title: z.string().trim().min(3).max(120),
  message: z.string().trim().min(3).max(1_000),
  scheduledFor: z.string().datetime(),
  scheduledUntil: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  cancelledAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}));
const discordSettingsSchema = z.object({
  botToken: encryptedSecretSchema.optional(),
  guildId: snowflakeSchema.optional(),
  channels: z.array(z.object({ id: snowflakeSchema, name: z.string().min(1).max(100) })).max(500).default([]),
  bot: z.object({
    id: snowflakeSchema,
    username: z.string().min(1).max(100),
    lastSeenAt: z.string().datetime(),
  }).optional(),
  serviceChannels: z.record(z.string(), channelIdsSchema).default({}),
  eventChannels: z.record(z.string(), channelIdsSchema).default({}),
  testChannelId: snowflakeSchema.optional(),
  announcements: z.array(announcementSchema).max(3).default([]),
  maintenance: z.array(maintenanceSchema).max(500).default([]),
}).default({ channels: [], serviceChannels: {}, eventChannels: {}, announcements: [], maintenance: [] });

const storedSettingsSchema = z.object({
  version: z.literal(1),
  digitalOceanToken: encryptedSecretSchema.optional(),
  discord: discordSettingsSchema.optional(),
  github: githubSettingsSchema.optional(),
  status: statusSettingsSchema.optional(),
});
type StoredSettings = z.infer<typeof storedSettingsSchema>;
type AnnouncementKey = z.infer<typeof announcementKeySchema>;
type DiscordTestAnnouncement = {
  key: AnnouncementKey;
  title: string;
  message: string;
};

export type HubSettingsService = {
  digitalOceanToken(): Promise<string | undefined>;
  digitalOceanStatus(): Promise<{ configured: boolean; source: "stored" | "environment" | "none" }>;
  saveDigitalOceanToken(token: string): Promise<void>;
  clearDigitalOceanToken(): Promise<void>;
  statusComponentAdminView(servers?: Array<{ name: string; region: string }>): Promise<unknown>;
  saveStatusComponents(
    input: Array<Omit<z.infer<typeof statusComponentSchema>, "componentKey" | "primaryOrder">>,
    servers: Array<{ name: string; region: string }>,
  ): Promise<void>;
  publicStatusComponents(): Promise<unknown[]>;
  discordAdminView(): Promise<unknown>;
  maintenanceView(): Promise<unknown>;
  saveDiscordCredentials(input: { botToken?: string; guildId: string }): Promise<void>;
  saveDiscordConfiguration(input: {
    serviceChannels: Record<string, string[]>;
    eventChannels: Record<string, string[]>;
    testChannelId?: string | undefined;
    announcements: Array<{ key: AnnouncementKey; enabled: boolean; title: string; message: string; channelIds: string[] }>;
  }): Promise<void>;
  sendDiscordTest(channelId: string, announcements?: DiscordTestAnnouncement[]): Promise<number>;
  createMaintenance(input: {
    targetKeys: Array<z.infer<typeof discordServiceKeySchema>>;
    impact: z.infer<typeof maintenanceImpactSchema>;
    title: string;
    message: string;
    scheduledFor: string;
    scheduledUntil: string;
  }): Promise<void>;
  finishMaintenance(id: string, action: "complete" | "cancel"): Promise<boolean>;
  publicStatusEvents(): Promise<unknown[]>;
  discordBotConfiguration(): Promise<unknown | undefined>;
  reportDiscordPresence(input: {
    bot: { id: string; username: string };
    channels: Array<{ id: string; name: string }>;
  }): Promise<void>;
  recordAnnouncementSent(key: AnnouncementKey, year: number): Promise<void>;
  githubVisibilityView(repositories?: Array<z.infer<typeof githubRepositorySchema>>): Promise<unknown>;
  saveGithubVisibility(
    visibleOwner: string,
    repositories?: Array<z.infer<typeof githubRepositorySchema>>,
  ): Promise<void>;
  githubAdminView(repositories?: Array<z.infer<typeof githubRepositorySchema>>): Promise<unknown>;
  saveGithubConfiguration(input: Array<z.infer<typeof githubRepositorySettingSchema>>): Promise<void>;
  ingestGithubPush(input: z.infer<typeof githubPushEventSchema>): Promise<boolean>;
  githubPushEvents(limit?: number): Promise<Array<z.infer<typeof githubPushEventSchema>>>;
  acknowledgeGithubPushEvents(deliveryIds: string[]): Promise<void>;
};

function encrypt(value: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decrypt(value: z.infer<typeof encryptedSecretSchema>, key: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function normalizedDiscord(settings: StoredSettings) {
  return discordSettingsSchema.parse(settings.discord ?? {});
}

function normalizedGithub(settings: StoredSettings) {
  return githubSettingsSchema.parse(settings.github ?? {});
}

function normalizedStatus(settings: StoredSettings) {
  return statusSettingsSchema.parse(settings.status ?? {});
}

const knownStatusComponents: Record<string, Omit<z.infer<typeof statusComponentSchema>, "server">> = {
  "ams3-api-01": {
    componentKey: "api",
    visible: true,
    primary: true,
    displayName: "API",
    datacenter: "Amsterdam 3",
    service: "API",
    number: "01",
    primaryOrder: 0,
    publicUrl: "https://api.legacyhosting.xyz/health",
    originFqdn: "ams3.api-01.legacyh.fyi",
  },
  "ams3-sso-01": {
    componentKey: "sso",
    visible: true,
    primary: true,
    displayName: "SSO",
    datacenter: "Amsterdam 3",
    service: "SSO",
    number: "01",
    primaryOrder: 1,
    publicUrl: "https://auth.legacyhosting.xyz/health",
    originFqdn: "ams3.sso-01.legacyh.fyi",
  },
  "ams3-panel-01": {
    componentKey: "panel",
    visible: true,
    primary: true,
    displayName: "Web Panel",
    datacenter: "Amsterdam 3",
    service: "Web Panel",
    number: "01",
    primaryOrder: 2,
    publicUrl: "https://panel.legacyhosting.xyz/",
    originFqdn: "ams3.panel-01.legacyh.fyi",
  },
  "ams3-hub-01": {
    componentKey: "hub",
    visible: false,
    primary: false,
    displayName: "Staff Hub",
    datacenter: "Amsterdam 3",
    service: "Hub",
    number: "01",
    primaryOrder: 0,
    publicUrl: "https://hub.legacyhosting.xyz/health",
    originFqdn: "ams3.hub-01.legacyh.fyi",
  },
  "fra1-status-01": {
    componentKey: "status",
    visible: false,
    primary: false,
    displayName: "Public Status",
    datacenter: "Frankfurt 1",
    service: "Status",
    number: "01",
    primaryOrder: 0,
    publicUrl: "https://status.legacyhosting.xyz/health",
    originFqdn: "fra1.status-01.legacyh.fyi",
  },
};

const datacenterNames: Record<string, string> = {
  ams3: "Amsterdam 3",
  fra1: "Frankfurt 1",
  lon1: "London 1",
  nyc3: "New York 3",
  sfo3: "San Francisco 3",
  sgp1: "Singapore 1",
  syd1: "Sydney 1",
  tor1: "Toronto 1",
  blr1: "Bangalore 1",
};

function displayWord(value: string) {
  if (["api", "sso", "cdn", "dns"].includes(value.toLowerCase())) return value.toUpperCase();
  return value.split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : "").join(" ");
}

function componentKeyForServer(server: string) {
  const known = knownStatusComponents[server.toLowerCase()];
  if (known) return known.componentKey;
  const slug = server.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (slug.length <= 32) return slug;
  return `${slug.slice(0, 23)}-${createHash("sha256").update(server).digest("hex").slice(0, 8)}`;
}

function inferredStatusComponent(server: string, region: string) {
  const known = knownStatusComponents[server.toLowerCase()];
  if (known) return { server, ...known };
  const parts = server.toLowerCase().split("-").filter(Boolean);
  const structured = parts.length >= 3;
  const datacenterCode = structured ? parts[0]! : region;
  const numberCandidate = structured ? parts.at(-1)! : "01";
  const number = /^[a-z0-9-]{1,12}$/i.test(numberCandidate) ? numberCandidate : "01";
  const serviceCode = structured ? parts.slice(1, -1).join("-") : parts.join("-") || "server";
  const service = displayWord(serviceCode);
  return {
    server,
    componentKey: componentKeyForServer(server),
    visible: false,
    primary: false,
    displayName: `${service} ${number}`,
    datacenter: datacenterNames[datacenterCode] ?? displayWord(datacenterCode),
    service,
    number,
    primaryOrder: 0,
    publicUrl: "",
    originFqdn: directHostname(server),
  } satisfies z.infer<typeof statusComponentSchema>;
}

function defaultStatusComponents() {
  return Object.entries(knownStatusComponents)
    .filter(([, component]) => component.visible)
    .map(([server, component]) => ({ server, ...component }));
}

function configuredStatusComponents(settings: StoredSettings) {
  const status = normalizedStatus(settings);
  return status.components.length > 0 ? status.components : defaultStatusComponents();
}

function directHostname(server: string) {
  const parts = server.toLowerCase().split("-").filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}.${parts.slice(1).join("-")}.legacyh.fyi`;
  const fallback = server.toLowerCase().replaceAll(/[^a-z0-9-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "server";
  return `${fallback}.legacyh.fyi`;
}

function validatedPublicUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("invalid_status_public_url");
  }
  return url.toString();
}

function statusComponentSort(
  left: z.infer<typeof statusComponentSchema>,
  right: z.infer<typeof statusComponentSchema>,
) {
  if (left.primary !== right.primary) return left.primary ? -1 : 1;
  if (left.primary) return left.primaryOrder - right.primaryOrder;
  return left.datacenter.localeCompare(right.datacenter, undefined, { numeric: true })
    || left.service.localeCompare(right.service, undefined, { numeric: true })
    || left.number.localeCompare(right.number, undefined, { numeric: true });
}

function githubOwner(fullName: string) {
  return fullName.slice(0, fullName.indexOf("/"));
}

function githubOwners(
  github: z.infer<typeof githubSettingsSchema>,
  repositories: Array<z.infer<typeof githubRepositorySchema>>,
) {
  const owners = new Map<string, string>();
  for (const repository of [
    ...github.knownRepositories,
    ...repositories,
    ...github.repositories.map((item) => ({
      fullName: item.fullName,
      url: `https://github.com/${item.fullName}`,
      defaultBranch: "main",
      private: true,
    })),
  ]) {
    const owner = githubOwner(repository.fullName);
    if (owner) owners.set(owner.toLowerCase(), owner);
  }
  if (github.visibleOwner) owners.set(github.visibleOwner.toLowerCase(), github.visibleOwner);
  return Array.from(owners.values()).sort((left, right) => left.localeCompare(right));
}

function normalizedAnnouncements(discord: z.infer<typeof discordSettingsSchema>) {
  const stored = new Map(discord.announcements.map((item) => [item.key, item]));
  return Object.values(announcementDefaults).map((defaults) => ({
    ...defaults,
    enabled: stored.get(defaults.key)?.enabled ?? true,
    title: stored.get(defaults.key)?.title ?? defaults.title,
    message: stored.get(defaults.key)?.message ?? defaults.message,
    channelIds: stored.get(defaults.key)?.channelIds ?? [],
    ...(stored.get(defaults.key)?.lastSentYear
      ? { lastSentYear: stored.get(defaults.key)!.lastSentYear }
      : {}),
  }));
}

function maintenanceStatus(item: z.infer<typeof maintenanceSchema>, now = Date.now()) {
  if (item.cancelledAt) return "cancelled" as const;
  if (item.completedAt || now >= Date.parse(item.scheduledUntil)) return "completed" as const;
  if (now >= Date.parse(item.scheduledFor)) return "in_progress" as const;
  return "scheduled" as const;
}

export function createHubSettingsService(options: {
  file: string;
  encryptionKey: string;
  environmentDigitalOceanToken?: string;
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
  digitalOceanApiUrl?: string;
  discordApiUrl?: string;
}): HubSettingsService {
  if (!/^[a-f0-9]{64}$/i.test(options.encryptionKey)) {
    throw new Error("HUB_SETTINGS_KEY must be a 32-byte hexadecimal key");
  }
  const key = Buffer.from(options.encryptionKey, "hex");
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let mutationQueue = Promise.resolve();

  async function readSettings(): Promise<StoredSettings> {
    try {
      return storedSettingsSchema.parse(JSON.parse(await readFile(options.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
      throw error;
    }
  }

  async function writeSettings(settings: StoredSettings) {
    const directory = dirname(options.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${options.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(storedSettingsSchema.parse(settings))}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, options.file);
      await chmod(options.file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function mutate(mutator: (settings: StoredSettings) => StoredSettings | Promise<StoredSettings>) {
    mutationQueue = mutationQueue.catch(() => undefined).then(async () => {
      await writeSettings(await mutator(await readSettings()));
    });
    await mutationQueue;
  }

  async function storedToken() {
    const encrypted = (await readSettings()).digitalOceanToken;
    return encrypted ? decrypt(encrypted, key) : undefined;
  }

  async function discordView(includeToken: boolean) {
    const settings = await readSettings();
    const discord = normalizedDiscord(settings);
    const token = discord.botToken ? decrypt(discord.botToken, key) : undefined;
    return {
      configured: Boolean(token && discord.guildId),
      tokenConfigured: Boolean(token),
      guildId: discord.guildId ?? "",
      bot: discord.bot ?? null,
      connected: Boolean(discord.bot && Date.now() - Date.parse(discord.bot.lastSeenAt) < 120_000),
      channels: discord.channels,
      services: discordServiceDefinitions.map((service) => ({
        ...service,
        channelIds: discord.serviceChannels[service.key] ?? [],
      })),
      events: discordEventDefinitions.map((event) => ({
        ...event,
        channelIds: discord.eventChannels[event.key] ?? [],
      })),
      testChannelId: discord.testChannelId ?? "",
      announcements: normalizedAnnouncements(discord),
      maintenance: discord.maintenance
        .map((item) => ({ ...item, status: maintenanceStatus(item) }))
        .sort((left, right) => Date.parse(right.scheduledFor) - Date.parse(left.scheduledFor)),
      assets: discordAssetUrls,
      ...(includeToken && token ? { botToken: token } : {}),
    };
  }

  return {
    async digitalOceanToken() {
      return (await storedToken()) ?? options.environmentDigitalOceanToken;
    },
    async digitalOceanStatus() {
      const stored = await storedToken();
      return stored
        ? { configured: true, source: "stored" }
        : options.environmentDigitalOceanToken
          ? { configured: true, source: "environment" }
          : { configured: false, source: "none" };
    },
    async saveDigitalOceanToken(token) {
      const response = await fetchImplementation(
        new URL("/v2/account", options.digitalOceanApiUrl ?? "https://api.digitalocean.com"),
        {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );
      if (!response.ok) throw new Error("digitalocean_token_rejected");
      await mutate((current) => ({ ...current, digitalOceanToken: encrypt(token, key) }));
    },
    async clearDigitalOceanToken() {
      await mutate((current) => {
        if (!current.digitalOceanToken) return current;
        const { digitalOceanToken: _removed, ...remaining } = current;
        return remaining;
      });
    },
    async statusComponentAdminView(servers = []) {
      const settings = await readSettings();
      const configured = new Map(
        configuredStatusComponents(settings).map((component) => [component.server.toLowerCase(), component]),
      );
      const components = servers.map((server) => {
        const inferred = inferredStatusComponent(server.name, server.region);
        return configured.get(server.name.toLowerCase()) ?? inferred;
      }).sort(statusComponentSort);
      return {
        components,
        datacenters: Array.from(new Set(components.map((component) => component.datacenter))).sort(
          (left, right) => left.localeCompare(right, undefined, { numeric: true }),
        ),
        services: Array.from(new Set(components.map((component) => component.service))).sort(
          (left, right) => left.localeCompare(right, undefined, { numeric: true }),
        ),
      };
    },
    async saveStatusComponents(input, servers) {
      const components = z.array(statusComponentInputSchema).max(100).parse(input);
      const allowedServers = new Set(servers.map((server) => server.name.toLowerCase()));
      if (components.some((component) => !allowedServers.has(component.server.toLowerCase()))) {
        throw new Error("unknown_status_server");
      }
      if (new Set(components.map((component) => component.server.toLowerCase())).size !== components.length) {
        throw new Error("duplicate_status_server");
      }
      if (!components.some((component) => component.visible && component.publicUrl)) {
        throw new Error("status_component_required");
      }
      const current = new Map(
        configuredStatusComponents(await readSettings()).map((component) => [component.server.toLowerCase(), component]),
      );
      let primaryOrder = 0;
      const saved = components.map((component) => {
        if (component.visible && !component.publicUrl) throw new Error("status_public_url_required");
        return statusComponentSchema.parse({
          ...component,
          componentKey: current.get(component.server.toLowerCase())?.componentKey
            ?? componentKeyForServer(component.server),
          primaryOrder: component.primary ? primaryOrder++ : 0,
          publicUrl: component.publicUrl ? validatedPublicUrl(component.publicUrl) : "",
        });
      });
      if (new Set(saved.map((component) => component.componentKey)).size !== saved.length) {
        throw new Error("duplicate_status_component_key");
      }
      await mutate((settings) => ({
        ...settings,
        status: { components: saved },
      }));
    },
    async publicStatusComponents() {
      return configuredStatusComponents(await readSettings())
        .filter((component) => component.visible && component.publicUrl)
        .sort(statusComponentSort)
        .map((component) => ({
          key: component.componentKey,
          name: component.displayName,
          url: component.publicUrl,
          connectHostname: component.originFqdn,
          primary: component.primary,
          datacenter: component.datacenter,
          service: component.service,
          number: component.number,
          order: component.primaryOrder,
        }));
    },
    async discordAdminView() {
      return discordView(false);
    },
    async maintenanceView() {
      const view = await discordView(false) as {
        services: unknown;
        maintenance: unknown;
      };
      return { services: view.services, maintenance: view.maintenance };
    },
    async saveDiscordCredentials(input) {
      const current = await readSettings();
      const currentDiscord = normalizedDiscord(current);
      const token = input.botToken ?? (currentDiscord.botToken ? decrypt(currentDiscord.botToken, key) : undefined);
      if (!token) throw new Error("discord_token_required");
      const base = options.discordApiUrl ?? "https://discord.com";
      const headers = { accept: "application/json", authorization: `Bot ${token}` };
      const [bot, guild] = await Promise.all([
        fetchImplementation(new URL("/api/v10/users/@me", base), { headers, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs) }),
        fetchImplementation(new URL(`/api/v10/guilds/${input.guildId}`, base), { headers, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs) }),
      ]);
      if (!bot.ok || !guild.ok) throw new Error("discord_credentials_rejected");
      await mutate((settings) => {
        const discord = normalizedDiscord(settings);
        return {
          ...settings,
          discord: {
            ...discord,
            guildId: input.guildId,
            ...(input.botToken ? { botToken: encrypt(input.botToken, key) } : {}),
          },
        };
      });
    },
    async saveDiscordConfiguration(input) {
      const allowedServices = new Set(discordServiceDefinitions.map((service) => service.key));
      const allowedEvents = new Set(discordEventDefinitions.map((event) => event.key));
      if (Object.keys(input.serviceChannels).some((serviceKey) => !allowedServices.has(serviceKey as never))) {
        throw new Error("unknown_discord_service");
      }
      if (Object.keys(input.eventChannels).some((eventKey) => !allowedEvents.has(eventKey as never))) {
        throw new Error("unknown_discord_event");
      }
      const announcements = z.array(announcementSchema.omit({ lastSentYear: true })).length(3).parse(input.announcements);
      await mutate((settings) => {
        const discord = normalizedDiscord(settings);
        const sentYears = new Map(discord.announcements.map((item) => [item.key, item.lastSentYear]));
        return {
          ...settings,
          discord: {
            ...discord,
            serviceChannels: z.record(z.string(), channelIdsSchema).parse(input.serviceChannels),
            eventChannels: z.record(eventKeySchema, channelIdsSchema).parse(input.eventChannels),
            testChannelId: input.testChannelId ? snowflakeSchema.parse(input.testChannelId) : undefined,
            announcements: announcements.map((item) => ({
              ...item,
              ...(sentYears.get(item.key) ? { lastSentYear: sentYears.get(item.key) } : {}),
            })),
          },
        };
      });
    },
    async sendDiscordTest(channelId, announcementPreviews) {
      const settings = await readSettings();
      const discord = normalizedDiscord(settings);
      if (!discord.botToken || !discord.guildId) throw new Error("discord_not_configured");
      if (!discord.channels.some((channel) => channel.id === channelId)) {
        throw new Error("unknown_discord_channel");
      }
      const token = decrypt(discord.botToken, key);
      const timestamp = new Date().toISOString();
      const footer = { text: "Legacy Hosting · Test notification", icon_url: discordAssetUrls.logo };
      const previewByKey = new Map(
        announcementPreviews?.map((announcement) => [announcement.key, announcement]) ?? [],
      );
      const announcements = normalizedAnnouncements(discord).map((announcement) => ({
        ...announcement,
        ...previewByKey.get(announcement.key),
      }));
      const embeds = [
        { title: "API is operational", description: "**Server:** ams3-api-01\n**Status:** operational\n**Response time:** 42 ms", color: 0x35d89a, thumbnail: { url: discordAssetUrls.operational } },
        { title: "API is degraded", description: "**Server:** ams3-api-01\n**Status:** degraded\n**Response time:** 850 ms", color: 0xf3ae48, thumbnail: { url: discordAssetUrls.degraded } },
        { title: "API is unavailable", description: "**Server:** ams3-api-01\n**Status:** outage\n**Response time:** No response", color: 0xef6170, thumbnail: { url: discordAssetUrls.outage } },
        { title: "Scheduled maintenance", description: "This is a test of a maintenance notification.\n\n**Service:** API (ams3-api-01)", color: 0x7561ff, thumbnail: { url: discordAssetUrls.maintenance } },
        { title: "Scheduled maintenance completed", description: "This is a test of a completed maintenance notification.\n\n**Status:** Maintenance complete", color: 0x35d89a, thumbnail: { url: discordAssetUrls.maintenanceComplete } },
        ...announcements.map((announcement) => ({
          title: announcement.title,
          description: announcement.message.replaceAll("{years}", String(new Date().getUTCFullYear() - 2017)),
          color: 0x7561ff,
          thumbnail: { url: announcement.imageUrl },
        })),
      ].map((embed) => ({ ...embed, footer, timestamp }));
      const response = await fetchImplementation(
        new URL(`/api/v10/channels/${channelId}/messages`, options.discordApiUrl ?? "https://discord.com"),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bot ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            content: "**LH-Discord notification test** — these previews are only being sent to the configured test channel.",
            embeds,
            allowed_mentions: { parse: [] },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs),
        },
      );
      if (!response.ok) throw new Error(`discord_test_rejected_${response.status}`);
      return embeds.length;
    },
    async createMaintenance(input) {
      if (Date.parse(input.scheduledUntil) <= Date.parse(input.scheduledFor)) {
        throw new Error("invalid_maintenance_window");
      }
      if (new Set(input.targetKeys).size !== input.targetKeys.length) {
        throw new Error("duplicate_maintenance_target");
      }
      const now = new Date().toISOString();
      const item = maintenanceSchema.parse({
        ...input,
        id: `maintenance-${randomBytes(12).toString("hex")}`,
        createdAt: now,
        updatedAt: now,
      });
      await mutate((settings) => {
        const discord = normalizedDiscord(settings);
        return { ...settings, discord: { ...discord, maintenance: [...discord.maintenance, item].slice(-500) } };
      });
    },
    async finishMaintenance(id, action) {
      let found = false;
      await mutate((settings) => {
        const discord = normalizedDiscord(settings);
        const now = new Date().toISOString();
        const maintenance = discord.maintenance.map((item) => {
          if (item.id !== id) return item;
          found = true;
          return maintenanceSchema.parse({
            ...item,
            ...(action === "complete" ? { completedAt: now } : { cancelledAt: now }),
            updatedAt: now,
          });
        });
        return { ...settings, discord: { ...discord, maintenance } };
      });
      return found;
    },
    async publicStatusEvents() {
      const view = await discordView(false) as { maintenance: Array<z.infer<typeof maintenanceSchema> & { status: string }> };
      const statusComponents = configuredStatusComponents(await readSettings())
        .filter((component) => component.visible && component.publicUrl);
      return view.maintenance
        .map((item) => ({
          ...item,
          publicTargetKeys: Array.from(new Set(item.targetKeys.flatMap((targetKey) =>
            statusComponents
              .filter((component) => component.componentKey === targetKey
                || component.service.toLowerCase().replaceAll(/[^a-z0-9]+/g, "") === targetKey)
              .map((component) => component.componentKey)
          ))),
        }))
        .filter((item) => item.publicTargetKeys.length > 0 && item.status !== "cancelled")
        .filter((item) => item.status !== "completed" || Date.now() - Date.parse(item.scheduledUntil) < 7 * 86_400_000)
        .map((item) => ({
          id: item.id,
          type: "maintenance",
          title: item.title,
          message: item.message,
          impact: item.impact,
          status: item.status,
          components: item.publicTargetKeys,
          startedAt: item.createdAt,
          updatedAt: item.updatedAt,
          scheduledFor: item.scheduledFor,
          scheduledUntil: item.scheduledUntil,
        }));
    },
    async discordBotConfiguration() {
      const view = await discordView(true) as { configured: boolean };
      return view.configured ? view : undefined;
    },
    async reportDiscordPresence(input) {
      await mutate((settings) => {
        const discord = normalizedDiscord(settings);
        return {
          ...settings,
          discord: {
            ...discord,
            bot: { ...input.bot, lastSeenAt: new Date().toISOString() },
            channels: input.channels.sort((left, right) => left.name.localeCompare(right.name)),
          },
        };
      });
    },
    async recordAnnouncementSent(announcementKey, year) {
      await mutate((settings) => {
        const discord = normalizedDiscord(settings);
        const announcements = normalizedAnnouncements(discord).map((item) =>
          item.key === announcementKey ? { ...item, lastSentYear: year } : item
        );
        return { ...settings, discord: { ...discord, announcements } };
      });
    },
    async githubVisibilityView(repositories = []) {
      const github = normalizedGithub(await readSettings());
      return {
        visibleOwner: github.visibleOwner,
        owners: githubOwners(github, repositories),
      };
    },
    async saveGithubVisibility(visibleOwner, repositories = []) {
      const owner = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).or(z.literal("")).parse(visibleOwner);
      await mutate((settings) => {
        const github = normalizedGithub(settings);
        const owners = githubOwners(github, repositories);
        const selected = owner
          ? owners.find((candidate) => candidate.toLowerCase() === owner.toLowerCase())
          : "";
        if (owner && !selected) throw new Error("unknown_github_owner");
        return {
          ...settings,
          github: { ...github, visibleOwner: selected ?? "" },
        };
      });
    },
    async githubAdminView(repositories = []) {
      const settings = await readSettings();
      const github = normalizedGithub(settings);
      const discord = normalizedDiscord(settings);
      const configured = new Map(
        github.repositories.map((repository) => [repository.fullName.toLowerCase(), repository]),
      );
      const available = new Map<string, z.infer<typeof githubRepositorySchema>>();
      for (const repository of [...github.knownRepositories, ...repositories]) {
        available.set(repository.fullName.toLowerCase(), repository);
      }
      for (const repository of github.repositories) {
        if (!available.has(repository.fullName.toLowerCase())) {
          available.set(repository.fullName.toLowerCase(), {
            fullName: repository.fullName,
            url: `https://github.com/${repository.fullName}`,
            defaultBranch: "main",
            private: true,
          });
        }
      }
      return {
        webhookUrl: "https://api.legacyhosting.xyz/api/v1/integrations/github/webhook",
        signatureRequired: true,
        pendingEvents: github.pendingEvents.length,
        channels: discord.channels,
        repositories: Array.from(available.values())
          .filter((repository) => !github.visibleOwner
            || githubOwner(repository.fullName).toLowerCase() === github.visibleOwner.toLowerCase())
          .sort((left, right) => left.fullName.localeCompare(right.fullName))
          .map((repository) => {
            const selection = configured.get(repository.fullName.toLowerCase());
            return {
              ...repository,
              enabled: selection?.enabled ?? false,
              channelIds: selection?.channelIds ?? [],
            };
          }),
      };
    },
    async saveGithubConfiguration(input) {
      const repositories = z.array(githubRepositorySettingSchema).max(1_000).parse(input);
      const names = repositories.map((repository) => repository.fullName.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error("duplicate_github_repository");
      await mutate((settings) => {
        const github = normalizedGithub(settings);
        if (github.visibleOwner && repositories.some(
          (repository) => githubOwner(repository.fullName).toLowerCase() !== github.visibleOwner.toLowerCase(),
        )) {
          throw new Error("github_repository_outside_visible_owner");
        }
        const hiddenRepositories = github.visibleOwner
          ? github.repositories.filter(
            (repository) => githubOwner(repository.fullName).toLowerCase() !== github.visibleOwner.toLowerCase(),
          )
          : [];
        return {
          ...settings,
          github: { ...github, repositories: [...hiddenRepositories, ...repositories] },
        };
      });
    },
    async ingestGithubPush(input) {
      const event = githubPushEventSchema.omit({ channelIds: true }).parse(input);
      let queued = false;
      await mutate((settings) => {
        const github = normalizedGithub(settings);
        const known = new Map(
          github.knownRepositories.map((repository) => [repository.fullName.toLowerCase(), repository]),
        );
        known.set(event.repository.fullName.toLowerCase(), {
          ...event.repository,
          lastEventAt: event.receivedAt,
        });
        const selection = github.repositories.find(
          (repository) => repository.fullName.toLowerCase() === event.repository.fullName.toLowerCase(),
        );
        const duplicate = github.pendingEvents.some((pending) => pending.deliveryId === event.deliveryId);
        const pendingEvents = selection?.enabled && selection.channelIds.length > 0 && !duplicate
          ? [...github.pendingEvents, { ...event, channelIds: selection.channelIds }]
          : github.pendingEvents;
        queued = pendingEvents.length > github.pendingEvents.length;
        return {
          ...settings,
          github: {
            ...github,
            knownRepositories: Array.from(known.values()),
            pendingEvents,
          },
        };
      });
      return queued;
    },
    async githubPushEvents(limit = 25) {
      const github = normalizedGithub(await readSettings());
      return github.pendingEvents.slice(0, Math.max(1, Math.min(100, limit)));
    },
    async acknowledgeGithubPushEvents(deliveryIds) {
      const acknowledged = new Set(
        z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).max(100).parse(deliveryIds),
      );
      await mutate((settings) => {
        const github = normalizedGithub(settings);
        return {
          ...settings,
          github: {
            ...github,
            pendingEvents: github.pendingEvents.filter((event) => !acknowledged.has(event.deliveryId)),
          },
        };
      });
    },
  };
}
