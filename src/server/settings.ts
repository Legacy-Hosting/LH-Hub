import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { FetchImplementation } from "./service-health.js";

const storedSettingsSchema = z.object({
  version: z.literal(1),
  digitalOceanToken: z.object({
    iv: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  }).optional(),
});

export type HubSettingsService = {
  digitalOceanToken(): Promise<string | undefined>;
  digitalOceanStatus(): Promise<{ configured: boolean; source: "stored" | "environment" | "none" }>;
  saveDigitalOceanToken(token: string): Promise<void>;
  clearDigitalOceanToken(): Promise<void>;
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

function decrypt(value: { iv: string; tag: string; ciphertext: string }, key: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function createHubSettingsService(options: {
  file: string;
  encryptionKey: string;
  environmentDigitalOceanToken?: string;
  timeoutMs: number;
  fetchImplementation?: FetchImplementation;
  digitalOceanApiUrl?: string;
}): HubSettingsService {
  if (!/^[a-f0-9]{64}$/i.test(options.encryptionKey)) {
    throw new Error("HUB_SETTINGS_KEY must be a 32-byte hexadecimal key");
  }
  const key = Buffer.from(options.encryptionKey, "hex");
  const fetchImplementation = options.fetchImplementation ?? fetch;

  async function readSettings() {
    try {
      return storedSettingsSchema.parse(JSON.parse(await readFile(options.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const };
      throw error;
    }
  }

  async function writeSettings(settings: z.infer<typeof storedSettingsSchema>) {
    const directory = dirname(options.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${options.file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, options.file);
      await chmod(options.file, 0o600);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function storedToken() {
    const encrypted = (await readSettings()).digitalOceanToken;
    return encrypted ? decrypt(encrypted, key) : undefined;
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
      const current = await readSettings();
      await writeSettings({ ...current, digitalOceanToken: encrypt(token, key) });
    },
    async clearDigitalOceanToken() {
      const current = await readSettings();
      if (!current.digitalOceanToken) return;
      const { digitalOceanToken: _removed, ...remaining } = current;
      await writeSettings(remaining);
    },
  };
}
