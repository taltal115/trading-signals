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

  /** Firebase compat `firebase.auth()` does not implement authStateReady; never call it (some browsers/SDK combos throw). */
  function authReady() {
    return new Promise(function (resolve) {
      const unsub = auth.onAuthStateChanged(function () {
        unsub();
        resolve();
      });
    });
  }

  const isLocalHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "[::1]";

  const googleSignInBtn = document.getElementById("google-sign-in-btn");
  const signOutBtn = document.getElementById("sign-out-btn");
  const authUser = document.getElementById("auth-user");

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
    const el = document.getElementById("auth-error");
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
    if (user && !isUserAllowed(user)) {
      await auth.signOut();
      setAuthError("This Google account is not authorized for this application.");
      setSignedIn(null);
      return;
    }
    if (user) {
      setAuthError("");
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

  async function ensureSignedIn() {
    await authReady();
    const u = auth.currentUser;
    if (!u) {
      if (isLocalHost) {
        throw new Error(
          "Not signed in. Google OAuth is not started from localhost — open the hosted dashboard to sign in (a persisted session may still work in this browser)."
        );
      }
      throw new Error("Sign in with Google first.");
    }
    if (!isUserAllowed(u)) {
      throw new Error("This Google account is not authorized for this application.");
    }
    return u;
  }

  function activatePanel(panelName) {
    document.querySelectorAll("nav.tabs .tab").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-panel") === panelName);
    });
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.toggle("active", p.id === "panel-" + panelName);
    });
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
    activatePanel("positions");
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
            return;
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
            return;
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
          if (snap.empty) {
            pHint.hidden = false;
            pHint.textContent = "No positions yet. Add one with the form above.";
            pWrap.hidden = true;
            return;
          }
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
    const googleBlock = document.getElementById("google-auth-block");
    const localhostNote = document.getElementById("localhost-auth-note");

    if (user) {
      authUser.hidden = false;
      authUser.textContent = user.email || user.uid;
      if (googleBlock) googleBlock.hidden = true;
      if (localhostNote) localhostNote.hidden = true;
      signOutBtn.hidden = false;
      subscribePositions(user.uid);
    } else {
      authUser.hidden = true;
      signOutBtn.hidden = true;
      tearDownPositionsSub();
      document.getElementById("positions-body").innerHTML = "";
      document.getElementById("positions-table-wrap").hidden = true;
      const pHint = document.getElementById("positions-hint");
      pHint.hidden = false;
      if (isLocalHost) {
        if (googleBlock) googleBlock.hidden = true;
        if (localhostNote) localhostNote.hidden = false;
        pHint.textContent =
          "Google sign-in is disabled on localhost. Open the deployed site to sign in and manage positions (or use this tab if the browser already has a session from the hosted URL).";
      } else {
        if (localhostNote) localhostNote.hidden = true;
        if (googleBlock) googleBlock.hidden = false;
        pHint.textContent = "Sign in with Google to list and save positions.";
      }
    }
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

  googleSignInBtn.addEventListener("click", async () => {
    if (isLocalHost) {
      return;
    }
    setAuthError("");
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithRedirect(provider);
    } catch (err) {
      console.warn(err);
      setAuthError(err.message || "Google sign-in failed.");
    }
  });

  signOutBtn.addEventListener("click", () => auth.signOut());

  async function bootstrapAuth() {
    let redirectUser = null;
    try {
      const cred = await auth.getRedirectResult();
      redirectUser = cred && cred.user ? cred.user : null;
    } catch (e) {
      const code = e && e.code ? String(e.code) : "";
      if (code && code !== "auth/popup-closed-by-user" && code !== "auth/cancelled-popup-request") {
        console.warn(e);
        setAuthError(e.message || "Sign-in redirect failed.");
      }
    }

    await authReady();
    const initial = redirectUser || auth.currentUser;
    await applyIncomingUser(initial);

    auth.onAuthStateChanged((next) => {
      void applyIncomingUser(next);
    });
  }

  void bootstrapAuth();

  subscribeUniverseAndSignals();

  document.querySelectorAll("nav.tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.getAttribute("data-panel");
      if (name) activatePanel(name);
    });
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
