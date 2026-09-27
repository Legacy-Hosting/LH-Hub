import React from "react";
import { AlertTriangle, GitBranch, GitFork, GitPullRequestArrow, RefreshCw, Save, ShieldCheck } from "lucide-react";

function selectedValues(event) {
  return Array.from(event.currentTarget.selectedOptions, (option) => option.value);
}

function formattedDeliveryTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown delivery time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

class GitHubWorkspaceErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("GitHub workspace failed to render", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="operations-panel empty-state github-error-state" role="alert">
          <AlertTriangle size={26} />
          <p>The GitHub workspace could not be displayed. Your saved configuration was not changed.</p>
          <button className="secondary" type="button" onClick={() => window.location.reload()}>Reload Hub</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function GitHubWorkspaceContent({ configuration, onChange, onSave, busy, message, dirty }) {
  if (!configuration) {
    return <div className="operations-panel empty-state"><GitFork size={26} /><p>GitHub configuration is loading.</p></div>;
  }

  const repositories = Array.isArray(configuration.repositories) ? configuration.repositories : [];
  const channels = Array.isArray(configuration.channels) ? configuration.channels : [];

  const updateRepository = (fullName, changes) => onChange({
    ...configuration,
    repositories: repositories.map((repository) =>
      repository.fullName === fullName ? { ...repository, ...changes } : repository
    ),
  });
  const tracked = repositories.filter((repository) => repository.enabled).length;

  return (
    <div className="github-workspace">
      <div className="section-title github-title">
        <div><span>GitHub</span><h2>Push notifications</h2></div>
        <p className="provider-state ready">{tracked} repositories tracked · {configuration.pendingEvents ?? 0} events queued</p>
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

      {repositories.length === 0 ? (
        <div className="operations-panel empty-state"><GitPullRequestArrow size={26} /><p>No repositories are available to the Legacy Hosting GitHub App yet.</p></div>
      ) : (
        <div className="github-repository-grid">
          {repositories.map((repository) => (
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
                  value={Array.isArray(repository.channelIds) ? repository.channelIds : []}
                  disabled={!repository.enabled || channels.length === 0}
                  onChange={(event) => updateRepository(repository.fullName, { channelIds: selectedValues(event) })}
                >
                  {channels.map((channel) => <option value={channel.id} key={channel.id}># {channel.name}</option>)}
                </select>
                <small>
                  {channels.length === 0
                    ? "Channels appear after LH-Discord connects."
                    : "Every push is delivered in order to all selected channels."}
                </small>
              </label>
              {repository.lastEventAt && <time dateTime={repository.lastEventAt}>Last delivery {formattedDeliveryTime(repository.lastEventAt)}</time>}
            </article>
          ))}
        </div>
      )}

      {dirty && (
        <section className="configuration-save-prompt" aria-live="polite">
          <div><strong>Unsaved GitHub changes</strong><p>Save the repository and channel selections when you are ready.</p></div>
          {message && <p className="settings-message github-message" role="status">{message}</p>}
          <button className="primary" type="button" disabled={busy} onClick={onSave}>
            {busy ? <RefreshCw className="spin" size={15} /> : <Save size={15} />}Save configuration
          </button>
        </section>
      )}
    </div>
  );
}

export function GitHubWorkspace(props) {
  return <GitHubWorkspaceErrorBoundary><GitHubWorkspaceContent {...props} /></GitHubWorkspaceErrorBoundary>;
}
