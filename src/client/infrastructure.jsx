import React from "react";
import { GripVertical, MonitorUp, RefreshCw, Save } from "lucide-react";

function safeText(value) {
  return typeof value === "string" ? value : "";
}

function normalizedComponent(component) {
  return {
    ...component,
    server: safeText(component?.server),
    componentKey: safeText(component?.componentKey),
    displayName: safeText(component?.displayName),
    datacenter: safeText(component?.datacenter),
    service: safeText(component?.service),
    number: safeText(component?.number),
    publicUrl: safeText(component?.publicUrl),
    originFqdn: safeText(component?.originFqdn),
    visible: Boolean(component?.visible),
    primary: Boolean(component?.primary),
  };
}

export function StatusComponentManager({ configuration, canConfigure, busy, message, onChange, onSave }) {
  const components = Array.isArray(configuration?.components)
    ? configuration.components.filter((component) => component && typeof component === "object").map(normalizedComponent)
    : [];
  const updateComponent = (server, changes) => {
    const next = components.map((component) => component.server === server
      ? { ...component, ...changes }
      : component);
    const changedPrimary = Object.hasOwn(changes, "primary")
      && components.find((component) => component.server === server)?.primary !== changes.primary;
    onChange({
      ...configuration,
      components: changedPrimary
        ? [...next.filter((component) => component.primary), ...next.filter((component) => !component.primary)]
        : next,
    });
  };
  const movePrimary = (sourceServer, targetServer) => {
    if (!sourceServer || sourceServer === targetServer) return;
    const primary = components.filter((component) => component.primary);
    const sourceIndex = primary.findIndex((component) => component.server === sourceServer);
    const targetIndex = primary.findIndex((component) => component.server === targetServer);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = primary.splice(sourceIndex, 1);
    if (!moved) return;
    primary.splice(targetIndex, 0, moved);
    onChange({
      ...configuration,
      components: [...primary, ...components.filter((component) => !component.primary)],
    });
  };

  return (
    <section className="status-component-manager">
      <div className="section-title">
        <div><span>Public status</span><h2>Status page layout</h2></div>
        <p>Main services use your order. Other services are sorted by datacenter, service, and number.</p>
      </div>
      <div className="status-layout-note">
        <MonitorUp size={20} />
        <div><strong>Direct origin monitoring</strong><p>The origin FQDN is resolved for every check. Status connects to that IP directly while retaining the public hostname for TLS and HTTP.</p></div>
      </div>
      {components.length === 0 ? (
        <div className="operations-panel empty-state"><MonitorUp size={25} /><p>No DigitalOcean servers are available for Status configuration.</p></div>
      ) : (
        <div className="status-server-grid">
          {components.map((component) => (
            <article
              className={component.primary ? "primary-service" : ""}
              key={component.server}
              onDragOver={(event) => {
                if (component.primary) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                movePrimary(event.dataTransfer.getData("text/plain"), component.server);
              }}
            >
              <div className="status-server-heading">
                <span
                  className="drag-handle"
                  draggable={canConfigure && !busy && component.primary}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", component.server);
                  }}
                  title={component.primary ? "Drag to reorder main services" : "Enable main service to reorder"}
                ><GripVertical size={17} /></span>
                <div><strong>{component.server}</strong><small>{component.componentKey}</small></div>
                <label className="toggle" title="Show on the public Status page">
                  <input type="checkbox" checked={component.visible} disabled={!canConfigure || busy} onChange={(event) => updateComponent(component.server, { visible: event.target.checked })} />
                  <i />
                </label>
              </div>
              <div className="status-server-flags">
                <label><input type="checkbox" checked={component.primary} disabled={!canConfigure || busy} onChange={(event) => updateComponent(component.server, { primary: event.target.checked, ...(event.target.checked ? { visible: true } : {}) })} />Main service</label>
                <span>{component.visible ? "Visible on Status" : "Hidden from Status"}</span>
              </div>
              <label className="token-field"><span>Display name</span><input value={component.displayName} disabled={!canConfigure || busy} maxLength="80" onChange={(event) => updateComponent(component.server, { displayName: event.target.value })} /></label>
              <div className="status-metadata-grid">
                <label className="token-field"><span>Datacenter</span><input list="status-datacenters" value={component.datacenter} disabled={!canConfigure || busy} maxLength="80" onChange={(event) => updateComponent(component.server, { datacenter: event.target.value })} /></label>
                <label className="token-field"><span>Service</span><input list="status-services" value={component.service} disabled={!canConfigure || busy} maxLength="80" onChange={(event) => updateComponent(component.server, { service: event.target.value })} /></label>
                <label className="token-field"><span>Number</span><input value={component.number} disabled={!canConfigure || busy} maxLength="12" onChange={(event) => updateComponent(component.server, { number: event.target.value.replaceAll(/[^A-Za-z0-9-]/g, "") })} /></label>
              </div>
              <label className="token-field"><span>Public health URL</span><input type="url" value={component.publicUrl} disabled={!canConfigure || busy} placeholder="https://service.legacyhosting.xyz/health" onChange={(event) => updateComponent(component.server, { publicUrl: event.target.value })} /></label>
              <label className="token-field"><span>Direct origin FQDN</span><input value={component.originFqdn} disabled={!canConfigure || busy} placeholder="ams3.api-01.legacyh.fyi" onChange={(event) => updateComponent(component.server, { originFqdn: event.target.value.trim().toLowerCase() })} /><small>Resolved to an IP by LH-Status. Traffic does not pass through Cloudflare.</small></label>
            </article>
          ))}
        </div>
      )}
      <datalist id="status-datacenters">{(configuration?.datacenters ?? []).map((value) => <option value={value} key={value} />)}</datalist>
      <datalist id="status-services">{(configuration?.services ?? []).map((value) => <option value={value} key={value} />)}</datalist>
      {message && <p className="settings-message" role="status">{message}</p>}
      {canConfigure && components.length > 0 && (
        <div className="provider-actions">
          <button className="primary" type="button" disabled={busy} onClick={onSave}>
            {busy ? <RefreshCw className="spin" size={15} /> : <Save size={15} />}Save Status layout
          </button>
        </div>
      )}
    </section>
  );
}
