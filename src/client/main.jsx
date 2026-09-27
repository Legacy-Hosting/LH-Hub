import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Gauge,
  LockKeyhole,
  LogIn,
  LogOut,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import "./styles.css";

const staffAreas = [
  { icon: Server, title: "Infrastructure", text: "Server and service health across regions." },
  { icon: Activity, title: "Operations", text: "Incidents, deployments, backups, and alerts." },
  { icon: Users, title: "Customer support", text: "Audited support context through LH-API." },
  { icon: Gauge, title: "Capacity", text: "Resource trends without exposing provider tokens." },
];

function greeting(date) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function App() {
  const [now, setNow] = useState(new Date());
  const [health, setHealth] = useState("checking");
  const [auth, setAuth] = useState({ state: "checking", user: null });
  const [services, setServices] = useState([]);
  const authError = new URLSearchParams(window.location.search).has("auth_error");

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    fetch("/health", { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error("health check failed");
        setHealth("online");
      })
      .catch(() => setHealth("unavailable"));

    let active = true;
    async function loadSession() {
      try {
        const sessionResponse = await fetch("/api/v1/session", {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (sessionResponse.status === 401) {
          if (active) setAuth({ state: "guest", user: null });
          return;
        }
        if (!sessionResponse.ok) throw new Error("session unavailable");
        const session = await sessionResponse.json();
        if (!active) return;
        setAuth({ state: "authenticated", user: session.user });
        const overviewResponse = await fetch("/api/v1/overview", {
          credentials: "same-origin",
          headers: { accept: "application/json" },
        });
        if (!overviewResponse.ok) throw new Error("overview unavailable");
        const overview = await overviewResponse.json();
        if (active) setServices(Array.isArray(overview.services) ? overview.services : []);
      } catch {
        if (active) setAuth({ state: "unavailable", user: null });
      }
    }
    void loadSession();
    return () => {
      active = false;
      clearInterval(timer);
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

  return (
    <div className="shell">
      <aside>
        <div className="brand"><span>L</span><div><strong>Legacy Hosting</strong><small>Staff Hub</small></div></div>
        <nav aria-label="Hub navigation">
          <button className="active"><Gauge size={18} />Overview</button>
          <button disabled><Server size={18} />Infrastructure</button>
          <button disabled><Activity size={18} />Operations</button>
          <button disabled><Users size={18} />Support</button>
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
        </section>
        <footer><span>LH-Hub v0.2.0</span><span>{clock}</span></footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
