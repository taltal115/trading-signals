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
  const logoutLink = document.getElementById("logout-link");
  const navSignIn = document.getElementById("nav-sign-in");

  const ROUTE_PATHS = {
    dashboard: "/dashboard",
    universe: "/universe",
    signals: "/signals",
    positions: "/positions",
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
      window.history.replaceState(
        {},
        "",
        "/login" + window.location.search + window.location.hash
      );
      routeSyncSuppress = false;
      showLoginRoute();
      setLoginLoading(false);
      if (sessionStorage.getItem("auth_redirect_pending")) {
        sessionStorage.removeItem("auth_redirect_pending");
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
      if (!isLocalHost && auth.currentUser && isUserAllowed(auth.currentUser)) {
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
      if (
        sessionStorage.getItem("auth_redirect_pending") &&
        loginSpinner &&
        loginSpinner.hidden
      ) {
        setLoginLoading(true);
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

  if (!isLocalHost) {
    const segsInit = pathnameSegments();
    if (segsInit[0] === "login" && sessionStorage.getItem("auth_redirect_pending")) {
      setLoginLoading(true);
    }
  }

  function allowedEmailsList() {
    const raw = cfg && Array.isArray(cfg.allowedSignInEmails) ? cfg.allowedSignInEmails : [];
    return raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  }

  function isUserAllowed(user) {
    if (!user) return false;
    const allow = allowedEmailsList();
    if (allow.length === 0) return true;
    const email = (user.email || "").trim().toLowerCase();
    return Boolean(email && allow.includes(email));
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

  let exitTargetDocId = null;
  let exitEntryPrice = 0;
  let exitTicker = "";

  function tearDownPositionsSub() {
    if (typeof positionsUnsub === "function") positionsUnsub();
    positionsUnsub = null;
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
    const form = document.getElementById("position-form");
    if (gate) {
      gate.hidden = !guest;
      if (guest && isLocalHost) {
        gate.textContent =
          "Positions are disabled on localhost. Use the deployed app with Google sign-in.";
      } else if (guest) {
        gate.textContent = "Sign in with Google to manage positions.";
      }
    }
    if (form) {
      form.querySelectorAll("input, textarea, button").forEach((el) => {
        el.disabled = guest;
      });
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

  function prefillAndOpenPositions(signalDocId, s) {
    const form = document.getElementById("position-form");
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
    form.querySelector('[name="notes"]').value = "";
    document.getElementById("form-status").textContent =
      "Prefilled from bot signal — edit fill price / bracket if your execution differed.";
    navigateToRoute("positions");
    const card = document.getElementById("position-form-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
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
          sigBody.innerHTML = "";
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
            const tdTs = document.createElement("td");
            tdTs.className = "code";
            tdTs.textContent = String(d.ts_utc || "");
            const tdRun = document.createElement("td");
            tdRun.className = "code";
            tdRun.textContent = String(d.run_id || "");
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
                  prefillAndOpenPositions(doc.id, s);
                });
                ctaWrap.appendChild(b);
              });
            }
            tdCta.appendChild(ctaWrap);

            tr.appendChild(tdTs);
            tr.appendChild(tdRun);
            tr.appendChild(tdAsof);
            tr.appendChild(tdN);
            tr.appendChild(tdCta);
            sigBody.appendChild(tr);
          });
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
            const actionsCell =
              d.status === "open"
                ? "<button type=\"button\" class=\"btn-exit\" data-exit=\"" +
                  escAttr(docRef.id) +
                  "\" data-ticker=\"" +
                  escAttr(d.ticker) +
                  "\" data-entry=\"" +
                  escAttr(String(d.entry_price ?? "")) +
                  "\">Exit…</button>"
                : "";
            tr.innerHTML =
              "<td class=\"code\"><strong>" +
              esc(d.ticker) +
              "</strong></td>" +
              "<td>" +
              num(d.entry_price) +
              "</td>" +
              "<td>" +
              exitCell +
              "</td>" +
              "<td>" +
              fmtPnlHtml(d) +
              "</td>" +
              "<td>" +
              num(d.stop_price) +
              "</td>" +
              "<td>" +
              num(d.target_price) +
              "</td>" +
              "<td>" +
              esc(d.status) +
              "</td>" +
              "<td class=\"code\">" +
              esc(d.created_at_utc || "") +
              "</td>" +
              "<td>" +
              actionsCell +
              "</td>";
            pBody.appendChild(tr);
          });
          pBody.querySelectorAll(".btn-exit").forEach((btn) => {
            btn.addEventListener("click", () => {
              openExitDialog(
                btn.getAttribute("data-exit"),
                btn.getAttribute("data-ticker") || "",
                parseFloat(btn.getAttribute("data-entry") || "0")
              );
            });
          });
        },
        (err) => {
          pHint.hidden = false;
          pHint.textContent = "Positions error: " + err.message;
          renderDashboardPositionsGuest();
          console.error(err);
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
        headerUserEmail.textContent = user.email || user.uid;
        headerUserEmail.title = user.email || user.uid || "";
      }
      if (navSignIn) navSignIn.hidden = true;
      if (logoutLink) logoutLink.hidden = false;
      if (loginLocalhostNote) loginLocalhostNote.hidden = true;
      if (loginGoogleBtn) loginGoogleBtn.hidden = false;

      subscribeUniverseAndSignals();
      subscribePositions(user.uid);
      setPositionsGuestMode(false);
      applyRouteFromLocation();
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
    if (logoutLink) logoutLink.hidden = true;
    if (navSignIn && !isLocalHost) navSignIn.hidden = false;
    if (navSignIn && isLocalHost) navSignIn.hidden = true;

    subscribeUniverseAndSignals();
    tearDownPositionsSub();
    setPositionsGuestMode(true);
    resetPositionsTableGuest();
    renderDashboardPositionsGuest();
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
      sessionStorage.setItem("auth_redirect_pending", "1");
      setLoginLoading(true);
      const provider = new firebase.auth.GoogleAuthProvider();
      try {
        await auth.signInWithRedirect(provider);
      } catch (err) {
        console.warn(err);
        setAuthError(err.message || "Google sign-in failed.");
        setLoginLoading(false);
        sessionStorage.removeItem("auth_redirect_pending");
      }
    });
  }

  if (logoutLink) {
    logoutLink.addEventListener("click", (e) => {
      e.preventDefault();
      navigateToRoute("login", { replace: true });
      void auth.signOut();
    });
  }

  document.body.addEventListener("click", function (e) {
    const a = e.target.closest("a[data-route]");
    if (!a) return;
    const r = a.getAttribute("data-route");
    if (!r) return;
    e.preventDefault();
    navigateToRoute(r);
  });

  function setupLocalhostNoGoogle() {
    setAuthError("");
    hideLoginRoute();
    if (headerUserEmail) {
      headerUserEmail.hidden = false;
      headerUserEmail.textContent = "Localhost · read-only";
      headerUserEmail.title =
        "Google auth is disabled here. Universe & Signals use public Firestore reads; positions need the deployed site.";
    }
    if (logoutLink) logoutLink.hidden = true;
    if (navSignIn) navSignIn.hidden = true;
    if (loginGoogleBtn) loginGoogleBtn.hidden = true;
    if (loginLocalhostNote) loginLocalhostNote.hidden = true;
    subscribeUniverseAndSignals();
    tearDownPositionsSub();
    document.getElementById("positions-body").innerHTML = "";
    document.getElementById("positions-table-wrap").hidden = true;
    const pHint = document.getElementById("positions-hint");
    pHint.hidden = false;
    pHint.textContent =
      "Positions are disabled on localhost. Use the deployed app and Google sign-in for my_positions.";
    setPositionsGuestMode(true);
    renderDashboardPositionsGuest();
    applyRouteFromLocation();
  }

  async function bootstrapAuth() {
    let pendingNullClear = null;

    function onAuthFromFirebase(next) {
      if (next) {
        if (pendingNullClear !== null) {
          clearTimeout(pendingNullClear);
          pendingNullClear = null;
        }
        void applyIncomingUser(next);
        return;
      }
      if (pendingNullClear !== null) {
        clearTimeout(pendingNullClear);
      }
      pendingNullClear = setTimeout(() => {
        pendingNullClear = null;
        if (!auth.currentUser) {
          setLoginLoading(false);
          if (sessionStorage.getItem("auth_redirect_pending")) {
            sessionStorage.removeItem("auth_redirect_pending");
          }
          void applyIncomingUser(null);
        }
      }, 250);
    }

    auth.onAuthStateChanged(onAuthFromFirebase);

    try {
      const cred = await auth.getRedirectResult();
      if (cred && cred.user) {
        void applyIncomingUser(cred.user);
      }
    } catch (e) {
      setLoginLoading(false);
      sessionStorage.removeItem("auth_redirect_pending");
      const code = e && e.code ? String(e.code) : "";
      if (code && code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
        console.warn(e);
        setAuthError(e.message || "Sign-in redirect failed.");
      }
    }
  }

  if (isLocalHost) {
    void auth.signOut().finally(function () {
      setupLocalhostNoGoogle();
    });
  } else {
    void bootstrapAuth();
  }

  window.addEventListener("popstate", function () {
    applyRouteFromLocation();
  });

  if (!isLocalHost) {
    applyRouteFromLocation();
  }

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
      alert("Could not save exit: " + err.message);
    }
  });

  posForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    formStatus.textContent = "";
    let user;
    try {
      user = await ensureSignedIn();
    } catch (err) {
      formStatus.textContent = err && err.message ? err.message : String(err);
      return;
    }
    if (!user) {
      formStatus.textContent = "No Firebase user — check Auth configuration.";
      return;
    }
    const fd = new FormData(posForm);
    const ticker = String(fd.get("ticker") || "")
      .trim()
      .toUpperCase();
    const entry = parseFloat(fd.get("entry_price"));
    if (!ticker || !Number.isFinite(entry)) {
      formStatus.textContent = "Ticker and entry price required.";
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
      notes,
      status: "open",
      created_at_utc: new Date().toISOString(),
    };

    try {
      await db.collection(COL_MY_POSITIONS).add(payload);
      formStatus.textContent = "Saved to my_positions.";
      posForm.reset();
    } catch (err) {
      formStatus.textContent = "Error: " + err.message;
      console.error(err);
    }
  });
})();
