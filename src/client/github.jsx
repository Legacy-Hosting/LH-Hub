import React from "react";
import { GitBranch, GitFork, GitPullRequestArrow, RefreshCw, Save, ShieldCheck } from "lucide-react";

function selectedValues(event) {
  return Array.from(event.currentTarget.selectedOptions, (option) => option.value);
}

export function GitHubWorkspace({ configuration, onChange, onSave, busy, message }) {
  if (!configuration) {
    return <div className="operations-panel empty-state"><GitFork size={26} /><p>GitHub configuration is loading.</p></div>;
  }

  const updateRepository = (fullName, changes) => onChange({
    ...configuration,
    repositories: configuration.repositories.map((repository) =>
      repository.fullName === fullName ? { ...repository, ...changes } : repository
    ),
  });
  const tracked = configuration.repositories.filter((repository) => repository.enabled).length;

  return (
    <div className="github-workspace">
      <div className="section-title github-title">
        <div><span>GitHub</span><h2>Push notifications</h2></div>
        <p className="provider-state ready">{tracked} repositories tracked · {configuration.pendingEvents} events queued</p>
      </div>

      <div className="github-webhook-card">
        <div className="discord-card-heading">
          <div className="workspace-icon"><ShieldCheck size={20} /></div>
          <div><h3>Signed webhook receiver</h3><p>GitHub payloads are verified by LH-API before they enter the durable Discord queue.</p></div>
        </div>
        <label className="token-field">
          <span>Payload URL</span>
          <input value={configuration.webhookUrl} readOnly onFocus={(event) => event.currentTarget.select()} />
        </label>
        <div className="github-webhook-meta">
          <span><b>Content type</b> application/json</span>
          <span><b>Events</b> Push only</span>
          <span><b>SSL</b> Verification enabled</span>
        </div>
      </div>

      <div className="section-title">
        <div><span>Repositories</span><h2>Tracked pushes</h2></div>
        <p>Select one or more Discord destinations for each repository.</p>
      </div>

      {configuration.repositories.length === 0 ? (
        <div className="operations-panel empty-state"><GitPullRequestArrow size={26} /><p>No repositories are available to the Legacy Hosting GitHub App yet.</p></div>
      ) : (
        <div className="github-repository-grid">
          {configuration.repositories.map((repository) => (
            <article className={repository.enabled ? "tracked" : ""} key={repository.fullName}>
              <div className="github-repository-head">
                <div className="workspace-icon"><GitFork size={20} /></div>
                <div>
                  <a href={repository.url} target="_blank" rel="noreferrer">{repository.fullName}</a>
                  <p><GitBranch size={12} />{repository.defaultBranch}{repository.private ? " · Private" : " · Public"}</p>
                </div>
                <label className="toggle" title="Track pushes">
                  <input
                    type="checkbox"
                    checked={repository.enabled}
                    onChange={(event) => updateRepository(repository.fullName, { enabled: event.target.checked })}
                  />
                  <i />
                </label>
              </div>
              <label className="channel-field">
                <span>Push notification channels</span>
                <select
                  multiple
                  value={repository.channelIds}
                  disabled={!repository.enabled || configuration.channels.length === 0}
                  onChange={(event) => updateRepository(repository.fullName, { channelIds: selectedValues(event) })}
                >
                  {configuration.channels.map((channel) => <option value={channel.id} key={channel.id}># {channel.name}</option>)}
                </select>
                <small>
                  {configuration.channels.length === 0
                    ? "Channels appear after LH-Discord connects."
                    : "Every push is delivered in order to all selected channels."}
                </small>
              </label>
              {repository.lastEventAt && <time dateTime={repository.lastEventAt}>Last delivery {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(repository.lastEventAt))}</time>}
            </article>
          ))}
        </div>
      )}

      {message && <p className="settings-message github-message" role="status">{message}</p>}
      <div className="sticky-actions">
        <button className="primary" type="button" disabled={busy} onClick={onSave}>
          {busy ? <RefreshCw className="spin" size={15} /> : <Save size={15} />}Save GitHub configuration
        </button>
      </div>
    </div>
  );
}
