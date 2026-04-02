/* global firebase */
(function () {
  const COL_MY_POSITIONS = "my_positions";

  const cfg = window.firebaseConfig;
  const warnEl = document.getElementById("config-warn");

  function showConfigError(msg) {
    warnEl.hidden = false;
    warnEl.textContent = msg;
  }

  if (
    !cfg ||
    !cfg.apiKey ||
    cfg.apiKey === "YOUR_API_KEY" ||
    !cfg.projectId ||
    cfg.projectId === "YOUR_PROJECT_ID"
  ) {
    showConfigError(
      "Edit web/firebase-config.js with your Firebase web app credentials (see firebase-config.example.js)."
    );
  }

  try {
    firebase.initializeApp(cfg || {});
  } catch (e) {
    showConfigError("Firebase init failed: " + (e && e.message ? e.message : String(e)));
    const bootErr = document.getElementById("app-boot-screen");
    if (bootErr) bootErr.hidden = true;
    return;
  }

  const auth = firebase.auth();
  const db = firebase.firestore();

  if (typeof auth.authStateReady !== "function") {
    auth.authStateReady = function polyfillAuthStateReady() {
      return new Promise(function (resolve) {
        const unsub = auth.onAuthStateChanged(function () {
          unsub();
          resolve();
        });
      });
    };
  }

  const isLocalHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "[::1]";

  const loginScreen = document.getElementById("login-screen");
  const appShell = document.getElementById("app-shell");
  const loginGoogleBtn = document.getElementById("login-google-btn");
  const loginSpinner = document.getElementById("login-spinner");
  const loginLocalhostNote = document.getElementById("login-localhost-note");
  const headerUserEmail = document.getElementById("header-user-email");
  const logoutBtn = document.getElementById("logout-btn");
  const navSignIn = document.getElementById("nav-sign-in");
  const appLayout = document.getElementById("app-layout");
  const sidebarCollapseToggle = document.getElementById("sidebar-collapse-toggle");
  const mobileNavOpen = document.getElementById("mobile-nav-open");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");
  const SIDEBAR_COLLAPSED_KEY = "signals-sidebar-collapsed";
  const MOBILE_NAV_MQ = window.matchMedia("(max-width: 900px)");

  function isMobileSidebar() {
    return MOBILE_NAV_MQ.matches;
  }

  function setMobileSidebarOpen(open) {
    if (!appLayout || !sidebarBackdrop || !mobileNavOpen) return;
    appLayout.classList.toggle("sidebar-mobile-open", open);
    sidebarBackdrop.hidden = !open;
    mobileNavOpen.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("nav-drawer-open", open);
  }

  function applyStoredSidebarCollapsed() {
    if (!appLayout || !sidebarCollapseToggle || isMobileSidebar()) return;
    try {
      if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
        appLayout.classList.add("sidebar-collapsed");
        sidebarCollapseToggle.setAttribute("aria-expanded", "false");
        sidebarCollapseToggle.title = "Expand menu";
      }
    } catch (e) {
      /* ignore */
    }
  }

  if (sidebarCollapseToggle && appLayout) {
    sidebarCollapseToggle.addEventListener("click", () => {
      if (isMobileSidebar()) return;
      appLayout.classList.toggle("sidebar-collapsed");
      const collapsed = appLayout.classList.contains("sidebar-collapsed");
      sidebarCollapseToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      sidebarCollapseToggle.title = collapsed ? "Expand menu" : "Collapse menu";
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
      } catch (e) {
        /* ignore */
      }
    });
  }

  if (mobileNavOpen && appLayout) {
    mobileNavOpen.addEventListener("click", () => {
      const open = !appLayout.classList.contains("sidebar-mobile-open");
      setMobileSidebarOpen(open);
    });
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", () => setMobileSidebarOpen(false));
  }

  function onMobileNavMqChange(fn) {
    if (typeof MOBILE_NAV_MQ.addEventListener === "function") {
      MOBILE_NAV_MQ.addEventListener("change", fn);
    } else if (typeof MOBILE_NAV_MQ.addListener === "function") {
      MOBILE_NAV_MQ.addListener(fn);
    }
  }
  onMobileNavMqChange(() => {
    if (!isMobileSidebar()) {
      setMobileSidebarOpen(false);
      applyStoredSidebarCollapsed();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (appLayout && appLayout.classList.contains("sidebar-mobile-open")) {
      setMobileSidebarOpen(false);
    }
  });

  const ROUTE_PATHS = {
    dashboard: "/dashboard",
    universe: "/universe",
    signals: "/signals",
    positions: "/positions",
    monitor: "/monitor",
    about: "/about",
    "about-run": "/about/run",
    "about-universe": "/about/universe",
    "about-monitor": "/about/monitor",
    login: "/login",
  };

  const ROUTE_TO_PANEL = {
    dashboard: "panel-dashboard",
    universe: "panel-universe",
    signals: "panel-signals",
    positions: "panel-positions",
    monitor: "panel-monitor",
    about: "panel-about",
    "about-run": "panel-about-run",
    "about-universe": "panel-about-universe",
    "about-monitor": "panel-about-monitor",
  };

  let routeSyncSuppress = false;

  function routeKeyToPath(routeKey) {
    return ROUTE_PATHS[routeKey] || ROUTE_PATHS.dashboard;
  }

  function pathnameSegments() {
    let path = window.location.pathname.replace(/\/+$/, "") || "/";
    let segs = path === "/" ? [] : path.split("/").filter(Boolean);
    if (segs[0] === "index.html") segs = segs.slice(1);
    return segs;
  }

  function segmentsToRoute(segs) {
    if (!segs.length) return "dashboard";
    const a = segs[0];
    if (a === "dashboard") return "dashboard";
    if (a === "universe") return "universe";
    if (a === "signals") return "signals";
    if (a === "positions") return "positions";
    if (a === "monitor") return "monitor";
    if (a === "login") return "login";
    if (a === "about") {
      const b = segs[1];
      if (b === "run") return "about-run";
      if (b === "universe") return "about-universe";
      if (b === "monitor") return "about-monitor";
      return "about";
    }
    return "dashboard";
  }

  function navigateToRoute(routeKey, opts) {
    if (isLocalHost && (routeKey === "login" || routeKey === "logout")) {
      routeKey = "dashboard";
      opts = Object.assign({}, opts, { replace: true });
    }
    const replace = opts && opts.replace;
    const path = routeKeyToPath(routeKey);
    const tail = window.location.search + window.location.hash;
    if (replace) {
      window.history.replaceState({ route: routeKey }, "", path + tail);
    } else {
      window.history.pushState({ route: routeKey }, "", path + tail);
    }
    applyRouteFromLocation();
  }

  function updateNavActive(routeKey) {
    document.querySelectorAll(".nav-link[data-route]").forEach((a) => {
      const r = a.getAttribute("data-route");
      const aboutFamily = r === "about" && String(routeKey).indexOf("about") === 0;
      a.classList.toggle("active", r === routeKey || aboutFamily);
    });
  }

  function activateRoute(routeKey) {
    const panelId = ROUTE_TO_PANEL[routeKey];
    if (!panelId) return;
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("active", p.id === panelId);
    });
    updateNavActive(routeKey);
  }

  function showLoginRoute() {
    if (loginScreen) loginScreen.hidden = false;
    if (appShell) appShell.hidden = true;
  }

  function hideLoginRoute() {
    if (loginScreen) loginScreen.hidden = true;
    if (appShell) appShell.hidden = false;
  }

  function applyRouteFromLocation() {
    let segs = pathnameSegments();

    if (segs[0] === "logout") {
      if (!isLocalHost) {
        void auth.signOut();
      }
      routeSyncSuppress = true;
      const tail = window.location.search + window.location.hash;
      if (isLocalHost) {
        window.history.replaceState({}, "", "/dashboard" + tail);
      } else {
        window.history.replaceState({}, "", "/login" + tail);
      }
      routeSyncSuppress = false;
      setLoginLoading(false);
      if (sessionStorage.getItem("auth_redirect_pending")) {
        sessionStorage.removeItem("auth_redirect_pending");
      }
      if (isLocalHost) {
        hideLoginRoute();
        activateRoute("dashboard");
      } else {
        showLoginRoute();
      }
      return;
    }

    if (!segs.length) {
      if (!routeSyncSuppress) {
        routeSyncSuppress = true;
        window.history.replaceState(
          {},
          "",
          "/dashboard" + window.location.search + window.location.hash
        );
        routeSyncSuppress = false;
      }
      segs = ["dashboard"];
    }

    const routeKey = segmentsToRoute(segs);

    if (routeKey === "login") {
      if (isLocalHost) {
        if (!routeSyncSuppress) {
          routeSyncSuppress = true;
          window.history.replaceState(
            {},
            "",
            "/dashboard" + window.location.search + window.location.hash
          );
          routeSyncSuppress = false;
        }
        hideLoginRoute();
        activateRoute("dashboard");
        sessionStorage.removeItem("auth_redirect_pending");
        return;
      }
      if (auth.currentUser && isUserAllowed(auth.currentUser)) {
        if (!routeSyncSuppress) {
          routeSyncSuppress = true;
          window.history.replaceState(
            {},
            "",
            "/dashboard" + window.location.search + window.location.hash
          );
          routeSyncSuppress = false;
        }
        hideLoginRoute();
        activateRoute("dashboard");
        return;
      }
      showLoginRoute();
      if (sessionStorage.getItem("auth_redirect_pending")) {
        setLoginLoading(true);
      } else {
        setLoginLoading(false);
      }
      return;
    }

    hideLoginRoute();
    activateRoute(routeKey);
  }

  function setLoginLoading(on) {
    if (loginSpinner) loginSpinner.hidden = !on;
    if (loginGoogleBtn) loginGoogleBtn.disabled = !!on;
  }

  function hideAppBootScreen() {
    const el = document.getElementById("app-boot-screen");
    if (el) el.hidden = true;
  }

  function allowedEmailsList() {
    const raw = cfg && Array.isArray(cfg.allowedSignInEmails) ? cfg.allowedSignInEmails : [];
    return raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  }

  function allowedAuthUidsList() {
    const raw = cfg && Array.isArray(cfg.allowedAuthUids) ? cfg.allowedAuthUids : [];
    return raw.map((u) => String(u).trim()).filter(Boolean);
  }

  /** Email for allowlist: Firebase sometimes leaves user.email empty until provider data is loaded. */
  function primaryAccountEmail(user) {
    if (!user) return "";
    const direct = String(user.email || "")
      .trim()
      .toLowerCase();
    if (direct) return direct;
    const pd = user.providerData || [];
    for (let i = 0; i < pd.length; i++) {
      const e = String((pd[i] && pd[i].email) || "")
        .trim()
        .toLowerCase();
      if (e) return e;
    }
    return "";
  }

  function isUserAllowed(user) {
    if (!user) return false;
    const uids = allowedAuthUidsList();
    if (uids.length > 0 && uids.indexOf(user.uid) !== -1) {
      return true;
    }
    const allow = allowedEmailsList();
    if (allow.length === 0) return true;
    const email = primaryAccountEmail(user);
    return Boolean(email && allow.includes(email));
  }

  function formatFirestoreErr(err) {
    const msg = err && err.message ? err.message : String(err);
    if (err && err.code === "permission-denied") {
      return (
        msg +
        " Sign out and sign in again; deploy firestore.rules to this project. Rules allow only documents where owner_uid matches your account."
      );
    }
    return msg;
  }

  function setAuthError(msg) {
    const el = document.getElementById("login-auth-error");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
    } else {
      el.hidden = false;
      el.textContent = msg;
    }
  }

  async function applyIncomingUser(user) {
    if (isLocalHost) {
      if (user) {
        await auth.signOut();
      }
      return;
    }
    if (user) {
      try {
        await user.reload();
        await user.getIdToken(true);
      } catch (e) {
        console.warn(e);
      }
    }
    if (user && !isUserAllowed(user)) {
      await auth.signOut();
      setSignedIn(null);
      setAuthError("This Google account is not authorized for this application.");
      setLoginLoading(false);
      sessionStorage.removeItem("auth_redirect_pending");
      return;
    }
    if (user) {
      setAuthError("");
      setLoginLoading(false);
      sessionStorage.removeItem("auth_redirect_pending");
    }
    setSignedIn(user);
  }

  let universeUnsub = null;
  let signalsUnsub = null;
  let positionsUnsub = null;
  let monitorUnsub = null;

  let signalsInlineFormTrRef = null;
  let signalsInlineOpenKey = "";

  let exitTargetDocId = null;
  let exitEntryPrice = 0;
  let exitTicker = "";

  function tearDownPositionsSub() {
    if (typeof positionsUnsub === "function") positionsUnsub();
    positionsUnsub = null;
  }

  function tearDownMonitorSub() {
    if (typeof monitorUnsub === "function") monitorUnsub();
    monitorUnsub = null;
  }

  function tearDownPublicSubs() {
    if (typeof universeUnsub === "function") universeUnsub();
    if (typeof signalsUnsub === "function") signalsUnsub();
    universeUnsub = null;
    signalsUnsub = null;
  }

  function clearDashboardUniverse(msg) {
    const empty = document.getElementById("dash-universe-empty");
    const body = document.getElementById("dash-universe-body");
    if (!empty || !body) return;
    empty.hidden = false;
    empty.textContent = msg;
    body.hidden = true;
  }

  function updateDashboardUniverseCard(d, id) {
    const empty = document.getElementById("dash-universe-empty");
    const body = document.getElementById("dash-universe-body");
    if (!empty || !body) return;
    const symbols = Array.isArray(d.symbols) ? d.symbols : [];
    const syms = symbols.length;
    empty.hidden = true;
    body.hidden = false;
    body.innerHTML =
      "<p><strong>" +
      esc(d.asof_date || id) +
      "</strong> · " +
      syms +
      " symbols</p>" +
      '<p class="dash-meta">' +
      esc(d.ts_utc || "") +
      " · " +
      esc(d.source || "") +
      "</p>";
  }

  function clearDashboardSignals(msg) {
    const empty = document.getElementById("dash-signals-empty");
    const body = document.getElementById("dash-signals-body");
    if (!empty || !body) return;
    empty.hidden = false;
    empty.textContent = msg;
    body.hidden = true;
  }

  function updateDashboardSignalsCard(d, docId, buyCount) {
    const empty = document.getElementById("dash-signals-empty");
    const body = document.getElementById("dash-signals-body");
    if (!empty || !body) return;
    empty.hidden = true;
    body.hidden = false;
    body.innerHTML =
      "<p><strong>" +
      esc(d.run_id || docId.slice(0, 8)) +
      "</strong> · " +
      buyCount +
      " BUY</p>" +
      '<p class="dash-meta">' +
      esc(d.ts_utc || "") +
      " · asof " +
      esc(d.asof_date || "") +
      "</p>";
  }

  function renderDashboardPositionsGuest() {
    const empty = document.getElementById("dash-positions-empty");
    const body = document.getElementById("dash-positions-body");
    if (!empty || !body) return;
    body.hidden = true;
    empty.hidden = false;
    if (isLocalHost) {
      empty.textContent = "Positions disabled on localhost.";
    } else {
      empty.textContent = "Sign in to load my_positions.";
    }
  }

  function updateDashboardPositionsSummary(openC, closedC, emptySnap) {
    const elEmpty = document.getElementById("dash-positions-empty");
    const elBody = document.getElementById("dash-positions-body");
    if (!elEmpty || !elBody) return;
    if (emptySnap) {
      elEmpty.hidden = false;
      elEmpty.textContent = "No positions yet. Log a fill from Signals.";
      elBody.hidden = true;
      return;
    }
    elEmpty.hidden = true;
    elBody.hidden = false;
    elBody.innerHTML =
      "<p><strong>" +
      openC +
      "</strong> open · " +
      '<span class="dash-meta">' +
      closedC +
      " closed (recent)</span></p>";
  }

  function setPositionsGuestMode(guest) {
    const gate = document.getElementById("positions-gate");
    const forms = [
      document.getElementById("position-form"),
      document.getElementById("signals-inline-position-form"),
    ].filter(Boolean);
    if (gate) {
      gate.hidden = !guest;
      if (guest && isLocalHost) {
        gate.textContent =
          "Positions are disabled on localhost. Use the deployed app with Google sign-in.";
      } else if (guest) {
        gate.textContent = "Sign in with Google to manage positions.";
      }
    }
    forms.forEach((form) => {
      form.querySelectorAll("input, textarea, button").forEach((el) => {
        el.disabled = guest;
      });
    });
  }

  function setMonitorGuestMode(guest) {
    var gate = document.getElementById("monitor-gate");
    var hint = document.getElementById("monitor-hint");
    var wrap = document.getElementById("monitor-table-wrap");
    if (gate) {
      gate.hidden = !guest;
      if (guest && isLocalHost) {
        gate.textContent = "Monitor is disabled on localhost.";
      } else if (guest) {
        gate.textContent = "Sign in with Google to view monitor data.";
      }
    }
    if (guest) {
      if (hint) { hint.hidden = true; }
      if (wrap) { wrap.hidden = true; }
    }
  }

  function resetPositionsTableGuest() {
    document.getElementById("positions-body").innerHTML = "";
    document.getElementById("positions-table-wrap").hidden = true;
    const pHint = document.getElementById("positions-hint");
    pHint.hidden = false;
    if (isLocalHost) {
      pHint.textContent =
        "Positions are disabled on localhost. Use the deployed app and Google sign-in for my_positions.";
    } else {
      pHint.textContent = "Sign in with Google to see positions.";
    }
  }

  async function ensureSignedIn() {
    if (isLocalHost) {
      throw new Error(
        "Positions are disabled on localhost (Google sign-in is off). Use the deployed dashboard to log a fill."
      );
    }
    await auth.authStateReady();
    const u = auth.currentUser;
    if (!u) {
      throw new Error("Sign in with Google first.");
    }
    if (!isUserAllowed(u)) {
      throw new Error("This Google account is not authorized for this application.");
    }
    return u;
  }

  async function submitOpenPositionFromForm(form, statusEl) {
    if (!form || !statusEl) return;
    statusEl.textContent = "";
    let user;
    try {
      user = await ensureSignedIn();
    } catch (err) {
      statusEl.textContent = err && err.message ? err.message : String(err);
      return;
    }
    if (!user) {
      statusEl.textContent = "No Firebase user — check Auth configuration.";
      return;
    }
    const fd = new FormData(form);
    const ticker = String(fd.get("ticker") || "")
      .trim()
      .toUpperCase();
    const entry = parseFloat(fd.get("entry_price"));
    if (!ticker || !Number.isFinite(entry)) {
      statusEl.textContent = "Ticker and entry price required.";
      return;
    }
    const qtyRaw = fd.get("quantity");
    const quantity = qtyRaw === "" || qtyRaw == null ? null : parseFloat(qtyRaw);
    const stopRaw = fd.get("stop_price");
    const targetRaw = fd.get("target_price");
    const stop_price =
      stopRaw === "" || stopRaw == null ? null : parseFloat(stopRaw);
    const target_price =
      targetRaw === "" || targetRaw == null ? null : parseFloat(targetRaw);
    const signal_doc_id = String(fd.get("signal_doc_id") || "").trim() || null;
    const holdRaw = fd.get("hold_days_from_signal");
    const hold_days_from_signal =
      holdRaw === "" || holdRaw == null ? null : parseInt(holdRaw, 10);
    const sigCloseRaw = fd.get("signal_close_price");
    const signal_close_price =
      sigCloseRaw === "" || sigCloseRaw == null ? null : parseFloat(sigCloseRaw);
    const notes = String(fd.get("notes") || "").trim() || null;

    const payload = {
      owner_uid: user.uid,
      ticker,
      entry_price: entry,
      quantity: quantity != null && Number.isFinite(quantity) ? quantity : null,
      stop_price: stop_price != null && Number.isFinite(stop_price) ? stop_price : null,
      target_price:
        target_price != null && Number.isFinite(target_price) ? target_price : null,
      signal_doc_id,
      hold_days_from_signal:
        hold_days_from_signal != null && Number.isFinite(hold_days_from_signal)
          ? hold_days_from_signal
          : null,
      signal_close_price:
        signal_close_price != null && Number.isFinite(signal_close_price)
          ? signal_close_price
          : null,
      notes,
      status: "open",
      created_at_utc: new Date().toISOString(),
    };

    try {
      await db.collection(COL_MY_POSITIONS).add(payload);
      statusEl.textContent = "Saved to my_positions.";
      form.reset();
    } catch (err) {
      statusEl.textContent = "Error: " + formatFirestoreErr(err);
      console.error(err);
    }
  }

  function fillPositionFormFromSignal(form, signalDocId, s) {
    if (!form || !s) return;
    const setNum = (name, v) => {
      const el = form.querySelector('[name="' + name + '"]');
      if (!el) return;
      if (v == null || v === "") el.value = "";
      else el.value = String(Number(v));
    };
    form.querySelector('[name="ticker"]').value = String(s.ticker || "")
      .trim()
      .toUpperCase();
    setNum("entry_price", s.close);
    setNum("stop_price", s.stop);
    setNum("target_price", s.target);
    form.querySelector('[name="signal_doc_id"]').value = signalDocId || "";
    const hd = s.hold_days;
    const hdEl = form.querySelector('[name="hold_days_from_signal"]');
    if (hdEl) hdEl.value = hd != null && hd !== "" ? String(hd) : "";
    setNum("signal_close_price", s.close);
    form.querySelector('[name="notes"]').value = "";
  }

  function collapseSignalsInlineForm() {
    if (!signalsInlineFormTrRef) return;
    const wrap = signalsInlineFormTrRef.querySelector(".signals-inline-form-slide");
    if (!wrap) {
      signalsInlineFormTrRef.hidden = true;
      signalsInlineOpenKey = "";
      return;
    }
    if (!wrap.classList.contains("is-expanded")) {
      signalsInlineFormTrRef.hidden = true;
      signalsInlineOpenKey = "";
      return;
    }
    const onEnd = function (e) {
      if (e.target !== wrap || e.propertyName !== "max-height") return;
      wrap.removeEventListener("transitionend", onEnd);
      signalsInlineFormTrRef.hidden = true;
    };
    wrap.addEventListener("transitionend", onEnd);
    wrap.classList.remove("is-expanded");
    signalsInlineOpenKey = "";
  }

  function getOrCreateSignalsInlineFormRow() {
    if (signalsInlineFormTrRef) return signalsInlineFormTrRef;
    const tr = document.createElement("tr");
    tr.id = "signals-inline-form-tr";
    tr.className = "signals-inline-form-tr";
    tr.hidden = true;
    const td = document.createElement("td");
    td.colSpan = 3;
    td.className = "signals-inline-form-cell";
    td.innerHTML =
      '<div class="signals-inline-form-slide">' +
      '<div class="signals-inline-form-inner">' +
      '<div class="signals-inline-form-card">' +
      '<div class="signals-inline-form-toolbar">' +
      '<span class="signals-inline-form-title">Log manual fill</span>' +
      '<button type="button" class="signals-inline-form-close">Hide</button>' +
      "</div>" +
      '<form id="signals-inline-position-form">' +
      '<div class="form-grid">' +
      "<label>Ticker <input name=\"ticker\" required maxlength=\"8\" placeholder=\"AAPL\" /></label>" +
      '<label>Entry price <input name="entry_price" type="number" step="any" required min="0" /></label>' +
      '<label>Quantity (optional) <input name="quantity" type="number" step="any" min="0" placeholder="100" /></label>' +
      '<label>Stop price <input name="stop_price" type="number" step="any" min="0" placeholder="bracket stop" /></label>' +
      '<label>Target price <input name="target_price" type="number" step="any" min="0" placeholder="take profit" /></label>' +
      '<label>Linked signal doc ID (optional) <input name="signal_doc_id" placeholder="Firestore document id" /></label>' +
      '<label>Hold days (optional) <input name="hold_days_from_signal" type="number" min="1" max="30" placeholder="5" /></label>' +
      '<label>Signal close price <input name="signal_close_price" type="number" step="any" min="0" placeholder="market close at signal" /></label>' +
      "</div>" +
      '<label class="signals-inline-notes-label">Notes <textarea name="notes" placeholder="Bracket type, broker, etc."></textarea></label>' +
      '<div class="form-actions"><button type="submit">Save open position</button></div>' +
      '<p id="signals-inline-form-status" class="signals-inline-form-status"></p>' +
      "</form>" +
      "</div></div></div>";
    tr.appendChild(td);
    tr.querySelector(".signals-inline-form-close").addEventListener("click", () => {
      collapseSignalsInlineForm();
    });
    tr.querySelector("#signals-inline-position-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const formEl = tr.querySelector("#signals-inline-position-form");
      const statusEl = tr.querySelector("#signals-inline-form-status");
      await submitOpenPositionFromForm(formEl, statusEl);
    });
    signalsInlineFormTrRef = tr;
    const guest =
      isLocalHost ||
      !auth.currentUser ||
      (auth.currentUser && !isUserAllowed(auth.currentUser));
    setPositionsGuestMode(guest);
    return tr;
  }

  function openOrToggleSignalsInlineForm(dataRow, signalDocId, s) {
    const key =
      signalDocId +
      "\t" +
      String(s.ticker || "")
        .trim()
        .toUpperCase();
    const formTr = getOrCreateSignalsInlineFormRow();
    const wrap = formTr.querySelector(".signals-inline-form-slide");
    const statusEl = formTr.querySelector("#signals-inline-form-status");
    const isToggleClose =
      signalsInlineOpenKey === key && wrap.classList.contains("is-expanded");
    if (isToggleClose) {
      collapseSignalsInlineForm();
      return;
    }
    signalsInlineOpenKey = key;
    wrap.classList.remove("is-expanded");
    void wrap.offsetHeight;
    formTr.hidden = false;
    dataRow.insertAdjacentElement("afterend", formTr);
    fillPositionFormFromSignal(formTr.querySelector("#signals-inline-position-form"), signalDocId, s);
    if (statusEl) {
      statusEl.textContent =
        "Prefilled from bot signal — edit fields if your fill or bracket differed.";
    }
    requestAnimationFrame(() => wrap.classList.add("is-expanded"));
  }

  function rowPnlClass(d) {
    if (d.status !== "closed") return "row-open";
    let p = d.pnl_pct;
    if ((p == null || p === "") && d.exit_price != null && d.entry_price != null) {
      const e = Number(d.entry_price);
      const x = Number(d.exit_price);
      if (e > 0) p = ((x - e) / e) * 100;
    }
    if (p == null || !Number.isFinite(Number(p))) return "row-flat";
    p = Number(p);
    if (p > 0.0001) return "row-profit";
    if (p < -0.0001) return "row-loss";
    return "row-flat";
  }

  function fmtPnlHtml(d) {
    if (d.status !== "closed") return "—";
    let p = d.pnl_pct;
    if ((p == null || p === "") && d.exit_price != null && d.entry_price != null) {
      const e = Number(d.entry_price);
      const x = Number(d.exit_price);
      if (e > 0) p = ((x - e) / e) * 100;
    }
    if (p == null || !Number.isFinite(Number(p))) return "—";
    p = Number(p);
    const cls = p > 0.0001 ? "pnl-profit" : p < -0.0001 ? "pnl-loss" : "pnl-flat";
    const sign = p > 0 ? "+" : "";
    return '<span class="' + cls + '">' + sign + p.toFixed(2) + "%</span>";
  }

  function subscribeUniverseAndSignals() {
    tearDownPublicSubs();

    const uBody = document.getElementById("universe-body");
    const uWrap = document.getElementById("universe-table-wrap");
    const uHint = document.getElementById("universe-hint");
    uHint.hidden = false;
    uHint.textContent = "Loading…";

    universeUnsub = db
      .collection("universe")
      .orderBy("ts_utc", "desc")
      .limit(30)
      .onSnapshot(
        (snap) => {
          uBody.innerHTML = "";
          if (snap.empty) {
            uHint.hidden = false;
            uHint.textContent = "No universe documents yet. Run discovery or check the correct Firebase project.";
            uWrap.hidden = true;
            clearDashboardUniverse("No universe yet.");
            return;
          }
          const firstU = snap.docs[0];
          if (firstU) {
            updateDashboardUniverseCard(firstU.data(), firstU.id);
          }
          uHint.hidden = true;
          uWrap.hidden = false;
          snap.forEach((doc) => {
            const d = doc.data();
            const symbols = Array.isArray(d.symbols) ? d.symbols : [];
            const syms = symbols.length;

            const tr = document.createElement("tr");
            tr.className = "universe-row";
            tr.innerHTML =
              "<td class=\"code\">" +
              esc(d.asof_date || doc.id) +
              "</td>" +
              "<td class=\"code\">" +
              esc(d.ts_utc || "") +
              "</td>" +
              "<td>" +
              esc(d.source || "") +
              "</td>" +
              "<td>" +
              syms +
              "</td>" +
              "<td class=\"col-expand\" aria-hidden=\"true\">▾</td>";

            const trExp = document.createElement("tr");
            trExp.className = "universe-expand";
            trExp.hidden = true;
            const symBody = symbols
              .map(
                (sym, idx) =>
                  "<tr><td>" +
                  (idx + 1) +
                  "</td><td class=\"code\">" +
                  esc(String(sym)) +
                  "</td></tr>"
              )
              .join("");
            trExp.innerHTML =
              "<td colspan=\"5\">" +
              "<div class=\"universe-symbols-panel\">" +
              "<table>" +
              "<caption>" +
              syms +
              " symbols · " +
              esc(d.asof_date || doc.id) +
              "</caption>" +
              "<thead><tr><th>#</th><th>Symbol</th></tr></thead>" +
              "<tbody>" +
              (symBody || "<tr><td colspan=\"2\">(empty list)</td></tr>") +
              "</tbody></table></div></td>";

            tr.addEventListener("click", () => {
              const opening = trExp.hidden;
              uBody.querySelectorAll("tr.universe-expand").forEach((r) => {
                r.hidden = true;
              });
              uBody.querySelectorAll("tr.universe-row").forEach((r) => {
                r.classList.remove("is-open");
              });
              if (opening) {
                trExp.hidden = false;
                tr.classList.add("is-open");
              }
            });

            uBody.appendChild(tr);
            uBody.appendChild(trExp);
          });
        },
        (err) => {
          uHint.hidden = false;
          const extra =
            err.code === "permission-denied"
              ? " Deploy firestore.rules from this repo: firebase deploy --only firestore:rules. Check web/firebase-config.js projectId matches your Firebase project."
              : " If the console mentions an index, run: firebase deploy --only firestore:indexes";
          uHint.textContent = "Universe error: " + err.message + " —" + extra;
          clearDashboardUniverse("Universe load error.");
          console.error(err);
        }
      );

    const sigBody = document.getElementById("signals-body");
    const sigWrap = document.getElementById("signals-table-wrap");
    const sigHint = document.getElementById("signals-hint");
    sigHint.hidden = false;
    sigHint.textContent = "Loading…";

    signalsUnsub = db
      .collection("signals")
      .orderBy("ts_utc", "desc")
      .limit(25)
      .onSnapshot(
        (snap) => {
          const savedInlineTr = signalsInlineFormTrRef;
          if (savedInlineTr && savedInlineTr.parentNode) {
            savedInlineTr.parentNode.removeChild(savedInlineTr);
          }
          sigBody.innerHTML = "";
          signalsInlineOpenKey = "";
          if (savedInlineTr) {
            const w = savedInlineTr.querySelector(".signals-inline-form-slide");
            if (w) w.classList.remove("is-expanded");
            savedInlineTr.hidden = true;
          }

          if (snap.empty) {
            sigHint.hidden = false;
            sigWrap.hidden = true;
            sigHint.textContent = "No signal runs yet.";
            clearDashboardSignals("No signals yet.");
            return;
          }
          const firstS = snap.docs[0];
          if (firstS) {
            const d0 = firstS.data();
            const arr0 = Array.isArray(d0.signals) ? d0.signals : [];
            updateDashboardSignalsCard(d0, firstS.id, arr0.length);
          }
          sigHint.hidden = true;
          sigWrap.hidden = false;

          snap.forEach((doc) => {
            const d = doc.data();
            const arr = Array.isArray(d.signals) ? d.signals : [];

            const tr = document.createElement("tr");
            const tdAsof = document.createElement("td");
            tdAsof.className = "code";
            tdAsof.textContent = String(d.asof_date || "");
            const tdN = document.createElement("td");
            tdN.textContent = String(arr.length);

            const tdCta = document.createElement("td");
            tdCta.className = "cta-cell";
            const ctaWrap = document.createElement("div");
            ctaWrap.className = "cta-row";

            if (!arr.length) {
              const span = document.createElement("span");
              span.className = "muted-cell";
              span.textContent = "No BUY rows";
              ctaWrap.appendChild(span);
            } else {
              arr.forEach((s) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "btn-log-buy";
                b.textContent = "Log " + String(s.ticker || "?");
                b.addEventListener("click", (ev) => {
                  ev.stopPropagation();
                  openOrToggleSignalsInlineForm(tr, doc.id, s);
                });
                ctaWrap.appendChild(b);
              });
            }
            tdCta.appendChild(ctaWrap);

            tr.appendChild(tdAsof);
            tr.appendChild(tdN);
            tr.appendChild(tdCta);
            sigBody.appendChild(tr);
          });

          if (savedInlineTr) {
            sigBody.appendChild(savedInlineTr);
          }
        },
        (err) => {
          sigHint.hidden = false;
          sigWrap.hidden = true;
          sigHint.textContent = "Signals error: " + err.message;
          clearDashboardSignals("Signals load error.");
          console.error(err);
        }
      );
  }

  function subscribePositions(uid) {
    tearDownPositionsSub();

    const pBody = document.getElementById("positions-body");
    const pWrap = document.getElementById("positions-table-wrap");
    const pHint = document.getElementById("positions-hint");
    pHint.hidden = false;
    pHint.textContent = "Loading…";

    positionsUnsub = db
      .collection(COL_MY_POSITIONS)
      .where("owner_uid", "==", uid)
      .orderBy("created_at_utc", "desc")
      .limit(60)
      .onSnapshot(
        (snap) => {
          pBody.innerHTML = "";
          let openC = 0;
          let closedC = 0;
          if (snap.empty) {
            pHint.hidden = false;
            pHint.textContent = "No positions yet. Add one with the form above.";
            pWrap.hidden = true;
            updateDashboardPositionsSummary(0, 0, true);
            return;
          }
          snap.forEach((docRef) => {
            const d = docRef.data();
            if (d.status === "open") openC += 1;
            else closedC += 1;
          });
          updateDashboardPositionsSummary(openC, closedC, false);
          pHint.hidden = true;
          pWrap.hidden = false;
          snap.forEach((docRef) => {
            const d = docRef.data();
            const tr = document.createElement("tr");
            tr.className = rowPnlClass(d);
            const exitCell =
              d.status === "closed" && d.exit_price != null ? num(d.exit_price) : "—";

            var spotHtml = "—";
            if (d.last_spot != null && Number.isFinite(Number(d.last_spot))) {
              var staleTxt = "";
              if (d.last_alert_ts_utc) {
                var ts = String(d.last_alert_ts_utc);
                staleTxt = '<span class="spot-stale">' + esc(ts.slice(0, 16).replace("T", " ")) + "</span>";
              }
              spotHtml =
                '<span class="spot-val">' + Number(d.last_spot).toFixed(2) + "</span>" +
                staleTxt;
            }
            if (d.status === "open") {
              spotHtml +=
                ' <button type="button" class="btn-spot-refresh" data-ticker="' +
                escAttr(d.ticker) + '" title="Refresh live price">&#x21bb;</button>';
            }

            var actionsHtml = "";
            if (d.status === "open") {
              actionsHtml =
                '<button type="button" class="btn-exit" data-exit="' +
                escAttr(docRef.id) +
                '" data-ticker="' +
                escAttr(d.ticker) +
                '" data-entry="' +
                escAttr(String(d.entry_price ?? "")) +
                '">Exit…</button>' +
                ' <button type="button" class="btn-monitor-toggle" data-pos-id="' +
                escAttr(docRef.id) +
                '" data-ticker="' +
                escAttr(d.ticker) +
                '">Monitor</button>';
            }

            tr.innerHTML =
              '<td class="code"><strong>' +
              esc(d.ticker) +
              "</strong></td>" +
              "<td>" + num(d.entry_price) + "</td>" +
              "<td>" + exitCell + "</td>" +
              "<td>" + fmtPnlHtml(d) + "</td>" +
              "<td>" + num(d.stop_price) + "</td>" +
              "<td>" + num(d.target_price) + "</td>" +
              '<td class="spot-cell">' + spotHtml + "</td>" +
              "<td>" + esc(d.status) + "</td>" +
              '<td class="code">' + esc(d.created_at_utc || "") + "</td>" +
              "<td>" + actionsHtml + "</td>";

            var expandTr = document.createElement("tr");
            expandTr.className = "pos-monitor-expand";
            expandTr.hidden = true;
            expandTr.innerHTML =
              '<td colspan="10" class="pos-monitor-expand-cell">' +
              '<div class="pos-monitor-expand-inner">Loading checks…</div></td>';

            pBody.appendChild(tr);
            pBody.appendChild(expandTr);
          });

          pBody.querySelectorAll(".btn-exit").forEach(function (btn) {
            btn.addEventListener("click", function () {
              openExitDialog(
                btn.getAttribute("data-exit"),
                btn.getAttribute("data-ticker") || "",
                parseFloat(btn.getAttribute("data-entry") || "0")
              );
            });
          });

          pBody.querySelectorAll(".btn-monitor-toggle").forEach(function (btn) {
            btn.addEventListener("click", function () {
              var posId = btn.getAttribute("data-pos-id");
              var ticker = btn.getAttribute("data-ticker") || "";
              var row = btn.closest("tr");
              var expandRow = row ? row.nextElementSibling : null;
              if (!expandRow || !expandRow.classList.contains("pos-monitor-expand")) return;
              var opening = expandRow.hidden;
              pBody.querySelectorAll("tr.pos-monitor-expand").forEach(function (r) {
                r.hidden = true;
              });
              if (opening) {
                expandRow.hidden = false;
                var inner = expandRow.querySelector(".pos-monitor-expand-inner");
                if (inner) inner.innerHTML = '<span class="dash-muted">Loading checks…</span>';
                loadPositionChecks(posId, ticker, inner);
              }
            });
          });

          pBody.querySelectorAll(".btn-spot-refresh").forEach(function (btn) {
            btn.addEventListener("click", function (ev) {
              ev.stopPropagation();
              var ticker = btn.getAttribute("data-ticker");
              if (!ticker) return;
              btn.disabled = true;
              btn.textContent = "…";
              fetchLivePrice(ticker).then(function (price) {
                var cell = btn.closest(".spot-cell");
                if (cell && price != null) {
                  var valEl = cell.querySelector(".spot-val");
                  if (valEl) valEl.textContent = price.toFixed(2);
                  var staleEl = cell.querySelector(".spot-stale");
                  if (staleEl) staleEl.textContent = "just now";
                }
                btn.disabled = false;
                btn.innerHTML = "&#x21bb;";
              }).catch(function () {
                btn.disabled = false;
                btn.innerHTML = "&#x21bb;";
              });
            });
          });
        },
        (err) => {
          pHint.hidden = false;
          pHint.textContent = "Positions error: " + formatFirestoreErr(err);
          renderDashboardPositionsGuest();
          console.error(err);
        }
      );
  }

  function loadPositionChecks(posId, ticker, containerEl) {
    if (!posId || !containerEl) return;
    db.collection(COL_MY_POSITIONS)
      .doc(posId)
      .collection("checks")
      .orderBy("ts_utc", "desc")
      .limit(20)
      .get()
      .then(function (snap) {
        if (snap.empty) {
          containerEl.innerHTML = '<span class="dash-muted">No monitor checks yet for ' + esc(ticker) + '.</span>';
          return;
        }
        var rows = "";
        snap.forEach(function (doc) {
          var c = doc.data();
          var tagCls = c.tag === "SELL" ? "tag-sell" : "tag-wait";
          rows +=
            "<tr>" +
            '<td class="code">' + esc(String(c.ts_utc || "").slice(0, 19).replace("T", " ")) + "</td>" +
            '<td><span class="' + tagCls + '">' + esc(c.tag || c.alert_kind || "") + "</span></td>" +
            "<td>" + (c.confidence != null ? c.confidence : "—") + "</td>" +
            "<td>" + (c.last_spot != null ? Number(c.last_spot).toFixed(2) : "—") + "</td>" +
            "<td>" + esc(c.alert_summary || "") + "</td>" +
            "</tr>";
        });
        containerEl.innerHTML =
          '<table class="monitor-mini-table">' +
          "<thead><tr><th>timestamp</th><th>action</th><th>conf</th><th>spot</th><th>reason</th></tr></thead>" +
          "<tbody>" + rows + "</tbody></table>";
      })
      .catch(function (err) {
        containerEl.innerHTML = '<span class="dash-muted">Error loading checks: ' + esc(err.message || String(err)) + "</span>";
      });
  }

  function fetchLivePrice(ticker) {
    var stooqUrl =
      "https://stooq.com/q/l/?s=" +
      encodeURIComponent(ticker.toLowerCase()) +
      ".us&f=sd2t2ohlcv&h&e=csv";
    return fetch(stooqUrl)
      .then(function (r) {
        if (!r.ok) throw new Error("stooq " + r.status);
        return r.text();
      })
      .then(function (txt) {
        var lines = txt.trim().split("\n");
        if (lines.length < 2) return null;
        var cols = lines[0].split(",");
        var vals = lines[1].split(",");
        var closeIdx = cols.indexOf("Close");
        if (closeIdx === -1) return null;
        var p = parseFloat(vals[closeIdx]);
        return Number.isFinite(p) && p > 0 ? p : null;
      })
      .catch(function () {
        return null;
      });
  }

  function renderDashboardMonitorGuest() {
    var empty = document.getElementById("dash-monitor-empty");
    var body = document.getElementById("dash-monitor-body");
    if (!empty || !body) return;
    body.hidden = true;
    empty.hidden = false;
    empty.textContent = isLocalHost
      ? "Monitor disabled on localhost."
      : "Sign in to load monitor checks.";
  }

  function subscribeMonitor(uid) {
    tearDownMonitorSub();
    var mBody = document.getElementById("monitor-body");
    var mWrap = document.getElementById("monitor-table-wrap");
    var mHint = document.getElementById("monitor-hint");
    var mGate = document.getElementById("monitor-gate");
    if (mGate) mGate.hidden = true;
    if (mHint) { mHint.hidden = false; mHint.textContent = "Loading monitor…"; }

    monitorUnsub = db
      .collectionGroup("checks")
      .where("owner_uid", "==", uid)
      .orderBy("ts_utc", "desc")
      .limit(100)
      .onSnapshot(
        function (snap) {
          mBody.innerHTML = "";
          if (snap.empty) {
            mHint.hidden = false;
            mHint.textContent = "No monitor checks yet. The monitor job writes data here.";
            mWrap.hidden = true;
            var dashEmpty = document.getElementById("dash-monitor-empty");
            var dashBody = document.getElementById("dash-monitor-body");
            if (dashEmpty && dashBody) {
              dashEmpty.hidden = false;
              dashEmpty.textContent = "No monitor checks yet.";
              dashBody.hidden = true;
            }
            return;
          }
          mHint.hidden = true;
          mWrap.hidden = false;

          var sellCount = 0;
          var waitCount = 0;

          snap.forEach(function (doc) {
            var c = doc.data();
            if (c.tag === "SELL") sellCount++;
            else waitCount++;
            var tagCls = c.tag === "SELL" ? "tag-sell" : "tag-wait";
            var tr = document.createElement("tr");
            tr.innerHTML =
              '<td class="code"><strong>' + esc(c.ticker || "") + "</strong></td>" +
              '<td><span class="' + tagCls + '">' + esc(c.tag || c.alert_kind || "") + "</span></td>" +
              "<td>" + (c.confidence != null ? c.confidence : "—") + "</td>" +
              "<td>" + (c.last_spot != null ? Number(c.last_spot).toFixed(2) : "—") + "</td>" +
              "<td>" + esc(c.alert_summary || "") + "</td>" +
              '<td class="code">' + esc(String(c.ts_utc || "").slice(0, 19).replace("T", " ")) + "</td>";
            mBody.appendChild(tr);
          });

          var dashEmpty2 = document.getElementById("dash-monitor-empty");
          var dashBody2 = document.getElementById("dash-monitor-body");
          if (dashEmpty2 && dashBody2) {
            dashEmpty2.hidden = true;
            dashBody2.hidden = false;
            dashBody2.innerHTML =
              "<p><strong>" + sellCount + "</strong> SELL · <strong>" + waitCount + "</strong> WAIT alerts</p>" +
              '<p class="dash-meta">Latest ' + snap.size + " checks</p>";
          }
        },
        function (err) {
          mHint.hidden = false;
          mHint.textContent = "Monitor error: " + formatFirestoreErr(err);
          console.error(err);
          renderDashboardMonitorGuest();
        }
      );
  }

  function openExitDialog(docId, ticker, entryPrice) {
    if (!docId) return;
    exitTargetDocId = docId;
    exitTicker = ticker || "";
    exitEntryPrice = Number(entryPrice);
    if (!Number.isFinite(exitEntryPrice)) exitEntryPrice = 0;
    document.getElementById("exit-dialog-summary").textContent =
      (exitTicker || "(ticker)") + " · entry " + (exitEntryPrice > 0 ? exitEntryPrice.toFixed(4) : "—");
    document.getElementById("exit-price-input").value = "";
    document.getElementById("exit-notes-input").value = "";
    document.getElementById("exit-dialog").showModal();
  }

  function setSignedIn(user) {
    if (user) {
      if (headerUserEmail) {
        headerUserEmail.hidden = false;
        const label = user.email || primaryAccountEmail(user) || user.uid;
        headerUserEmail.textContent = label;
        headerUserEmail.title = label || "";
      }
      if (navSignIn) navSignIn.hidden = true;
      if (logoutBtn) logoutBtn.hidden = false;
      if (loginLocalhostNote) loginLocalhostNote.hidden = true;
      if (loginGoogleBtn) loginGoogleBtn.hidden = false;

      setLoginLoading(false);
      hideLoginRoute();

      subscribeUniverseAndSignals();
      subscribePositions(user.uid);
      subscribeMonitor(user.uid);
      setPositionsGuestMode(false);
      applyRouteFromLocation();
      applyStoredSidebarCollapsed();
      return;
    }

    setLoginLoading(false);
    if (sessionStorage.getItem("auth_redirect_pending")) {
      sessionStorage.removeItem("auth_redirect_pending");
    }
    setAuthError("");
    if (headerUserEmail) {
      headerUserEmail.hidden = true;
      headerUserEmail.textContent = "";
      headerUserEmail.title = "";
    }
    if (logoutBtn) logoutBtn.hidden = true;
    if (navSignIn && !isLocalHost) navSignIn.hidden = false;
    if (navSignIn && isLocalHost) navSignIn.hidden = true;

    if (!isLocalHost) {
      showLoginRoute();
    }

    subscribeUniverseAndSignals();
    tearDownPositionsSub();
    tearDownMonitorSub();
    setPositionsGuestMode(true);
    resetPositionsTableGuest();
    renderDashboardPositionsGuest();
    renderDashboardMonitorGuest();
    setMonitorGuestMode(true);
    applyRouteFromLocation();
  }

  function esc(s) {
    const t = String(s == null ? "" : s);
    const div = document.createElement("div");
    div.textContent = t;
    return div.innerHTML;
  }

  function escAttr(s) {
    return String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, "&quot;");
  }

  function num(x) {
    if (x == null || x === "") return "—";
    const n = Number(x);
    return Number.isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, "") : "—";
  }

  if (loginGoogleBtn) {
    loginGoogleBtn.addEventListener("click", async () => {
      if (isLocalHost) return;
      setAuthError("");
      setLoginLoading(true);
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope("profile");
      provider.addScope("email");
      try {
        await auth.signInWithPopup(provider);
        setLoginLoading(false);
      } catch (err) {
        const code = err && err.code ? String(err.code) : "";
        if (code === "auth/popup-blocked") {
          sessionStorage.setItem("auth_redirect_pending", "1");
          try {
            await auth.signInWithRedirect(provider);
          } catch (err2) {
            console.warn(err2);
            setAuthError((err2 && err2.message) || "Google sign-in failed.");
            setLoginLoading(false);
            sessionStorage.removeItem("auth_redirect_pending");
          }
          return;
        }
        if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
          setLoginLoading(false);
          return;
        }
        console.warn(err);
        setAuthError((err && err.message) || "Google sign-in failed.");
        setLoginLoading(false);
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      void auth.signOut().then(() => {
        navigateToRoute("login", { replace: true });
      });
    });
  }

  document.body.addEventListener("click", function (e) {
    const a = e.target.closest("a[data-route]");
    if (!a) return;
    const r = a.getAttribute("data-route");
    if (!r) return;
    e.preventDefault();
    if (isLocalHost && (r === "login" || r === "logout")) {
      navigateToRoute("dashboard", { replace: true });
      return;
    }
    if (a.closest("#app-sidebar") && isMobileSidebar()) {
      setMobileSidebarOpen(false);
    }
    navigateToRoute(r);
  });

  function setupLocalhostNoGoogle() {
    hideAppBootScreen();
    setAuthError("");
    hideLoginRoute();
    if (headerUserEmail) {
      headerUserEmail.hidden = false;
      headerUserEmail.textContent = "Localhost · read-only";
      headerUserEmail.title =
        "Google auth is disabled here. Universe & Signals use public Firestore reads; positions need the deployed site.";
    }
    if (logoutBtn) logoutBtn.hidden = true;
    if (navSignIn) navSignIn.hidden = true;
    if (loginGoogleBtn) loginGoogleBtn.hidden = true;
    if (loginLocalhostNote) loginLocalhostNote.hidden = true;
    subscribeUniverseAndSignals();
    tearDownPositionsSub();
    tearDownMonitorSub();
    document.getElementById("positions-body").innerHTML = "";
    document.getElementById("positions-table-wrap").hidden = true;
    const pHint = document.getElementById("positions-hint");
    pHint.hidden = false;
    pHint.textContent =
      "Positions are disabled on localhost. Use the deployed app and Google sign-in for my_positions.";
    setPositionsGuestMode(true);
    setMonitorGuestMode(true);
    renderDashboardPositionsGuest();
    renderDashboardMonitorGuest();
    applyRouteFromLocation();
    applyStoredSidebarCollapsed();
  }

  async function bootstrapAuth() {
    let redirectCredUser = null;
    try {
      const cred = await auth.getRedirectResult();
      if (cred && cred.user) redirectCredUser = cred.user;
    } catch (e) {
      setLoginLoading(false);
      sessionStorage.removeItem("auth_redirect_pending");
      const code = e && e.code ? String(e.code) : "";
      if (code && code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
        console.warn(e);
        setAuthError(e.message || "Sign-in redirect failed.");
      }
    }

    await auth.authStateReady();

    let initialUser = redirectCredUser || auth.currentUser;

    if (sessionStorage.getItem("auth_redirect_pending") && !initialUser) {
      await new Promise((r) => setTimeout(r, 500));
      await auth.authStateReady();
      initialUser = redirectCredUser || auth.currentUser;
    }

    if (sessionStorage.getItem("auth_redirect_pending") && !initialUser) {
      sessionStorage.removeItem("auth_redirect_pending");
      setLoginLoading(false);
    }

    await applyIncomingUser(initialUser);

    auth.onAuthStateChanged(function (next) {
      void applyIncomingUser(next);
    });
  }

  if (isLocalHost) {
    void auth.signOut().finally(function () {
      setupLocalhostNoGoogle();
    });
  } else {
    void (async function bootHosted() {
      try {
        await bootstrapAuth();
      } catch (err) {
        console.warn(err);
        setLoginLoading(false);
        sessionStorage.removeItem("auth_redirect_pending");
      } finally {
        hideAppBootScreen();
      }
      applyRouteFromLocation();
      applyStoredSidebarCollapsed();
    })();
  }

  window.addEventListener("popstate", function () {
    applyRouteFromLocation();
  });

  const posForm = document.getElementById("position-form");
  const formStatus = document.getElementById("form-status");

  const exitDialog = document.getElementById("exit-dialog");
  const exitForm = document.getElementById("exit-form");
  document.getElementById("exit-cancel-btn").addEventListener("click", () => exitDialog.close());

  exitForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = auth.currentUser;
    if (!user || !exitTargetDocId) {
      exitDialog.close();
      return;
    }
    const price = parseFloat(document.getElementById("exit-price-input").value);
    if (!Number.isFinite(price) || price <= 0) {
      alert("Enter a valid sell price.");
      return;
    }
    const notes = document.getElementById("exit-notes-input").value.trim();
    const entry = exitEntryPrice;
    const pnl_pct = entry > 0 ? ((price - entry) / entry) * 100 : null;
    const ts = new Date().toISOString();
    try {
      await db.collection(COL_MY_POSITIONS).doc(exitTargetDocId).update({
        status: "closed",
        exit_price: price,
        exit_at_utc: ts,
        exit_notes: notes || null,
        pnl_pct: pnl_pct,
        closed_at_utc: ts,
      });
      exitDialog.close();
      exitTargetDocId = null;
    } catch (err) {
      alert("Could not save exit: " + formatFirestoreErr(err));
    }
  });

  posForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    formStatus.textContent = "";
    await submitOpenPositionFromForm(posForm, formStatus);
  });
})();
