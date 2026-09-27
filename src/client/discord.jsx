import React, { useMemo, useState } from "react";
import {
  Bot,
  CalendarClock,
  CheckCircle2,
  RefreshCw,
  Save,
  Send,
  BellRing,
  Settings,
  ShieldCheck,
  Wrench,
} from "lucide-react";

function selectedValues(event) {
  return Array.from(event.currentTarget.selectedOptions, (option) => option.value);
}

function ChannelSelect({ channels, value, onChange, label }) {
  return (
    <label className="channel-field">
      <span>{label}</span>
      <select
        multiple
        value={value}
        onChange={(event) => onChange(selectedValues(event))}
        disabled={channels.length === 0}
      >
        {channels.map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}
      </select>
      <small>
        {channels.length === 0
          ? "Channels appear after the bot has connected to your Discord server."
          : "Use Ctrl/Cmd to select more than one channel."}
      </small>
    </label>
  );
}

function SingleChannelSelect({ channels, value, onChange, label }) {
  return (
    <label className="channel-field">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value)} disabled={channels.length === 0}>
        <option value="">Select a channel</option>
        {channels.map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}
      </select>
      <small>Test messages are sent only to this channel and never use the live event routes.</small>
    </label>
  );
}

export function DiscordCredentialsCard({ configuration, busy, message, onSave }) {
  const [guildId, setGuildId] = useState(configuration?.guildId ?? "");
  const [botToken, setBotToken] = useState("");
  return (
    <form
      className="provider-settings-card discord-credentials"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ guildId, ...(botToken ? { botToken } : {}) })
          .then(() => setBotToken(""))
          .catch(() => undefined);
      }}
    >
      <div className="provider-settings-head">
        <div className="workspace-icon"><Bot size={22} /></div>
        <div>
          <span>LH-Discord</span>
          <h3>Discord bot connection</h3>
          <p>The bot token is encrypted on the Hub server and is only shared with the LH-Discord service.</p>
        </div>
        <b className={configuration?.tokenConfigured ? "configured" : "missing"}>
          {configuration?.connected ? "Connected" : configuration?.tokenConfigured ? "Configured" : "Not configured"}
        </b>
      </div>
      <div className="settings-field-grid">
        <label className="token-field">
          <span>Discord server ID</span>
          <input
            inputMode="numeric"
            pattern="[0-9]{17,20}"
            placeholder="123456789012345678"
            value={guildId}
            onChange={(event) => setGuildId(event.target.value.trim())}
            required
          />
        </label>
        <label className="token-field">
          <span>{configuration?.tokenConfigured ? "Replace bot token" : "Bot token"}</span>
          <input
            type="password"
            minLength="20"
            maxLength="512"
            autoComplete="new-password"
            placeholder={configuration?.tokenConfigured ? "Leave blank to keep the stored token" : "Discord bot token"}
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            required={!configuration?.tokenConfigured}
          />
        </label>
      </div>
      {message && <p className="settings-message" role="status">{message}</p>}
      <div className="provider-actions">
        <button
          className="primary"
          type="submit"
          disabled={busy || !/^\d{17,20}$/.test(guildId) || (!configuration?.tokenConfigured && botToken.length < 20)}
        >
          {busy ? <RefreshCw className="spin" size={15} /> : <ShieldCheck size={15} />}
          Verify and save bot
        </button>
      </div>
    </form>
  );
}

export function DiscordWorkspace({ configuration, onChange, onSave, onTest, busy, message, navigate }) {
  if (!configuration) {
    return <div className="operations-panel empty-state"><Bot size={26} /><p>Discord configuration is loading.</p></div>;
  }
  const updateEvent = (key, channelIds) => onChange({
    ...configuration,
    events: configuration.events.map((event) => event.key === key ? { ...event, channelIds } : event),
  });
  const updateAnnouncement = (key, changes) => onChange({
    ...configuration,
    announcements: configuration.announcements.map((announcement) =>
      announcement.key === key ? { ...announcement, ...changes } : announcement
    ),
  });

  return (
    <div className="discord-workspace">
      <div className="section-title discord-title">
        <div><span>LH-Discord</span><h2>Discord automation</h2></div>
        <p className={`provider-state ${configuration.connected ? "ready" : "partial"}`}>
          {configuration.connected
            ? `${configuration.bot?.username ?? "Bot"} is connected`
            : configuration.configured
              ? "Waiting for the bot to connect"
              : "Bot credentials are not configured"}
        </p>
      </div>

      {!configuration.configured && (
        <div className="notice discord-notice">
          <div className="notice-icon"><Settings size={24} /></div>
          <div className="notice-copy"><span>Setup required</span><h2>Connect the Legacy Hosting bot</h2><p>Add its token and Discord server ID in Hub Settings.</p></div>
          <button className="primary" type="button" onClick={() => navigate("settings")}>Open settings</button>
        </div>
      )}

      <div className="discord-test-card">
        <div className="discord-card-heading"><div className="workspace-icon"><Send size={20} /></div><div><h3>Test notifications</h3><p>Preview every status and announcement embed in one safe destination.</p></div></div>
        <SingleChannelSelect
          channels={configuration.channels}
          value={configuration.testChannelId}
          label="Test channel"
          onChange={(testChannelId) => onChange({ ...configuration, testChannelId })}
        />
        <button className="secondary" type="button" disabled={busy || !configuration.connected || !configuration.testChannelId} onClick={onTest}>
          {busy ? <RefreshCw className="spin" size={15} /> : <Send size={15} />}Test all notifications
        </button>
      </div>

      <div className="section-title"><div><span>Notifications</span><h2>Event channels</h2></div><p>Choose separate destinations for each event type.</p></div>
      <div className="discord-service-grid">
        {configuration.events.map((event) => (
          <article className="discord-service-card" key={event.key}>
            <div className="discord-card-heading"><div className="workspace-icon"><BellRing size={20} /></div><div><h3>{event.name}</h3><p>{event.description}</p></div></div>
            <ChannelSelect
              channels={configuration.channels}
              value={event.channelIds}
              label="Send this event to"
              onChange={(channelIds) => updateEvent(event.key, channelIds)}
            />
          </article>
        ))}
      </div>

      <div className="section-title"><div><span>Scheduled messages</span><h2>Annual announcements</h2></div><p>Messages are sent once per date in Europe/Oslo.</p></div>
      <div className="announcement-grid">
        {configuration.announcements.map((announcement) => (
          <article className="announcement-card" key={announcement.key}>
            <div className="announcement-heading">
              <img src={announcement.imageUrl} alt="" />
              <div><span>{String(announcement.day).padStart(2, "0")}.{String(announcement.month).padStart(2, "0")}</span><h3>{announcement.title}</h3></div>
              <label className="toggle"><input type="checkbox" checked={announcement.enabled} onChange={(event) => updateAnnouncement(announcement.key, { enabled: event.target.checked })} /><i /></label>
            </div>
            <label className="token-field"><span>Title</span><input value={announcement.title} maxLength="256" onChange={(event) => updateAnnouncement(announcement.key, { title: event.target.value })} /></label>
            <label className="token-field"><span>Message</span><textarea value={announcement.message} maxLength="2000" onChange={(event) => updateAnnouncement(announcement.key, { message: event.target.value })} /></label>
            <ChannelSelect channels={configuration.channels} value={announcement.channelIds} label="Announcement channels" onChange={(channelIds) => updateAnnouncement(announcement.key, { channelIds })} />
          </article>
        ))}
      </div>
      {message && <p className="settings-message discord-message" role="status">{message}</p>}
      <div className="sticky-actions"><button className="primary" type="button" disabled={busy} onClick={onSave}>{busy ? <RefreshCw className="spin" size={15} /> : <Save size={15} />}Save Discord configuration</button></div>
    </div>
  );
}

function localInputValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function MaintenanceWorkspace({ data, busy, message, onCreate, onFinish }) {
  const defaults = useMemo(() => {
    const start = new Date(Date.now() + 5 * 60_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    return { start: localInputValue(start), end: localInputValue(end) };
  }, []);
  const [targetKey, setTargetKey] = useState("api");
  const [title, setTitle] = useState("");
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [scheduledFor, setScheduledFor] = useState(defaults.start);
  const [scheduledUntil, setScheduledUntil] = useState(defaults.end);

  return (
    <div className="maintenance-workspace">
      <div className="section-title"><div><span>Maintenance</span><h2>Service maintenance</h2></div><p>Publishes to Status and the selected Discord channels.</p></div>
      <div className="maintenance-layout">
        <form
          className="maintenance-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate({
              targetKey,
              title,
              message: maintenanceMessage,
              scheduledFor: new Date(scheduledFor).toISOString(),
              scheduledUntil: new Date(scheduledUntil).toISOString(),
            })
              .then(() => {
                setTitle("");
                setMaintenanceMessage("");
              })
              .catch(() => undefined);
          }}
        >
          <div className="discord-card-heading"><div className="workspace-icon"><Wrench size={20} /></div><div><h3>Schedule maintenance</h3><p>Choose the affected server or service.</p></div></div>
          <label className="token-field"><span>Service</span><select value={targetKey} onChange={(event) => setTargetKey(event.target.value)}>{data?.services?.map((service) => <option value={service.key} key={service.key}>{service.name} · {service.server}</option>)}</select></label>
          <label className="token-field"><span>Title</span><input minLength="3" maxLength="120" value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
          <label className="token-field"><span>Message</span><textarea minLength="3" maxLength="1000" value={maintenanceMessage} onChange={(event) => setMaintenanceMessage(event.target.value)} required /></label>
          <div className="settings-field-grid">
            <label className="token-field"><span>Starts</span><input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} required /></label>
            <label className="token-field"><span>Ends</span><input type="datetime-local" value={scheduledUntil} onChange={(event) => setScheduledUntil(event.target.value)} required /></label>
          </div>
          {message && <p className="settings-message" role="status">{message}</p>}
          <div className="provider-actions"><button className="primary" type="submit" disabled={busy || title.length < 3 || maintenanceMessage.length < 3}><CalendarClock size={15} />Schedule maintenance</button></div>
        </form>
        <div className="maintenance-list">
          <div className="panel-heading"><div><span>Maintenance history</span><h3>Scheduled and recent</h3></div><small>{data?.maintenance?.length ?? 0} entries</small></div>
          {!data?.maintenance?.length ? <div className="empty-state compact"><CheckCircle2 size={22} /><p>No maintenance has been scheduled.</p></div> : data.maintenance.map((item) => (
            <article key={item.id}>
              <div><span className={`maintenance-status ${item.status}`}>{item.status.replaceAll("_", " ")}</span><h4>{item.title}</h4><p>{item.message}</p><small>{item.targetKey.toUpperCase()} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.scheduledFor))}</small></div>
              {["scheduled", "in_progress"].includes(item.status) && <div className="maintenance-actions"><button className="secondary" type="button" onClick={() => onFinish(item.id, "cancel")}>Cancel</button><button className="primary" type="button" onClick={() => onFinish(item.id, "complete")}>Complete</button></div>}
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
