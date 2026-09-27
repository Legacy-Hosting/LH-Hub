import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
const announcementSchema = z.object({
  key: announcementKeySchema,
  enabled: z.boolean(),
  title: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(2_000),
  channelIds: channelIdsSchema,
  lastSentYear: z.number().int().min(2017).max(9999).optional(),
});
const maintenanceSchema = z.object({
  id: z.string().regex(/^maintenance-[a-f0-9]{24}$/),
  targetKey: z.enum(["api", "sso", "hub", "panel", "status"]),
  title: z.string().trim().min(3).max(120),
  message: z.string().trim().min(3).max(1_000),
  scheduledFor: z.string().datetime(),
  scheduledUntil: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  cancelledAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
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
});
type StoredSettings = z.infer<typeof storedSettingsSchema>;
type AnnouncementKey = z.infer<typeof announcementKeySchema>;

export type HubSettingsService = {
  digitalOceanToken(): Promise<string | undefined>;
  digitalOceanStatus(): Promise<{ configured: boolean; source: "stored" | "environment" | "none" }>;
  saveDigitalOceanToken(token: string): Promise<void>;
  clearDigitalOceanToken(): Promise<void>;
  discordAdminView(): Promise<unknown>;
  maintenanceView(): Promise<unknown>;
  saveDiscordCredentials(input: { botToken?: string; guildId: string }): Promise<void>;
  saveDiscordConfiguration(input: {
    serviceChannels: Record<string, string[]>;
    eventChannels: Record<string, string[]>;
    testChannelId?: string | undefined;
    announcements: Array<{ key: AnnouncementKey; enabled: boolean; title: string; message: string; channelIds: string[] }>;
  }): Promise<void>;
  sendDiscordTest(channelId: string): Promise<number>;
  createMaintenance(input: {
    targetKey: "api" | "sso" | "hub" | "panel" | "status";
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
    async sendDiscordTest(channelId) {
      const settings = await readSettings();
      const discord = normalizedDiscord(settings);
      if (!discord.botToken || !discord.guildId) throw new Error("discord_not_configured");
      if (!discord.channels.some((channel) => channel.id === channelId)) {
        throw new Error("unknown_discord_channel");
      }
      const token = decrypt(discord.botToken, key);
      const timestamp = new Date().toISOString();
      const footer = { text: "Legacy Hosting · Test notification", icon_url: discordAssetUrls.logo };
      const embeds = [
        { title: "API is operational", description: "**Server:** ams3-api-01\n**Status:** operational\n**Response time:** 42 ms", color: 0x35d89a, thumbnail: { url: discordAssetUrls.operational } },
        { title: "API is degraded", description: "**Server:** ams3-api-01\n**Status:** degraded\n**Response time:** 850 ms", color: 0xf3ae48, thumbnail: { url: discordAssetUrls.degraded } },
        { title: "API is unavailable", description: "**Server:** ams3-api-01\n**Status:** outage\n**Response time:** No response", color: 0xef6170, thumbnail: { url: discordAssetUrls.outage } },
        { title: "Scheduled maintenance", description: "This is a test of a maintenance notification.\n\n**Service:** API (ams3-api-01)", color: 0x7561ff, thumbnail: { url: discordAssetUrls.maintenance } },
        { title: "Scheduled maintenance completed", description: "This is a test of a completed maintenance notification.\n\n**Status:** Maintenance complete", color: 0x35d89a, thumbnail: { url: discordAssetUrls.maintenanceComplete } },
        ...Object.values(announcementDefaults).map((announcement) => ({
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
      const publicKeys = new Set(["api", "sso", "panel"]);
      return view.maintenance
        .filter((item) => publicKeys.has(item.targetKey) && item.status !== "cancelled")
        .filter((item) => item.status !== "completed" || Date.now() - Date.parse(item.scheduledUntil) < 7 * 86_400_000)
        .map((item) => ({
          id: item.id,
          type: "maintenance",
          title: item.title,
          message: item.message,
          impact: "none",
          status: item.status,
          components: [item.targetKey],
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
  };
}
