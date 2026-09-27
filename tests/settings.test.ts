import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHubSettingsService } from "../src/server/settings.js";

test("Hub settings validate and encrypt DigitalOcean tokens at rest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-hub-settings-"));
  const file = join(directory, "settings.enc.json");
  const token = `dop_v1_${"x".repeat(48)}`;
  try {
    const service = createHubSettingsService({
      file,
      encryptionKey: "a".repeat(64),
      timeoutMs: 5_000,
      fetchImplementation: async (_url, options) => {
        assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
        return new Response(JSON.stringify({ account: {} }), { status: 200 });
      },
    });
    assert.deepEqual(await service.digitalOceanStatus(), { configured: false, source: "none" });
    await service.saveDigitalOceanToken(token);
    assert.equal(await service.digitalOceanToken(), token);
    assert.equal((await readFile(file, "utf8")).includes(token), false);
    assert.deepEqual(await service.digitalOceanStatus(), { configured: true, source: "stored" });
    await service.clearDigitalOceanToken();
    assert.deepEqual(await service.digitalOceanStatus(), { configured: false, source: "none" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Hub settings encrypt Discord credentials and manage routing and maintenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-hub-discord-settings-"));
  const file = join(directory, "settings.enc.json");
  const botToken = `discord.${"x".repeat(48)}`;
  const guildId = "123456789012345678";
  const channelId = "223456789012345678";
  let sentTestEmbeds = 0;
  try {
    const service = createHubSettingsService({
      file,
      encryptionKey: "b".repeat(64),
      timeoutMs: 5_000,
      fetchImplementation: async (_url, options) => {
        assert.equal(new Headers(options?.headers).get("authorization"), `Bot ${botToken}`);
        if (options?.method === "POST") {
          const payload = JSON.parse(String(options.body)) as { embeds: unknown[] };
          sentTestEmbeds = payload.embeds.length;
        }
        return Response.json({ id: guildId }, { status: 200 });
      },
    });
    await service.saveDiscordCredentials({ botToken, guildId });
    assert.equal((await readFile(file, "utf8")).includes(botToken), false);
    await service.reportDiscordPresence({
      bot: { id: "323456789012345678", username: "LH-Discord" },
      channels: [{ id: channelId, name: "operations" }],
    });
    const admin = await service.discordAdminView() as {
      tokenConfigured: boolean;
      channels: Array<{ id: string }>;
      services: Array<{ key: string; channelIds: string[] }>;
      events: Array<{ key: string; channelIds: string[] }>;
      testChannelId: string;
      announcements: Array<{ key: "birthday" | "christmas" | "newyear"; title: string; message: string }>;
    };
    assert.equal(admin.tokenConfigured, true);
    assert.equal(admin.channels[0]?.id, channelId);
    await service.saveDiscordConfiguration({
      serviceChannels: Object.fromEntries(admin.services.map((item) => [item.key, [channelId]])),
      eventChannels: Object.fromEntries(admin.events.map((item) => [item.key, [channelId]])),
      testChannelId: channelId,
      announcements: admin.announcements.map((item) => ({
        ...item,
        enabled: true,
        channelIds: [channelId],
      })),
    });
    assert.equal(await service.sendDiscordTest(channelId), 8);
    assert.equal(sentTestEmbeds, 8);
    await service.createMaintenance({
      targetKey: "api",
      title: "API maintenance",
      message: "Deploying a database update.",
      scheduledFor: "2026-12-01T10:00:00.000Z",
      scheduledUntil: "2026-12-01T11:00:00.000Z",
    });
    const bot = await service.discordBotConfiguration() as {
      botToken: string;
      services: Array<{ key: string; channelIds: string[] }>;
      events: Array<{ key: string; channelIds: string[] }>;
      maintenance: Array<{ id: string }>;
    };
    assert.equal(bot.botToken, botToken);
    assert.deepEqual(bot.services.find((item) => item.key === "api")?.channelIds, [channelId]);
    assert.deepEqual(bot.events.find((item) => item.key === "outage")?.channelIds, [channelId]);
    assert.equal(bot.maintenance.length, 1);
    assert.equal(await service.finishMaintenance(bot.maintenance[0]!.id, "complete"), true);
    const publicEvents = await service.publicStatusEvents() as Array<{ status: string; components: string[] }>;
    assert.equal(publicEvents[0]?.status, "completed");
    assert.deepEqual(publicEvents[0]?.components, ["api"]);

    await service.saveGithubConfiguration([{
      fullName: "Legacy-Hosting/LH-Hub",
      enabled: true,
      channelIds: [channelId],
    }]);
    const githubEvent = (deliveryId: string, receivedAt: string) => ({
      deliveryId,
      repository: {
        fullName: "Legacy-Hosting/LH-Hub",
        url: "https://github.com/Legacy-Hosting/LH-Hub",
        defaultBranch: "main",
        private: true,
      },
      ref: "refs/heads/main",
      branch: "main",
      before: "a".repeat(40),
      after: "b".repeat(40),
      compareUrl: "https://github.com/Legacy-Hosting/LH-Hub/compare/a...b",
      created: false,
      deleted: false,
      forced: false,
      pusher: { name: "Angel", email: "angel@legacyhosting.xyz" },
      sender: { login: "Angel", html_url: "https://github.com/Angel" },
      headCommit: null,
      commits: [],
      receivedAt,
    });
    assert.equal(await service.ingestGithubPush(githubEvent("delivery-1", "2026-09-27T19:00:00.000Z")), true);
    assert.equal(await service.ingestGithubPush(githubEvent("delivery-2", "2026-09-27T19:01:00.000Z")), true);
    assert.deepEqual((await service.githubPushEvents()).map((event) => event.deliveryId), ["delivery-1", "delivery-2"]);
    await service.acknowledgeGithubPushEvents(["delivery-1"]);
    assert.deepEqual((await service.githubPushEvents()).map((event) => event.deliveryId), ["delivery-2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
