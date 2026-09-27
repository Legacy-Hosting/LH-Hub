(() => {
  const reload = document.getElementById("hub-watchdog-reload");
  reload?.addEventListener("click", () => window.location.reload());
  if (window.location.pathname !== "/infrastructure") return;

  const badge = document.getElementById("hub-diagnostic-badge");
  badge?.removeAttribute("hidden");
  let runtimeError = "";
  window.addEventListener("error", (event) => {
    runtimeError = String(event.message || "script error").slice(0, 200);
  });
  window.addEventListener("unhandledrejection", (event) => {
    runtimeError = String(event.reason?.message || event.reason || "unhandled rejection").slice(0, 200);
  });

  let lastSignature = "";
  let lastReportAt = 0;
  let inputTimer;
  const startedAt = Date.now();

  function elementDetail(element) {
    if (!element) return "none";
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const ancestry = [element, element.parentElement, element.parentElement?.parentElement]
      .filter(Boolean)
      .map((item) => {
        const classes = typeof item.className === "string" ? item.className.trim().replaceAll(/\s+/g, ".") : "";
        return `${item.tagName.toLowerCase()}#${item.id || "-"}.${classes.slice(0, 60)}`;
      }).join(">");
    return `${ancestry}|${style.position}|z=${style.zIndex}|bg=${style.backgroundColor}|rect=${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`.slice(0, 300);
  }

  function report(trigger) {
    if (document.visibilityState !== "visible") return;
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
    const centerElement = document.elementFromPoint(Math.min(500, window.innerWidth - 1), Math.min(200, window.innerHeight - 1));
    const shellStyle = shell && getComputedStyle(shell);
    const asideStyle = aside && getComputedStyle(aside);
    const signature = [state, blank, visibleTextLength, shellHeight, headerHeight, asideWidth, topElement?.tagName, centerElement?.tagName, runtimeError].join("/");
    const now = Date.now();
    if (trigger === "periodic" && signature === lastSignature && now - lastReportAt < 30_000) return;
    lastSignature = signature;
    lastReportAt = now;

    void fetch("/api/v1/client-diagnostics", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: "0.7.10",
        path: window.location.pathname,
        trigger,
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
        centerElement: String(centerElement?.tagName || "none").slice(0, 30),
        topDetail: elementDetail(topElement),
        centerDetail: elementDetail(centerElement),
        shellDisplay: String(shellStyle?.display || "none").slice(0, 30),
        shellVisibility: String(shellStyle?.visibility || "none").slice(0, 30),
        shellOpacity: String(shellStyle?.opacity || "none").slice(0, 30),
        asideDisplay: String(asideStyle?.display || "none").slice(0, 30),
        asideVisibility: String(asideStyle?.visibility || "none").slice(0, 30),
        asideOpacity: String(asideStyle?.opacity || "none").slice(0, 30),
        asideLeft: Math.round(aside?.getBoundingClientRect().left || 0),
        headerTop: Math.round(header?.getBoundingClientRect().top || 0),
        runtimeError,
      }),
      keepalive: true,
    }).catch(() => {});
  }

  window.setTimeout(() => report("load"), 5000);
  const interval = window.setInterval(() => {
    if (Date.now() - startedAt > 15 * 60_000) {
      window.clearInterval(interval);
      badge?.setAttribute("hidden", "");
      return;
    }
    report("periodic");
  }, 5000);
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".status-component-manager")) {
      window.setTimeout(() => report("after_click"), 700);
    }
  });
  document.addEventListener("input", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(".status-component-manager")) return;
    window.clearTimeout(inputTimer);
    inputTimer = window.setTimeout(() => report("after_input"), 1200);
  });
})();
