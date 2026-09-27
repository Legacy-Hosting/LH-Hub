(() => {
  const reload = document.getElementById("hub-watchdog-reload");
  reload?.addEventListener("click", () => window.location.reload());

  let runtimeError = "";
  window.addEventListener("error", (event) => {
    runtimeError = String(event.message || "script error").slice(0, 200);
  });
  window.addEventListener("unhandledrejection", (event) => {
    runtimeError = String(event.reason?.message || event.reason || "unhandled rejection").slice(0, 200);
  });

  window.setTimeout(() => {
    if (window.location.pathname !== "/infrastructure") return;
    const root = document.getElementById("root");
    const shell = root?.querySelector(".shell");
    const gate = root?.querySelector(".auth-gate");
    const error = root?.querySelector(".hub-error-screen");
    const header = shell?.querySelector("header");
    const aside = shell?.querySelector("aside");
    const visibleTextLength = root?.innerText?.trim().length || 0;
    const shellHeight = Math.round(shell?.getBoundingClientRect().height || 0);
    const headerHeight = Math.round(header?.getBoundingClientRect().height || 0);
    const asideWidth = Math.round(aside?.getBoundingClientRect().width || 0);
    const state = shell ? "shell" : gate ? "auth" : error ? "error" : root?.querySelector(".bootstrap-fallback") ? "bootstrap" : "empty";
    const blank = state === "empty" || (state === "shell" && (visibleTextLength < 20 || shellHeight < 50 || headerHeight < 20 || asideWidth < 50));
    if (blank) document.getElementById("hub-watchdog")?.removeAttribute("hidden");

    const topElement = document.elementFromPoint(Math.min(20, window.innerWidth - 1), Math.min(150, window.innerHeight - 1));
    const diagnostic = {
      version: "0.7.8",
      path: window.location.pathname,
      state,
      blank,
      rootChildCount: root?.childElementCount || 0,
      rootTextLength: root?.textContent?.length || 0,
      visibleTextLength,
      shellHeight,
      headerHeight,
      asideWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      topElement: String(topElement?.tagName || "none").slice(0, 30),
      runtimeError,
    };
    void fetch("/api/v1/client-diagnostics", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(diagnostic),
      keepalive: true,
    }).catch(() => {});
  }, 5000);
})();
