import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import packageMetadata from "../../package.json";
import {
  Activity,
  ClipboardList,
  Cpu,
  Gauge,
  HardDrive,
  LockKeyhole,
  LogIn,
  LogOut,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Users,
} from "lucide-react";
import "./styles.css";

const navigation = [
  { key: "overview", capability: "services:read", icon: Gauge, label: "Overview" },
  { key: "infrastructure", capability: "infrastructure:read", icon: Server, label: "Infrastructure" },
  { key: "operations", capability: "operations:read", icon: Activity, label: "Operations" },
  { key: "support", capability: "support:read", icon: Users, label: "Support" },
  { key: "sales", capability: "sales:read", icon: ShoppingBag, label: "Sales" },
  { key: "audit", capability: "audit:read", icon: ClipboardList, label: "Audit log" },
  { key: "settings", capability: "settings:write", icon: Settings, label: "Settings" },
];

const roleLabels = {
  founder: "Founder",
  management: "Management",
  platform_admin: "Administrator",
  developer: "Developer",
  infrastructure: "Infrastructure",
  support: "Support",
  sales: "Sales",
};

const rolePriority = [
  "founder",
  "management",
  "platform_admin",
  "developer",
  "infrastructure",
  "support",
  "sales",
];

function greeting(date) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function metric(value, suffix = "%") {
  return Number.isFinite(value) ? `${value}${suffix}` : "–";
}

function infrastructureLabel(state) {
  if (state === "ready") return "Live DigitalOcean Insights";
  if (state === "stale") return "Showing last successful DigitalOcean snapshot";
  if (state === "not_configured") return "DigitalOcean token is not configured";
  if (state === "loading") return "Loading DigitalOcean Insights";
  return "DigitalOcean Insights is temporarily unavailable";
}

function auditAction(action) {
  return action.replaceAll(".", " · ").replaceAll("_", " ");
}

function userDisplayName(user) {
  if (user?.name?.trim()) return user.name.trim();
  const emailName = user?.email?.split("@")[0]?.replaceAll(/[._-]+/g, " ").trim();
  if (emailName) {
    return emailName.replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return "Legacy Hosting user";
}

function userInitials(name) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials || "LH";
}

function AuthGate({ state, authError }) {
  const checking = state === "checking";
  const unavailable = state === "unavailable";
  return (
    <main className="auth-gate">
      <div className="auth-brand"><span>L</span><div><strong>Legacy Hosting</strong><small>Staff Hub</small></div></div>
      <section className="auth-card" aria-live="polite">
        <div className="auth-icon"><LockKeyhole size={27} /></div>
        <span>Restricted workspace</span>
        <h1>{checking ? "Checking your staff session" : "Sign in to Staff Hub"}</h1>
        <p>
          {authError
            ? "The previous sign-in could not be completed. Try again or contact an administrator."
            : unavailable
              ? "The authentication service is temporarily unavailable. Please try again."
              : "Continue with Legacy Hosting SSO to access this internal service."}
        </p>
        {!checking && (
          <a className="primary auth-button" href="/auth/login?return_to=%2F">
            <LogIn size={17} />Sign in with SSO
          </a>
        )}
        {checking && <div className="auth-progress"><i />Verifying session</div>}
      </section>
      <div className="auth-protection"><ShieldCheck size={16} />Protected by LH-SSO</div>
    </main>
  );
}

async function jsonResponse(url) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${url} unavailable`);
  return response.json();
}

function App() {
  const [now, setNow] = useState(new Date());
  const [health, setHealth] = useState("checking");
  const [auth, setAuth] = useState({
    state: "checking",
    user: null,
    capabilities: [],
  });
  const [services, setServices] = useState([]);
  const [infrastructure, setInfrastructure] = useState({
    state: "loading",
    fetchedAt: null,
    droplets: [],
  });
  const [operations, setOperations] = useState({
    state: "loading",
    platform: null,
    publicStatus: null,
  });
  const [audit, setAudit] = useState({
    state: "loading",
    events: [],
    nextCursor: null,
  });
  const [activeSection, setActiveSection] = useState("overview");
  const [showLogout, setShowLogout] = useState(false);
  const [digitalOceanSettings, setDigitalOceanSettings] = useState({ configured: false, source: "none" });
  const [digitalOceanToken, setDigitalOceanToken] = useState("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const authError = new URLSearchParams(window.location.search).has("auth_error");

  useEffect(() => {
    const clockTimer = setInterval(() => setNow(new Date()), 1000);
    let refreshTimer;
    let active = true;
    let refreshing = false;

    jsonResponse("/health")
      .then(() => active && setHealth("online"))
      .catch(() => active && setHealth("unavailable"));

    async function refreshOperationalData(capabilities) {
      if (refreshing) return;
      refreshing = true;
      const canViewInfrastructure = capabilities.includes("infrastructure:read");
      const canViewOperations = capabilities.includes("operations:read");
      const canViewAudit = capabilities.includes("audit:read");
      const canWriteSettings = capabilities.includes("settings:write");
      const [overviewResult, infrastructureResult, operationsResult, auditResult, settingsResult] = await Promise.allSettled([
        jsonResponse("/api/v1/overview"),
        canViewInfrastructure
          ? jsonResponse("/api/v1/infrastructure")
          : Promise.resolve(null),
        canViewOperations
          ? jsonResponse("/api/v1/operations")
          : Promise.resolve(null),
        canViewAudit
          ? jsonResponse("/api/v1/audit-events")
          : Promise.resolve(null),
        canWriteSettings
          ? jsonResponse("/api/v1/settings/digitalocean")
          : Promise.resolve(null),
      ]);
      if (active) {
        if (overviewResult.status === "fulfilled") {
          setServices(Array.isArray(overviewResult.value.services)
            ? overviewResult.value.services
            : []);
        }
        if (
          canViewInfrastructure &&
          infrastructureResult.status === "fulfilled" &&
          infrastructureResult.value
        ) {
          setInfrastructure(infrastructureResult.value);
        } else if (canViewInfrastructure) {
          setInfrastructure((current) => ({
            ...current,
            state: current.droplets.length > 0 ? "stale" : "unavailable",
          }));
        }
        if (canViewOperations && operationsResult.status === "fulfilled" && operationsResult.value) {
          const platform = operationsResult.value.platform?.data ?? null;
          const publicStatus = operationsResult.value.publicStatus?.data ?? null;
          setOperations({
            state: platform && publicStatus ? "ready" : platform || publicStatus ? "partial" : "unavailable",
            platform,
            publicStatus,
          });
        } else if (canViewOperations) {
          setOperations((current) => ({ ...current, state: "unavailable" }));
        }
        if (canViewAudit && auditResult.status === "fulfilled" && auditResult.value) {
          setAudit({ state: "ready", ...auditResult.value });
        } else if (canViewAudit) {
          setAudit((current) => ({ ...current, state: "unavailable" }));
        }
        if (canWriteSettings && settingsResult.status === "fulfilled" && settingsResult.value) {
          setDigitalOceanSettings(settingsResult.value);
        }
      }
      refreshing = false;
    }

    async function loadSession() {
      try {
        const response = await fetch("/api/v1/session", {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (response.status === 401) {
          if (active) setAuth({ state: "guest", user: null, capabilities: [] });
          return;
        }
        if (!response.ok) throw new Error("session unavailable");
        const session = await response.json();
        if (!active) return;
        const capabilities = Array.isArray(session.capabilities)
          ? session.capabilities
          : [];
        setAuth({ state: "authenticated", user: session.user, capabilities });
        await refreshOperationalData(capabilities);
        if (active) {
          refreshTimer = setInterval(
            () => refreshOperationalData(capabilities),
            60_000,
          );
        }
      } catch {
        if (active) {
          setAuth({ state: "unavailable", user: null, capabilities: [] });
        }
      }
    }
    void loadSession();
    return () => {
      active = false;
      clearInterval(clockTimer);
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, []);

  const clock = useMemo(
    () => new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(now),
    [now],
  );
  const fullName = userDisplayName(auth.user);
  const displayName = fullName.split(" ")[0];
  const authenticated = auth.state === "authenticated";
  const canViewInfrastructure = auth.capabilities.includes("infrastructure:read");
  const canViewOperations = auth.capabilities.includes("operations:read");
  const canViewAudit = auth.capabilities.includes("audit:read");
  const visibleNavigation = navigation.filter((item) => auth.capabilities.includes(item.capability));
  const activeNavigation = visibleNavigation.find((item) => item.key === activeSection)
    ?? visibleNavigation[0]
    ?? navigation[0];
  const primaryRole = rolePriority.find((role) => auth.user?.roles?.includes(role));
  const roleLabel = roleLabels[primaryRole] ?? "Staff member";

  async function loadMoreAudit() {
    if (!audit.nextCursor || audit.state === "loading-more") return;
    setAudit((current) => ({ ...current, state: "loading-more" }));
    try {
      const page = await jsonResponse(
        `/api/v1/audit-events?cursor=${encodeURIComponent(audit.nextCursor)}`,
      );
      setAudit((current) => ({
        state: "ready",
        events: [...current.events, ...page.events],
        nextCursor: page.nextCursor,
      }));
    } catch {
      setAudit((current) => ({ ...current, state: "unavailable" }));
    }
  }

  async function saveDigitalOceanToken(event) {
    event.preventDefault();
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const response = await fetch("/api/v1/settings/digitalocean", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token: digitalOceanToken }),
      });
      if (!response.ok) throw new Error("DigitalOcean rejected the token. Check its value and read permissions.");
      setDigitalOceanSettings(await response.json());
      setDigitalOceanToken("");
      setSettingsMessage("DigitalOcean token saved and verified.");
      const snapshot = await jsonResponse("/api/v1/infrastructure");
      setInfrastructure(snapshot);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "The token could not be saved.");
    } finally {
      setSettingsBusy(false);
    }
  }

  async function clearDigitalOceanToken() {
    setSettingsBusy(true);
    setSettingsMessage("");
    try {
      const response = await fetch("/api/v1/settings/digitalocean", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("The stored token could not be removed.");
      setDigitalOceanSettings(await response.json());
      setInfrastructure({ state: "loading", fetchedAt: null, droplets: [] });
      setSettingsMessage("Stored DigitalOcean token removed.");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : "The token could not be removed.");
    } finally {
      setSettingsBusy(false);
    }
  }

  if (!authenticated) {
    return <AuthGate state={auth.state} authError={authError} />;
  }

  return (
    <div className="shell">
      <aside>
        <div className="brand"><span>L</span><div><strong>Legacy Hosting</strong><small>Staff Hub</small></div></div>
        <nav aria-label="Hub navigation">
          {visibleNavigation.map(({ key, icon: Icon, label }) => (
            <button
              className={activeNavigation.key === key ? "active" : undefined}
              key={key}
              type="button"
              aria-current={activeNavigation.key === key ? "page" : undefined}
              onClick={() => setActiveSection(key)}
            >
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-profile">
          <div className="avatar">{userInitials(fullName)}</div>
          <div className="sidebar-profile-copy"><b>{fullName}</b><small>{roleLabel}</small></div>
          <button
            className="profile-action"
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => setShowLogout(true)}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span>{activeNavigation.key === "overview" ? "Staff Hub" : "Internal operations"}</span>
            <h1>{activeNavigation.key === "overview" ? `${greeting(now)}, ${displayName}` : activeNavigation.label}</h1>
          </div>
          <div className={`health ${health}`}><i />Hub {health}</div>
        </header>
        <section className="content">
          {activeNavigation.key === "overview" && (
            <>
              <div className="notice authenticated">
                <div className="notice-icon"><ShieldCheck size={25} /></div>
                <div className="notice-copy"><span>Authenticated by LH-SSO</span><h2>Staff access active</h2><p>{auth.user.email || fullName}</p><div className="roles">{auth.user.roles.map((role) => <b key={role}>{role.replaceAll("_", " ")}</b>)}</div></div>
              </div>

              <div className="section-title"><div><span>Live checks</span><h2>Service overview</h2></div><p>No provider credential is ever sent to the browser.</p></div>
              <div className="grid">
                {services.map((item) => {
                  const Icon = item.icon || Activity;
                  return (
                    <article key={item.key || item.title}>
                      <div><Icon size={20} /></div>
                      <h3>{item.name || item.title}</h3>
                      <p>{item.text || `Latest server-side check: ${item.checkedAt}`}</p>
                      <span className={item.state || "locked"}>{item.state ? `${item.state} · ${item.latencyMs ?? "–"} ms` : "Sign-in required"}</span>
                    </article>
                  );
                })}
              </div>
            </>
          )}

          {activeNavigation.key === "operations" && canViewOperations && (
            <>
              <div className="section-title operations-title">
                <div><span>Operations</span><h2>Platform activity</h2></div>
                <p className={`provider-state ${operations.state}`}>{operations.state === "ready" ? "Live data from LH-API and LH-Status" : operations.state === "partial" ? "One operational source is temporarily unavailable" : "Operational data is temporarily unavailable"}</p>
              </div>
              {operations.platform ? (
                <div className="operations-summary">
                  <article><HardDrive size={18} /><div><span>Database</span><strong>{operations.platform.database.state}</strong><small>LH-API connection</small></div></article>
                  <article><Server size={18} /><div><span>Agents</span><strong>{operations.platform.agents.online} / {operations.platform.agents.total}</strong><small>online nodes</small></div></article>
                  <article><Gauge size={18} /><div><span>Applications</span><strong>{operations.platform.applications.running} / {operations.platform.applications.total}</strong><small>running</small></div></article>
                  <article><Activity size={18} /><div><span>Deployments · 24h</span><strong>{operations.platform.deployments.total}</strong><small>{operations.platform.deployments.successRate === null ? "No completed deployments" : `${operations.platform.deployments.successRate}% success`}</small></div></article>
                </div>
              ) : (
                <div className="operations-panel empty-state"><Activity size={24} /><p>Platform activity could not be loaded</p></div>
              )}
              <div className="operations-columns">
                <div className="operations-panel">
                  <div className="panel-heading"><div><span>Deployments</span><h3>Recent activity</h3></div>{operations.platform && <small>{operations.platform.deployments.inProgress} active · {operations.platform.deployments.failed} failed</small>}</div>
                  {!operations.platform || operations.platform.deployments.recent.length === 0 ? (
                    <div className="empty-state compact"><p>No recent deployments</p></div>
                  ) : (
                    <ol className="deployment-list">
                      {operations.platform.deployments.recent.map((deployment) => (
                        <li key={deployment.id}>
                          <div><strong>{deployment.applicationName}</strong><small>{deployment.teamName} · {deployment.source.replaceAll("_", " ")}</small></div>
                          <span className={deployment.status}>{deployment.status.replaceAll("_", " ")}</span>
                          <time dateTime={deployment.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(deployment.createdAt))}</time>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div className="operations-panel">
                  <div className="panel-heading"><div><span>Public status</span><h3>{operations.publicStatus?.overall.replaceAll("_", " ") || "Unavailable"}</h3></div>{operations.publicStatus && <small>{operations.publicStatus.stale ? "stale snapshot" : "live snapshot"}</small>}</div>
                  {!operations.publicStatus ? (
                    <div className="empty-state compact"><p>LH-Status could not be loaded</p></div>
                  ) : (
                    <div className="component-list">
                      {operations.publicStatus.components.map((component) => (
                        <div key={component.key}><i className={component.state} /><span>{component.name}</span><strong>{component.state}</strong></div>
                      ))}
                      {operations.publicStatus.events.filter((event) => !["resolved", "completed"].includes(event.status)).slice(0, 3).map((event) => (
                        <div className="status-event" key={event.id}><Activity size={14} /><span>{event.title}</span><strong>{event.status.replaceAll("_", " ")}</strong></div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {activeNavigation.key === "infrastructure" && canViewInfrastructure && (
            <>
              <div className="section-title infrastructure-title">
                <div><span>Infrastructure</span><h2>Droplet capacity</h2></div>
                <p className={`provider-state ${infrastructure.state}`}>{infrastructureLabel(infrastructure.state)}</p>
              </div>
              <div className="infrastructure-panel">
                {infrastructure.droplets.length === 0 ? (
                  <div className="empty-state"><Server size={24} /><p>{infrastructureLabel(infrastructure.state)}</p></div>
                ) : (
                  <div className="infrastructure-scroll">
                    <table>
                      <thead><tr><th>Server</th><th><Cpu size={14} />CPU</th><th><MemoryStick size={14} />Memory</th><th><HardDrive size={14} />Disk</th><th>Load</th><th><Network size={14} />Public bandwidth</th></tr></thead>
                      <tbody>
                        {infrastructure.droplets.map((droplet) => (
                          <tr key={droplet.name}>
                            <td><strong>{droplet.name}</strong><small><i className={droplet.status === "active" ? "online" : "offline"} />{droplet.status} · {droplet.region} · {droplet.vcpus} vCPU · {droplet.memoryMiB} MiB</small></td>
                            <td>{metric(droplet.cpuPercent)}</td>
                            <td>{metric(droplet.memoryPercent)}</td>
                            <td>{metric(droplet.diskPercent)}</td>
                            <td>{metric(droplet.load1, "")}</td>
                            <td><span>↓ {metric(droplet.publicBandwidthInMbps, " Mbps")}</span><span>↑ {metric(droplet.publicBandwidthOutMbps, " Mbps")}</span><small className={droplet.metricsState}>{droplet.metricsState}</small></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {activeNavigation.key === "support" && (
            <div className="workspace-card">
              <div className="workspace-icon"><Users size={24} /></div>
              <span>Customer care</span>
              <h2>Support workspace</h2>
              <p>Support access is active. Customer cases and audited support sessions will appear here when the support data source is connected.</p>
            </div>
          )}

          {activeNavigation.key === "sales" && (
            <div className="workspace-card">
              <div className="workspace-icon"><ShoppingBag size={24} /></div>
              <span>Commercial operations</span>
              <h2>Sales workspace</h2>
              <p>Sales access is active. Leads, offers, and account activity will appear here when the sales data source is connected.</p>
            </div>
          )}

          {activeNavigation.key === "audit" && canViewAudit && (
            <>
              <div className="section-title audit-title">
                <div><span>Security</span><h2>Audit log</h2></div>
                <p>Authoritative support and administration events from LH-API.</p>
              </div>
              <div className="audit-panel">
                {audit.events.length === 0 ? (
                  <div className="empty-state"><ClipboardList size={24} /><p>{audit.state === "unavailable" ? "Audit events are temporarily unavailable" : "No audit events recorded"}</p></div>
                ) : (
                  <ol className="audit-list">
                    {audit.events.map((event) => (
                      <li key={event.id}>
                        <div className="audit-marker"><ClipboardList size={15} /></div>
                        <div className="audit-copy">
                          <strong>{auditAction(event.action)}</strong>
                          <p>{event.actor?.name || "System"}{event.team ? ` · ${event.team.name}` : ""}{event.resource ? ` · ${event.resource.type}` : ""}</p>
                        </div>
                        <time dateTime={event.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.createdAt))}</time>
                      </li>
                    ))}
                  </ol>
                )}
                {audit.nextCursor && (
                  <button className="audit-more secondary" type="button" onClick={loadMoreAudit} disabled={audit.state === "loading-more"}>
                    <RefreshCw size={15} />{audit.state === "loading-more" ? "Loading" : "Load older events"}
                  </button>
                )}
              </div>
            </>
          )}

          {activeNavigation.key === "settings" && (
            <div className="settings-workspace">
              <div className="section-title settings-title">
                <div><span>Provider integrations</span><h2>Hub settings</h2></div>
                <p>Secrets are encrypted on the Hub server and never returned to the browser.</p>
              </div>
              <form className="provider-settings-card" onSubmit={saveDigitalOceanToken}>
                <div className="provider-settings-head">
                  <div className="workspace-icon"><Settings size={22} /></div>
                  <div>
                    <span>DigitalOcean</span>
                    <h3>Infrastructure API token</h3>
                    <p>Use a scoped read-only token that can list Droplets and read monitoring metrics.</p>
                  </div>
                  <b className={digitalOceanSettings.configured ? "configured" : "missing"}>
                    {digitalOceanSettings.configured ? "Configured" : "Not configured"}
                  </b>
                </div>
                <label className="token-field">
                  <span>New token</span>
                  <input
                    type="password"
                    minLength="32"
                    maxLength="512"
                    autoComplete="new-password"
                    placeholder={digitalOceanSettings.configured ? "Enter a new token to replace the current one" : "dop_v1_..."}
                    value={digitalOceanToken}
                    onChange={(event) => setDigitalOceanToken(event.target.value)}
                    required
                  />
                </label>
                {settingsMessage && <p className="settings-message" role="status">{settingsMessage}</p>}
                <div className="provider-actions">
                  {digitalOceanSettings.source === "stored" && (
                    <button className="secondary" type="button" disabled={settingsBusy} onClick={clearDigitalOceanToken}>Remove stored token</button>
                  )}
                  <button className="primary" type="submit" disabled={settingsBusy || digitalOceanToken.length < 32}>
                    {settingsBusy ? <RefreshCw className="spin" size={15} /> : <ShieldCheck size={15} />}
                    Verify and save token
                  </button>
                </div>
              </form>
            </div>
          )}
        </section>
        <footer>
          <span>LH-Hub v{packageMetadata.version}</span>
          <span>Copyright 2009 © 2026 <a href="https://legacyhosting.xyz">Legacy Hosting</a></span>
          <span>{clock}</span>
        </footer>
      </main>
      {showLogout && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowLogout(false)}>
          <section className="logout-modal" role="dialog" aria-modal="true" aria-labelledby="logout-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-icon"><LogOut size={21} /></div>
            <h2 id="logout-title">Sign out?</h2>
            <p>Your Staff Hub session and central Legacy Hosting SSO session will be closed.</p>
            <div className="modal-actions">
              <button className="secondary" type="button" onClick={() => setShowLogout(false)}>Cancel</button>
              <form action="/auth/logout" method="post"><button className="primary" type="submit">Sign out</button></form>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
