import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Cpu,
  Gauge,
  HardDrive,
  LockKeyhole,
  LogIn,
  LogOut,
  MemoryStick,
  Network,
  Server,
  ShieldCheck,
  ShoppingBag,
  Users,
} from "lucide-react";
import "./styles.css";

const staffAreas = [
  { icon: Server, title: "Infrastructure", text: "Server and service health across regions." },
  { icon: Activity, title: "Operations", text: "Incidents, deployments, backups, and alerts." },
  { icon: Users, title: "Customer support", text: "Audited support context through LH-API." },
  { icon: Gauge, title: "Capacity", text: "Resource trends without exposing provider tokens." },
];

const navigation = [
  { capability: "services:read", icon: Gauge, label: "Overview", active: true },
  { capability: "infrastructure:read", icon: Server, label: "Infrastructure" },
  { capability: "operations:read", icon: Activity, label: "Operations" },
  { capability: "support:read", icon: Users, label: "Support" },
  { capability: "sales:read", icon: ShoppingBag, label: "Sales" },
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
      const [overviewResult, infrastructureResult] = await Promise.allSettled([
        jsonResponse("/api/v1/overview"),
        canViewInfrastructure
          ? jsonResponse("/api/v1/infrastructure")
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
  const displayName = auth.user?.name?.split(" ")[0] || "Legacy Hosting";
  const authenticated = auth.state === "authenticated";
  const canViewInfrastructure = auth.capabilities.includes("infrastructure:read");
  const visibleNavigation = authenticated
    ? navigation.filter((item) => auth.capabilities.includes(item.capability))
    : navigation.slice(0, 1);

  return (
    <div className="shell">
      <aside>
        <div className="brand"><span>L</span><div><strong>Legacy Hosting</strong><small>Staff Hub</small></div></div>
        <nav aria-label="Hub navigation">
          {visibleNavigation.map(({ active, icon: Icon, label }) => (
            <button className={active ? "active" : undefined} disabled={!active} key={label}>
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
        <div className="guard"><ShieldCheck size={18} /><span>Protected by LH-SSO</span></div>
      </aside>
      <main>
        <header>
          <div><span>Internal operations</span><h1>{greeting(now)}, {displayName}</h1></div>
          <div className={`health ${health}`}><i />Hub {health}</div>
        </header>
        <section className="content">
          {authenticated ? (
            <div className="notice authenticated">
              <div className="notice-icon"><ShieldCheck size={25} /></div>
              <div className="notice-copy"><span>Authenticated by LH-SSO</span><h2>Staff access active</h2><p>{auth.user.email || auth.user.name || auth.user.sub}</p><div className="roles">{auth.user.roles.map((role) => <b key={role}>{role.replaceAll("_", " ")}</b>)}</div></div>
              <form action="/auth/logout" method="post"><button className="secondary" type="submit"><LogOut size={16} />Sign out</button></form>
            </div>
          ) : (
            <div className="notice">
              <div className="notice-icon"><LockKeyhole size={25} /></div>
              <div className="notice-copy"><span>Restricted workspace</span><h2>{auth.state === "checking" ? "Checking your staff session" : "Sign in with Legacy Hosting SSO"}</h2><p>{authError ? "The previous sign-in could not be completed. Try again or contact an administrator." : "Only authorized Legacy Hosting staff roles can access operational data."}</p></div>
              {auth.state !== "checking" && <a className="primary" href="/auth/login?return_to=%2F"><LogIn size={16} />Sign in</a>}
            </div>
          )}

          <div className="section-title"><div><span>{authenticated ? "Live checks" : "Protected areas"}</span><h2>{authenticated ? "Service overview" : "One operational view"}</h2></div><p>No provider credential is ever sent to the browser.</p></div>
          <div className="grid">
            {(authenticated && services.length > 0 ? services : staffAreas).map((item) => {
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

          {authenticated && canViewInfrastructure && (
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
        </section>
        <footer><span>LH-Hub v0.4.0</span><span>{clock}</span></footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
