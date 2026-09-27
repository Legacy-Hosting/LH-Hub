import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Gauge,
  LockKeyhole,
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
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    fetch("/health", { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error("health check failed");
        setHealth("online");
      })
      .catch(() => setHealth("unavailable"));
    return () => clearInterval(timer);
  }, []);
  const clock = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "Europe/Oslo",
      }).format(now),
    [now],
  );

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
          <div><span>Internal operations</span><h1>{greeting(now)}, Legacy Hosting</h1></div>
          <div className={`health ${health}`}><i />Hub {health}</div>
        </header>
        <section className="content">
          <div className="notice">
            <div className="notice-icon"><LockKeyhole size={25} /></div>
            <div><span>Access boundary ready</span><h2>Staff authentication is waiting for LH-SSO OIDC</h2><p>The Hub API already rejects anonymous users and non-staff roles. Operational data remains unavailable until signed SSO tokens are enabled.</p></div>
          </div>
          <div className="section-title"><div><span>Planned workspace</span><h2>One operational view</h2></div><p>No provider credential is ever sent to the browser.</p></div>
          <div className="grid">
            {staffAreas.map(({ icon: Icon, title, text }) => (
              <article key={title}><div><Icon size={20} /></div><h3>{title}</h3><p>{text}</p><span>Awaiting authenticated data</span></article>
            ))}
          </div>
        </section>
        <footer><span>LH-Hub v0.1.0</span><span>{clock}</span></footer>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
