import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("legacy single-service maintenance entries migrate to affected service arrays", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-hub-maintenance-migration-"));
  const file = join(directory, "settings.enc.json");
  try {
    await writeFile(file, JSON.stringify({
      version: 1,
      discord: {
        maintenance: [{
          id: `maintenance-${"a".repeat(24)}`,
          targetKey: "api",
          title: "Legacy maintenance",
          message: "Created before multi-service maintenance was available.",
          scheduledFor: "2099-01-01T10:00:00.000Z",
          scheduledUntil: "2099-01-01T11:00:00.000Z",
          createdAt: "2026-09-27T10:00:00.000Z",
          updatedAt: "2026-09-27T10:00:00.000Z",
        }],
      },
    }));
    const service = createHubSettingsService({
      file,
      encryptionKey: "c".repeat(64),
      timeoutMs: 5_000,
    });
    const view = await service.maintenanceView() as {
      maintenance: Array<{ targetKeys: string[]; impact: string }>;
    };
    assert.deepEqual(view.maintenance[0]?.targetKeys, ["api"]);
    assert.equal(view.maintenance[0]?.impact, "none");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Status services preserve main ordering and expose direct origin FQDNs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lh-hub-status-settings-"));
  const file = join(directory, "settings.enc.json");
  try {
    const service = createHubSettingsService({
      file,
      encryptionKey: "d".repeat(64),
      timeoutMs: 5_000,
    });
    const servers = [
      { name: "ams3-api-01", region: "ams3" },
      { name: "ams3-panel-01", region: "ams3" },
      { name: "ams3-web-02", region: "ams3" },
      { name: "database", region: "ams3" },
    ];
    const defaults = await service.statusComponentAdminView(servers) as { components: Array<{ server: string; visible: boolean; originFqdn: string; number: string }> };
    assert.equal(defaults.components.find((component) => component.server === "ams3-api-01")?.visible, true);
    assert.equal(defaults.components.find((component) => component.server === "database")?.originFqdn, "database.legacyh.fyi");
    assert.equal(defaults.components.find((component) => component.server === "database")?.number, "01");

    await service.saveStatusComponents([
      {
        server: "ams3-panel-01", visible: true, primary: true, displayName: "Web Panel",
        datacenter: "Amsterdam 3", service: "Web Panel", number: "01",
        publicUrl: "https://panel.legacyhosting.xyz/", originFqdn: "panel-origin.example.net",
      },
      {
        server: "ams3-api-01", visible: true, primary: true, displayName: "API",
        datacenter: "Amsterdam 3", service: "API", number: "01",
        publicUrl: "https://api.legacyhosting.xyz/health", originFqdn: "api-origin.example.net",
      },
      {
        server: "ams3-web-02", visible: true, primary: false, displayName: "Web 02",
        datacenter: "Amsterdam 3", service: "Web", number: "02",
        publicUrl: "https://web02.legacyhosting.xyz/health", originFqdn: "web-origin.example.net",
      },
    ], servers);
    const publicView = await service.publicStatusComponents() as Array<{
      key: string; name: string; connectHostname: string; primary: boolean; order: number;
    }>;
    assert.deepEqual(publicView.map((component) => component.name), ["Web Panel", "API", "Web 02"]);
    assert.deepEqual(publicView.slice(0, 2).map((component) => component.order), [0, 1]);
    assert.equal(publicView[0]?.connectHostname, "panel-origin.example.net");
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
  let sentTestPayload: { embeds: Array<{ title: string; description: string }> } | undefined;
  try {
    const service = createHubSettingsService({
      file,
      encryptionKey: "b".repeat(64),
      timeoutMs: 5_000,
      fetchImplementation: async (_url, options) => {
        assert.equal(new Headers(options?.headers).get("authorization"), `Bot ${botToken}`);
        if (options?.method === "POST") {
          const payload = JSON.parse(String(options.body)) as {
            embeds: Array<{ title: string; description: string }>;
          };
          sentTestPayload = payload;
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
        title: `Saved ${item.key} title`,
        message: `Saved ${item.key} message {years}`,
        channelIds: [channelId],
      })),
    });
    assert.equal(await service.sendDiscordTest(channelId), 8);
    assert.equal(sentTestEmbeds, 8);
    assert.equal(sentTestPayload?.embeds[5]?.title, "Saved birthday title");
    assert.match(sentTestPayload?.embeds[5]?.description ?? "", /^Saved birthday message \d+$/);
    assert.equal(await service.sendDiscordTest(channelId, admin.announcements.map((item) => ({
      key: item.key,
      title: `Unsaved ${item.key} preview`,
      message: `Current ${item.key} form value`,
    }))), 8);
    assert.equal(sentTestPayload?.embeds[5]?.title, "Unsaved birthday preview");
    assert.equal(sentTestPayload?.embeds[5]?.description, "Current birthday form value");
    await service.createMaintenance({
      targetKeys: ["api", "sso"],
      impact: "major",
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
    assert.deepEqual(publicEvents[0]?.components, ["api", "sso"]);
    assert.equal((publicEvents[0] as { impact?: string } | undefined)?.impact, "major");

    await service.saveGithubConfiguration([
      {
        fullName: "Legacy-Hosting/LH-Hub",
        enabled: true,
        channelIds: [channelId],
      },
      {
        fullName: "Angel/Private-Tool",
        enabled: true,
        channelIds: [channelId],
      },
    ]);
    const githubInventory = [
      {
        fullName: "Legacy-Hosting/LH-Hub",
        url: "https://github.com/Legacy-Hosting/LH-Hub",
        defaultBranch: "main",
        private: true,
      },
      {
        fullName: "Angel/Private-Tool",
        url: "https://github.com/Angel/Private-Tool",
        defaultBranch: "main",
        private: true,
      },
    ];
    assert.deepEqual(await service.githubVisibilityView(githubInventory), {
      visibleOwner: "",
      owners: ["Angel", "Legacy-Hosting"],
    });
    await assert.rejects(
      service.saveGithubVisibility("Unknown-Organization", githubInventory),
      /unknown_github_owner/,
    );
    await service.saveGithubVisibility("legacy-hosting", githubInventory);
    assert.deepEqual(await service.githubVisibilityView(githubInventory), {
      visibleOwner: "Legacy-Hosting",
      owners: ["Angel", "Legacy-Hosting"],
    });
    const filteredGithub = await service.githubAdminView(githubInventory) as {
      repositories: Array<{ fullName: string }>;
    };
    assert.deepEqual(filteredGithub.repositories.map((repository) => repository.fullName), ["Legacy-Hosting/LH-Hub"]);
    await service.saveGithubConfiguration([{
      fullName: "Legacy-Hosting/LH-Hub",
      enabled: true,
      channelIds: [channelId],
    }]);

    const githubEvent = (deliveryId: string, receivedAt: string, fullName = "Legacy-Hosting/LH-Hub") => ({
      deliveryId,
      repository: {
        fullName,
        url: `https://github.com/${fullName}`,
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
    assert.equal(await service.ingestGithubPush(githubEvent("delivery-3", "2026-09-27T19:02:00.000Z", "Angel/Private-Tool")), true);
    assert.deepEqual((await service.githubPushEvents()).map((event) => event.deliveryId), ["delivery-1", "delivery-2", "delivery-3"]);
    await service.acknowledgeGithubPushEvents(["delivery-1"]);
    assert.deepEqual((await service.githubPushEvents()).map((event) => event.deliveryId), ["delivery-2", "delivery-3"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
