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

  var GH_REPO_OWNER = "taltal115";
  var GH_REPO_NAME = "trading-signals";
  var GH_PAT_KEY = "gh_pat_monitor";

  async function triggerMonitorWorkflow(ticker) {
    var token = null;
    try { token = localStorage.getItem(GH_PAT_KEY); } catch (e) { /* ignore */ }
    if (!token) {
      token = prompt("Enter GitHub PAT with workflow scope (stored locally):");
    }
    if (!token) throw new Error("No GitHub token provided");
    try { localStorage.setItem(GH_PAT_KEY, token); } catch (e) { /* ignore */ }

    var url =
      "https://api.github.com/repos/" + GH_REPO_OWNER + "/" + GH_REPO_NAME +
      "/actions/workflows/position-monitor.yml/dispatches";
    var res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: "main", inputs: { ticker: ticker || "" } }),
    });
    if (res.status === 401 || res.status === 403) {
      try { localStorage.removeItem(GH_PAT_KEY); } catch (e) { /* ignore */ }
      throw new Error("GitHub auth failed - token cleared, try again");
    }
    if (!res.ok) throw new Error("GitHub API error: " + res.status);
  }

  async function fetchLivePrice(ticker) {
    var apiKey = cfg.finnhubApiKey;
    if (!apiKey) throw new Error("No Finnhub API key configured");
    var url = "https://finnhub.io/api/v1/quote?symbol=" +
              encodeURIComponent(ticker) + "&token=" + apiKey;
    var res = await fetch(url);
    if (!res.ok) throw new Error("Finnhub error: " + res.status);
    var data = await res.json();
    if (data.c == null || data.c === 0) throw new Error("No price data");
    return data.c;
  }

  async function fetchDailyCandles(ticker, days) {
    var apiKey = cfg.alphaVantageApiKey || "demo";
    var url = "https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=" +
              encodeURIComponent(ticker) + "&outputsize=compact&apikey=" + apiKey;

    var res = await fetch(url);
    if (!res.ok) throw new Error("Alpha Vantage error: " + res.status);
    var data = await res.json();

    if (data["Error Message"]) {
      throw new Error("Invalid ticker symbol");
    }
    if (data["Note"]) {
      throw new Error("API limit reached (25/day)");
    }

    var timeSeries = data["Time Series (Daily)"];
    if (!timeSeries) {
      throw new Error("No data available");
    }

    var dates = Object.keys(timeSeries).sort().reverse();
    var len = Math.min(days, dates.length);
    dates = dates.slice(0, len).reverse();

    var times = [];
    var closes = [];
    var opens = [];

    for (var i = 0; i < dates.length; i++) {
      var dateStr = dates[i];
      var dayData = timeSeries[dateStr];
      times.push(Math.floor(new Date(dateStr).getTime() / 1000));
      closes.push(parseFloat(dayData["4. close"]));
      opens.push(parseFloat(dayData["1. open"]));
    }

    return { t: times, c: closes, o: opens };
  }

  function drawPriceChart(canvas, candles, entryPrice, buyDateTs) {
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    var width = rect.width;
    var height = rect.height;

    var padding = { top: 25, right: 55, bottom: 30, left: 10 };
    var chartW = width - padding.left - padding.right;
    var chartH = height - padding.top - padding.bottom;

    var prices = candles.c;
    var minPrice = Math.min.apply(null, prices);
    var maxPrice = Math.max.apply(null, prices);
    if (entryPrice > 0) {
      minPrice = Math.min(minPrice, entryPrice);
      maxPrice = Math.max(maxPrice, entryPrice);
    }
    var priceRange = maxPrice - minPrice || 1;
    minPrice -= priceRange * 0.08;
    maxPrice += priceRange * 0.08;
    priceRange = maxPrice - minPrice;

    ctx.clearRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(128,128,128,0.2)";
    ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var gy = padding.top + (chartH * g / 4);
      ctx.beginPath();
      ctx.moveTo(padding.left, gy);
      ctx.lineTo(width - padding.right, gy);
      ctx.stroke();
    }

    if (entryPrice > 0) {
      var entryY = padding.top + chartH - ((entryPrice - minPrice) / priceRange) * chartH;
      ctx.strokeStyle = "rgba(61, 214, 198, 0.6)";
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(padding.left, entryY);
      ctx.lineTo(width - padding.right, entryY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(61, 214, 198, 0.9)";
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("Entry $" + entryPrice.toFixed(2), width - padding.right + 4, entryY + 3);
    }

    var points = [];
    var buyPointIdx = -1;
    var buyDateDay = buyDateTs ? new Date(buyDateTs).toDateString() : null;

    for (var i = 0; i < prices.length; i++) {
      var x = padding.left + (i / (prices.length - 1)) * chartW;
      var y = padding.top + chartH - ((prices[i] - minPrice) / priceRange) * chartH;
      var pointDate = new Date(candles.t[i] * 1000);
      points.push({ x: x, y: y, price: prices[i], date: pointDate });

      if (buyDateDay && pointDate.toDateString() === buyDateDay) {
        buyPointIdx = i;
      }
    }

    var lastPrice = prices[prices.length - 1];
    var firstPrice = prices[0];
    var isUp = lastPrice >= firstPrice;
    var lineColor = isUp ? "rgba(63, 185, 80, 1)" : "rgba(248, 81, 73, 1)";
    var fillColor = isUp ? "rgba(63, 185, 80, 0.15)" : "rgba(248, 81, 73, 0.15)";

    ctx.beginPath();
    ctx.moveTo(points[0].x, padding.top + chartH);
    for (var j = 0; j < points.length; j++) {
      ctx.lineTo(points[j].x, points[j].y);
    }
    ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var k = 1; k < points.length; k++) {
      ctx.lineTo(points[k].x, points[k].y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    for (var m = 0; m < points.length; m++) {
      var prev = m > 0 ? prices[m - 1] : candles.o[m];
      var dotUp = prices[m] >= prev;
      ctx.beginPath();
      ctx.arc(points[m].x, points[m].y, 3, 0, Math.PI * 2);
      ctx.fillStyle = dotUp ? "rgba(63, 185, 80, 1)" : "rgba(248, 81, 73, 1)";
      ctx.fill();
    }

    if (buyPointIdx >= 0) {
      var bp = points[buyPointIdx];
      ctx.fillStyle = "rgba(61, 214, 198, 1)";
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bp.x, bp.y - 6);
      ctx.lineTo(bp.x, bp.y - 22);
      ctx.strokeStyle = "rgba(61, 214, 198, 1)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(bp.x, bp.y - 22);
      ctx.lineTo(bp.x - 6, bp.y - 28);
      ctx.lineTo(bp.x - 6, bp.y - 38);
      ctx.lineTo(bp.x + 6, bp.y - 38);
      ctx.lineTo(bp.x + 6, bp.y - 28);
      ctx.closePath();
      ctx.fillStyle = "rgba(61, 214, 198, 1)";
      ctx.fill();

      ctx.fillStyle = "#000";
      ctx.font = "bold 9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("BUY", bp.x, bp.y - 30);
    }

    ctx.fillStyle = "rgba(128,128,128,0.7)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    for (var p = 0; p <= 4; p++) {
      var priceVal = maxPrice - (priceRange * p / 4);
      var py = padding.top + (chartH * p / 4);
      ctx.fillText("$" + priceVal.toFixed(2), width - 4, py + 3);
    }

    ctx.textAlign = "center";
    var labelCount = Math.min(5, points.length);
    for (var d = 0; d < labelCount; d++) {
      var idx = Math.floor(d * (points.length - 1) / (labelCount - 1));
      var dateLabel = points[idx].date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      ctx.fillText(dateLabel, points[idx].x, height - 8);
    }

    var latestPnl = entryPrice > 0 ? ((lastPrice - entryPrice) / entryPrice * 100) : 0;
    var pnlText = (latestPnl >= 0 ? "+" : "") + latestPnl.toFixed(2) + "%";
    ctx.textAlign = "left";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillStyle = isUp ? "rgba(63, 185, 80, 1)" : "rgba(248, 81, 73, 1)";
    ctx.fillText("$" + lastPrice.toFixed(2) + " (" + pnlText + ")", padding.left + 5, padding.top - 8);

    return { points: points, entryPrice: entryPrice };
  }

  async function loadPriceHistory(ticker, entryPrice, buyDateStr, containerEl) {
    try {
      var candles = await fetchDailyCandles(ticker, 20);
      var buyDateTs = buyDateStr ? new Date(buyDateStr).getTime() : null;

      containerEl.innerHTML =
        '<div class="history-chart-wrap">' +
        '<canvas class="history-chart-canvas"></canvas>' +
        '<div class="chart-tooltip" hidden></div>' +
        '</div>';

      var canvas = containerEl.querySelector(".history-chart-canvas");
      var tooltip = containerEl.querySelector(".chart-tooltip");

      if (canvas) {
        var chartData = drawPriceChart(canvas, candles, entryPrice, buyDateTs);
        var points = chartData.points;

        canvas.addEventListener("mousemove", function (e) {
          var rect = canvas.getBoundingClientRect();
          var mx = e.clientX - rect.left;
          var my = e.clientY - rect.top;

          var closest = null;
          var closestDist = Infinity;
          for (var i = 0; i < points.length; i++) {
            var dx = points[i].x - mx;
            var dy = points[i].y - my;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < closestDist && dist < 30) {
              closestDist = dist;
              closest = points[i];
            }
          }

          if (closest && tooltip) {
            var dateStr = closest.date.toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric"
            });
            var pnl = entryPrice > 0 ? ((closest.price - entryPrice) / entryPrice * 100) : 0;
            var pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + "%";
            var pnlCls = pnl > 0 ? "tip-profit" : (pnl < 0 ? "tip-loss" : "");

            tooltip.innerHTML =
              '<div class="tip-date">' + dateStr + '</div>' +
              '<div class="tip-price">$' + closest.price.toFixed(2) + '</div>' +
              '<div class="tip-pnl ' + pnlCls + '">' + pnlStr + '</div>';

            var tipX = closest.x + 10;
            var tipY = closest.y - 10;
            if (tipX + 100 > rect.width) tipX = closest.x - 110;
            if (tipY < 10) tipY = closest.y + 20;

            tooltip.style.left = tipX + "px";
            tooltip.style.top = tipY + "px";
            tooltip.hidden = false;
          } else if (tooltip) {
            tooltip.hidden = true;
          }
        });

        canvas.addEventListener("mouseleave", function () {
          if (tooltip) tooltip.hidden = true;
        });
      }
    } catch (err) {
      containerEl.innerHTML = '<span class="dash-muted">Error: ' + err.message + '</span>';
    }
  }

  async function triggerBotScanWorkflow(ticker) {
    var token = null;
    try { token = localStorage.getItem(GH_PAT_KEY); } catch (e) { /* ignore */ }
    if (!token) {
      token = prompt("Enter GitHub PAT with workflow scope (stored locally):");
    }
    if (!token) throw new Error("No GitHub token provided");
    try { localStorage.setItem(GH_PAT_KEY, token); } catch (e) { /* ignore */ }

    var url =
      "https://api.github.com/repos/" + GH_REPO_OWNER + "/" + GH_REPO_NAME +
      "/actions/workflows/trading-bot-scan.yml/dispatches";
    var res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ ref: "main", inputs: { ticker: ticker || "" } }),
    });
    if (res.status === 401 || res.status === 403) {
      try { localStorage.removeItem(GH_PAT_KEY); } catch (e) { /* ignore */ }
      throw new Error("GitHub auth failed - token cleared, try again");
    }
    if (!res.ok) throw new Error("GitHub API error: " + res.status);
  }

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

  function addTradingDays(startDate, tradingDays) {
    var date = new Date(startDate);
    var added = 0;
    while (added < tradingDays) {
      date.setDate(date.getDate() + 1);
      var day = date.getDay();
      if (day !== 0 && day !== 6) {
        added++;
      }
    }
    return date;
  }

  function countTradingDaysBetween(startDate, endDate) {
    var start = new Date(startDate);
    var end = new Date(endDate);
    var count = 0;
    var current = new Date(start);
    while (current < end) {
      current.setDate(current.getDate() + 1);
      var day = current.getDay();
      if (day !== 0 && day !== 6) {
        count++;
      }
    }
    return count;
  }

  var positionsDataCache = [];
  var positionsSortKey = "bought_at";
  var positionsSortDir = "desc";
  var hideClosedPositions = false;
  var livePricesCache = {};
  var previousDayPricesCache = {};
  var priceRefreshInterval = null;

  function calculatePnlForPosition(d) {
    var entry = d.entry_price != null ? Number(d.entry_price) : null;
    var qty = d.quantity != null ? Number(d.quantity) : 1;
    if (entry == null || entry === 0) return { pnlValue: 0, pnlPct: 0 };

    var currentPrice = livePricesCache[d.ticker] || d.last_spot;
    var exitOrSpot = d.status === "closed" && d.exit_price != null
      ? Number(d.exit_price)
      : (currentPrice != null ? Number(currentPrice) : entry);

    var pnlValue = (exitOrSpot - entry) * qty;
    var pnlPct = ((exitOrSpot - entry) / entry) * 100;
    return { pnlValue: pnlValue, pnlPct: pnlPct, investment: entry * qty, currentPrice: exitOrSpot };
  }

  function calculateDailyPnl(positions) {
    var dailyPnl = 0;
    var dailyInvestment = 0;

    positions.forEach(function (pos) {
      var d = pos.data;
      if (d.status !== "open") return;

      var entry = d.entry_price != null ? Number(d.entry_price) : null;
      var qty = d.quantity != null ? Number(d.quantity) : 1;
      if (entry == null || entry === 0) return;

      var currentPrice = livePricesCache[d.ticker] || d.last_spot;
      if (currentPrice == null) return;

      var prevClose = previousDayPricesCache[d.ticker];
      if (prevClose == null) {
        prevClose = entry;
      }

      var dayChange = (Number(currentPrice) - prevClose) * qty;
      dailyPnl += dayChange;
      dailyInvestment += prevClose * qty;
    });

    var dailyPct = dailyInvestment > 0 ? (dailyPnl / dailyInvestment) * 100 : 0;
    return { pnlValue: dailyPnl, pnlPct: dailyPct };
  }

  function updatePnlCards(positions) {
    var cardsEl = document.getElementById("positions-pnl-cards");
    var totalCardEl = document.getElementById("pnl-card-total");
    var todayCardEl = document.getElementById("pnl-card-today");
    var totalValueEl = document.getElementById("pnl-total-value");
    var totalPctEl = document.getElementById("pnl-total-pct");
    var todayValueEl = document.getElementById("pnl-today-value");
    var todayPctEl = document.getElementById("pnl-today-pct");

    if (!cardsEl) return;

    var totalPnl = 0;
    var totalInvestment = 0;

    positions.forEach(function (pos) {
      var d = pos.data;
      if (d.status !== "open") return;
      var calc = calculatePnlForPosition(d);
      totalPnl += calc.pnlValue;
      totalInvestment += calc.investment || 0;
    });

    var daily = calculateDailyPnl(positions);

    cardsEl.hidden = positions.length === 0;

    var totalPct = totalInvestment > 0 ? (totalPnl / totalInvestment) * 100 : 0;

    var totalCls = totalPnl > 0.01 ? "pnl-profit" : (totalPnl < -0.01 ? "pnl-loss" : "");
    var todayCls = daily.pnlValue > 0.01 ? "pnl-profit" : (daily.pnlValue < -0.01 ? "pnl-loss" : "");
    var totalCardCls = totalPnl > 0.01 ? "pnl-card-profit" : (totalPnl < -0.01 ? "pnl-card-loss" : "");
    var todayCardCls = daily.pnlValue > 0.01 ? "pnl-card-profit" : (daily.pnlValue < -0.01 ? "pnl-card-loss" : "");

    if (totalCardEl) {
      totalCardEl.className = "pnl-card " + totalCardCls;
    }
    if (todayCardEl) {
      todayCardEl.className = "pnl-card " + todayCardCls;
    }

    totalValueEl.className = "pnl-card-value " + totalCls;
    totalValueEl.textContent = (totalPnl >= 0 ? "+$" : "-$") + Math.abs(totalPnl).toFixed(2);
    totalPctEl.className = "pnl-card-pct " + totalCls;
    totalPctEl.textContent = (totalPct >= 0 ? "+" : "") + totalPct.toFixed(2) + "%";

    todayValueEl.className = "pnl-card-value " + todayCls;
    todayValueEl.textContent = (daily.pnlValue >= 0 ? "+$" : "-$") + Math.abs(daily.pnlValue).toFixed(2);
    todayPctEl.className = "pnl-card-pct " + todayCls;
    todayPctEl.textContent = (daily.pnlPct >= 0 ? "+" : "") + daily.pnlPct.toFixed(2) + "%";
  }

  async function refreshAllLivePrices() {
    var openPositions = positionsDataCache.filter(function (p) {
      return p.data.status === "open";
    });

    for (var i = 0; i < openPositions.length; i++) {
      var ticker = openPositions[i].data.ticker;
      try {
        var price = await fetchLivePrice(ticker);
        if (price != null) {
          livePricesCache[ticker] = price;
          updateSpotCellInTable(ticker, price);
        }
      } catch (e) {
        console.warn("Failed to fetch price for " + ticker, e);
      }
    }

    var openForCards = positionsDataCache.filter(function (p) {
      return p.data.status === "open";
    });
    updatePnlCards(openForCards);
  }

  function updateSpotCellInTable(ticker, price) {
    var pBody = document.getElementById("positions-body");
    if (!pBody) return;

    pBody.querySelectorAll(".spot-cell").forEach(function (cell) {
      var btn = cell.querySelector(".btn-spot-refresh");
      if (btn && btn.getAttribute("data-ticker") === ticker) {
        var valEl = cell.querySelector(".spot-val");
        if (valEl) {
          var pos = positionsDataCache.find(function (p) { return p.data.ticker === ticker; });
          var entry = pos && pos.data.entry_price ? Number(pos.data.entry_price) : null;
          var cls = "spot-val";
          var arrow = "";
          if (entry != null && entry > 0) {
            if (price > entry) { cls = "spot-val spot-up"; arrow = " &#9650;"; }
            else if (price < entry) { cls = "spot-val spot-down"; arrow = " &#9660;"; }
          }
          valEl.className = cls;
          valEl.innerHTML = price.toFixed(2) + arrow;
        }
        var staleEl = cell.querySelector(".spot-stale");
        if (staleEl) staleEl.textContent = "live";
      }
    });
  }

  function startPriceRefreshInterval() {
    if (priceRefreshInterval) clearInterval(priceRefreshInterval);
    priceRefreshInterval = setInterval(refreshAllLivePrices, 3000);
  }

  function stopPriceRefreshInterval() {
    if (priceRefreshInterval) {
      clearInterval(priceRefreshInterval);
      priceRefreshInterval = null;
    }
  }

  async function fetchPreviousDayCloses() {
    var openPositions = positionsDataCache.filter(function (p) {
      return p.data.status === "open";
    });

    for (var i = 0; i < openPositions.length; i++) {
      var ticker = openPositions[i].data.ticker;
      if (previousDayPricesCache[ticker] != null) continue;
      try {
        var candles = await fetchDailyCandles(ticker, 2);
        if (candles.c.length >= 2) {
          previousDayPricesCache[ticker] = candles.c[candles.c.length - 2];
        } else if (candles.c.length === 1) {
          previousDayPricesCache[ticker] = candles.o[0];
        }
      } catch (e) {
        console.warn("Failed to fetch previous close for " + ticker, e);
      }
    }
  }

  function getFilteredPositions(positions) {
    if (!hideClosedPositions) return positions;
    return positions.filter(function (p) {
      return p.data.status === "open";
    });
  }

  function sortPositionsData(positions, key, dir) {
    return positions.slice().sort(function (a, b) {
      var aVal = a.data[key];
      var bVal = b.data[key];

      if (key === "hold") {
        aVal = a.data.hold_days_from_signal || a.data.estimated_hold_days || 0;
        bVal = b.data.hold_days_from_signal || b.data.estimated_hold_days || 0;
      }
      if (key === "pnl_pct") {
        var aCalc = calculatePnlForPosition(a.data);
        var bCalc = calculatePnlForPosition(b.data);
        aVal = aCalc.pnlPct;
        bVal = bCalc.pnlPct;
      }

      if (aVal == null) aVal = "";
      if (bVal == null) bVal = "";

      if (typeof aVal === "string") aVal = aVal.toLowerCase();
      if (typeof bVal === "string") bVal = bVal.toLowerCase();

      if (aVal < bVal) return dir === "asc" ? -1 : 1;
      if (aVal > bVal) return dir === "asc" ? 1 : -1;
      return 0;
    });
  }

  function setupPositionsTableSort() {
    var table = document.getElementById("positions-table");
    if (!table) return;
    var headers = table.querySelectorAll("th[data-sort]");
    headers.forEach(function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-sort");
        if (positionsSortKey === key) {
          positionsSortDir = positionsSortDir === "asc" ? "desc" : "asc";
        } else {
          positionsSortKey = key;
          positionsSortDir = "asc";
        }
        headers.forEach(function (h) {
          h.classList.remove("sort-asc", "sort-desc");
        });
        th.classList.add(positionsSortDir === "asc" ? "sort-asc" : "sort-desc");
        renderPositionsTable(sortPositionsData(positionsDataCache, positionsSortKey, positionsSortDir));
      });
    });
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
    const gate = document.getElementById("dash-positions-gate");
    const empty = document.getElementById("dash-positions-empty");
    const cards = document.getElementById("dash-positions-cards");
    if (gate) {
      gate.hidden = false;
      if (isLocalHost) {
        gate.textContent = "Positions disabled on localhost.";
      } else {
        gate.textContent = "Sign in with Google to view your positions.";
      }
    }
    if (empty) empty.hidden = true;
    if (cards) cards.hidden = true;
  }

  function updateDashboardPositionsSummary(openC, closedC, emptySnap) {
    var gate = document.getElementById("dash-positions-gate");
    var empty = document.getElementById("dash-positions-empty");
    if (gate) gate.hidden = true;
    if (empty) {
      if (emptySnap) {
        empty.hidden = false;
        empty.textContent = "No open positions. Log a fill from Signals.";
      } else {
        empty.hidden = true;
      }
    }
  }

  function renderDashboardPositionCards(openPositions) {
    var cards = document.getElementById("dash-positions-cards");
    if (!cards) return;
    if (!openPositions || openPositions.length === 0) {
      cards.hidden = true;
      return;
    }
    cards.hidden = false;
    cards.innerHTML = "";

    openPositions.forEach(function (pos) {
      var d = pos.data;
      var card = document.createElement("article");
      card.className = "position-card " + rowPnlClass(d);

      var entryF = d.entry_price != null ? Number(d.entry_price) : null;
      var spotF = d.last_spot != null ? Number(d.last_spot) : null;

      var pnlHtml = fmtPnlHtml(d);
      var spotArrow = "";
      var spotCls = "";
      if (spotF != null && entryF != null && Number.isFinite(entryF) && entryF > 0) {
        if (spotF > entryF) { spotCls = "spot-up"; spotArrow = " &#9650;"; }
        else if (spotF < entryF) { spotCls = "spot-down"; spotArrow = " &#9660;"; }
      }

      var actionHtml = "—";
      if (d.last_alert_kind) {
        var isSell = ["STOP_HIT", "TARGET_HIT", "DURATION_DUE"].indexOf(d.last_alert_kind) !== -1;
        var actionTag = isSell ? "SELL" : "WAIT";
        var actionCls = isSell ? "tag-sell" : "tag-wait";
        actionHtml = '<span class="' + actionCls + '">' + actionTag + "</span>";
      }

      var holdHtml = "—";
      var hdFrom = d.hold_days_from_signal;
      var estHold = d.estimated_hold_days;
      var effectiveHold = hdFrom != null ? hdFrom : (estHold != null ? Math.ceil(estHold) : null);
      var dueStr = "";
      var tradingDaysHeld = 0;
      var startDate = d.bought_at || d.created_at_utc;
      if (effectiveHold != null && startDate) {
        try {
          var created = new Date(startDate);
          var due = addTradingDays(created, effectiveHold);
          dueStr = due.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          tradingDaysHeld = countTradingDaysBetween(created, new Date());
        } catch (e) { /* ignore */ }
      }
      if (effectiveHold != null) {
        holdHtml = "day " + tradingDaysHeld + "/" + effectiveHold + "d";
        if (hdFrom == null && estHold != null) {
          holdHtml += " (ATR est)";
        } else if (estHold != null && estHold !== hdFrom) {
          holdHtml += " (ATR ~" + Number(estHold).toFixed(0) + "d)";
        }
      }

      var boughtAtStr = "";
      if (d.bought_at) {
        try {
          var bDate = new Date(d.bought_at);
          boughtAtStr = bDate.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
        } catch (e) { /* ignore */ }
      } else if (d.created_at_utc) {
        try {
          var cDate = new Date(d.created_at_utc);
          boughtAtStr = cDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        } catch (e) { /* ignore */ }
      }

      var spotHtml = spotF != null ? "$" + spotF.toFixed(2) : "—";

      card.innerHTML =
        '<div class="pos-card-header">' +
          '<span class="pos-card-ticker">' + esc(d.ticker || "—") + "</span>" +
          '<span class="pos-card-action">' + actionHtml + "</span>" +
        "</div>" +
        '<div class="pos-card-body">' +
          '<div class="pos-card-row">' +
            '<span class="pos-card-label">Entry</span>' +
            '<span class="pos-card-value">$' + (entryF != null ? entryF.toFixed(2) : "—") + "</span>" +
          "</div>" +
          '<div class="pos-card-row">' +
            '<span class="pos-card-label">Spot</span>' +
            '<span class="pos-card-value ' + spotCls + '">' + spotHtml + spotArrow + "</span>" +
          "</div>" +
          '<div class="pos-card-row">' +
            '<span class="pos-card-label">P/L</span>' +
            '<span class="pos-card-value">' + pnlHtml + "</span>" +
          "</div>" +
          '<div class="pos-card-row">' +
            '<span class="pos-card-label">Stop</span>' +
            '<span class="pos-card-value">' + (d.stop_price != null ? "$" + Number(d.stop_price).toFixed(2) : "—") + "</span>" +
          "</div>" +
          '<div class="pos-card-row">' +
            '<span class="pos-card-label">Target</span>' +
            '<span class="pos-card-value">' + (d.target_price != null ? "$" + Number(d.target_price).toFixed(2) : "—") + "</span>" +
          "</div>" +
          '<div class="pos-card-row">' +
            '<span class="pos-card-label">Hold</span>' +
            '<span class="pos-card-value">' + holdHtml + "</span>" +
          "</div>" +
          (dueStr ? '<div class="pos-card-row"><span class="pos-card-label">Due</span><span class="pos-card-value">' + esc(dueStr) + "</span></div>" : "") +
          (d.sector ? '<div class="pos-card-row"><span class="pos-card-label">Sector</span><span class="pos-card-value pos-card-sector">' + esc(d.sector) + "</span></div>" : "") +
          (boughtAtStr ? '<div class="pos-card-row"><span class="pos-card-label">Bought</span><span class="pos-card-value">' + esc(boughtAtStr) + "</span></div>" : "") +
        "</div>" +
        '<div class="pos-card-chart">' +
          '<canvas class="pos-card-chart-canvas" data-ticker="' + escAttr(d.ticker) + '" ' +
          'data-entry="' + escAttr(String(entryF ?? "")) + '" ' +
          'data-bought="' + escAttr(d.bought_at || d.created_at_utc || "") + '"></canvas>' +
        "</div>";

      cards.appendChild(card);
    });

    loadDashboardCardCharts();
  }

  async function loadDashboardCardCharts() {
    var canvases = document.querySelectorAll(".pos-card-chart-canvas");
    for (var i = 0; i < canvases.length; i++) {
      var canvas = canvases[i];
      var ticker = canvas.getAttribute("data-ticker");
      var entry = parseFloat(canvas.getAttribute("data-entry") || "0");
      var bought = canvas.getAttribute("data-bought") || "";

      if (!ticker) continue;

      try {
        var candles = await fetchDailyCandles(ticker, 15);
        var buyDateTs = bought ? new Date(bought).getTime() : null;
        drawMiniPriceChart(canvas, candles, entry, buyDateTs);
      } catch (e) {
        console.warn("Failed to load chart for " + ticker, e);
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "rgba(128,128,128,0.5)";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Chart unavailable", canvas.width / 2, canvas.height / 2);
      }
    }
  }

  function drawMiniPriceChart(canvas, candles, entryPrice, buyDateTs) {
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    var width = rect.width;
    var height = rect.height;

    var padding = { top: 8, right: 8, bottom: 8, left: 8 };
    var chartW = width - padding.left - padding.right;
    var chartH = height - padding.top - padding.bottom;

    var prices = candles.c;
    var minPrice = Math.min.apply(null, prices);
    var maxPrice = Math.max.apply(null, prices);
    if (entryPrice > 0) {
      minPrice = Math.min(minPrice, entryPrice);
      maxPrice = Math.max(maxPrice, entryPrice);
    }
    var priceRange = maxPrice - minPrice || 1;
    minPrice -= priceRange * 0.05;
    maxPrice += priceRange * 0.05;
    priceRange = maxPrice - minPrice;

    ctx.clearRect(0, 0, width, height);

    if (entryPrice > 0) {
      var entryY = padding.top + chartH - ((entryPrice - minPrice) / priceRange) * chartH;
      ctx.strokeStyle = "rgba(61, 214, 198, 0.4)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, entryY);
      ctx.lineTo(width - padding.right, entryY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    var points = [];
    var buyPointIdx = -1;
    var buyDateDay = buyDateTs ? new Date(buyDateTs).toDateString() : null;

    for (var i = 0; i < prices.length; i++) {
      var x = padding.left + (i / (prices.length - 1)) * chartW;
      var y = padding.top + chartH - ((prices[i] - minPrice) / priceRange) * chartH;
      var pointDate = new Date(candles.t[i] * 1000);
      points.push({ x: x, y: y, price: prices[i], date: pointDate });

      if (buyDateDay && pointDate.toDateString() === buyDateDay) {
        buyPointIdx = i;
      }
    }

    var lastPrice = prices[prices.length - 1];
    var firstPrice = prices[0];
    var isUp = lastPrice >= firstPrice;
    var lineColor = isUp ? "rgba(63, 185, 80, 1)" : "rgba(248, 81, 73, 1)";
    var fillColor = isUp ? "rgba(63, 185, 80, 0.2)" : "rgba(248, 81, 73, 0.2)";

    ctx.beginPath();
    ctx.moveTo(points[0].x, padding.top + chartH);
    for (var j = 0; j < points.length; j++) {
      ctx.lineTo(points[j].x, points[j].y);
    }
    ctx.lineTo(points[points.length - 1].x, padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var k = 1; k < points.length; k++) {
      ctx.lineTo(points[k].x, points[k].y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (buyPointIdx >= 0) {
      var bp = points[buyPointIdx];
      ctx.fillStyle = "rgba(61, 214, 198, 1)";
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    var lastPt = points[points.length - 1];
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(lastPt.x, lastPt.y, 3, 0, Math.PI * 2);
    ctx.fill();
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
    const boughtAtRaw = fd.get("bought_at");
    const bought_at = boughtAtRaw ? new Date(boughtAtRaw).toISOString() : null;
    const notes = String(fd.get("notes") || "").trim() || null;

    var meta = form._signalMeta || {};

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
      bought_at: bought_at,
      sector: meta.sector || null,
      industry: meta.industry || null,
      estimated_hold_days: meta.estimated_hold_days || null,
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
    form._signalMeta = {
      sector: s.sector || "",
      industry: s.industry || "",
      estimated_hold_days: s.estimated_hold_days || null,
    };
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
      '<label>Buy date/time <input name="bought_at" type="datetime-local" /></label>' +
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
            const symbolDetails = d.symbol_details || {};
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
                (sym, idx) => {
                  const details = symbolDetails[sym] || {};
                  const name = details.name || "";
                  const sector = details.sector || "";
                  return "<tr><td>" +
                    (idx + 1) +
                    "</td><td class=\"code\"><strong>" +
                    esc(String(sym)) +
                    "</strong></td><td>" +
                    esc(name) +
                    "</td><td><span class=\"sector-tag\">" +
                    esc(sector) +
                    "</span></td></tr>";
                }
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
              "<thead><tr><th>#</th><th>Symbol</th><th>Name</th><th>Sector</th></tr></thead>" +
              "<tbody>" +
              (symBody || "<tr><td colspan=\"4\">(empty list)</td></tr>") +
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
            const asofDate = String(d.asof_date || "");

            arr.forEach((s) => {
              const tr = document.createElement("tr");

              var tdDate = document.createElement("td");
              tdDate.className = "code";
              tdDate.textContent = asofDate;

              var tdTicker = document.createElement("td");
              tdTicker.className = "code";
              tdTicker.innerHTML = "<strong>" + esc(s.ticker || "?") + "</strong>";

              var tdSignalPrice = document.createElement("td");
              tdSignalPrice.textContent = s.close != null ? "$" + Number(s.close).toFixed(2) : "—";

              var tdLivePrice = document.createElement("td");
              tdLivePrice.className = "sig-live-cell";
              tdLivePrice.innerHTML =
                '<span class="sig-live-val">—</span>' +
                ' <button type="button" class="btn-sig-refresh" data-ticker="' +
                escAttr(s.ticker || "") + '">&#x21bb;</button>';

              var tdEntry = document.createElement("td");
              tdEntry.textContent = s.close != null ? "$" + Number(s.close).toFixed(2) : "—";

              var tdStop = document.createElement("td");
              tdStop.textContent = s.stop != null ? "$" + Number(s.stop).toFixed(2) : "—";

              var tdTarget = document.createElement("td");
              tdTarget.textContent = s.target != null ? "$" + Number(s.target).toFixed(2) : "—";

              var tdActions = document.createElement("td");
              tdActions.className = "sig-actions-cell";
              var actionsWrap = document.createElement("div");
              actionsWrap.className = "sig-actions-row";

              var btnLog = document.createElement("button");
              btnLog.type = "button";
              btnLog.className = "btn-log-buy";
              btnLog.textContent = "Log Buy";
              btnLog.addEventListener("click", function (ev) {
                ev.stopPropagation();
                openOrToggleSignalsInlineForm(tr, doc.id, s);
              });
              actionsWrap.appendChild(btnLog);

              var btnReeval = document.createElement("button");
              btnReeval.type = "button";
              btnReeval.className = "btn-reeval";
              btnReeval.textContent = "Re-eval";
              btnReeval.setAttribute("data-ticker", s.ticker || "");
              btnReeval.addEventListener("click", async function () {
                var ticker = btnReeval.getAttribute("data-ticker");
                if (!ticker) return;
                btnReeval.disabled = true;
                var origText = btnReeval.textContent;
                btnReeval.textContent = "…";
                try {
                  await triggerBotScanWorkflow(ticker);
                  btnReeval.textContent = "Triggered";
                  setTimeout(function () {
                    btnReeval.textContent = origText;
                    btnReeval.disabled = false;
                  }, 3000);
                } catch (err) {
                  console.error("Re-eval workflow error:", err);
                  btnReeval.textContent = "Error";
                  setTimeout(function () {
                    btnReeval.textContent = origText;
                    btnReeval.disabled = false;
                  }, 3000);
                }
              });
              actionsWrap.appendChild(btnReeval);

              tdActions.appendChild(actionsWrap);

              tr.appendChild(tdDate);
              tr.appendChild(tdTicker);
              tr.appendChild(tdSignalPrice);
              tr.appendChild(tdLivePrice);
              tr.appendChild(tdEntry);
              tr.appendChild(tdStop);
              tr.appendChild(tdTarget);
              tr.appendChild(tdActions);
              sigBody.appendChild(tr);
            });
          });

          sigBody.querySelectorAll(".btn-sig-refresh").forEach(function (btn) {
            btn.addEventListener("click", async function (ev) {
              ev.stopPropagation();
              var ticker = btn.getAttribute("data-ticker");
              if (!ticker) return;
              btn.disabled = true;
              btn.textContent = "…";
              var cell = btn.closest(".sig-live-cell");
              try {
                var price = await fetchLivePrice(ticker);
                if (cell) {
                  var valEl = cell.querySelector(".sig-live-val");
                  if (valEl) valEl.textContent = "$" + price.toFixed(2);
                }
              } catch (err) {
                console.error("Fetch live price error:", err);
                if (cell) {
                  var valEl = cell.querySelector(".sig-live-val");
                  if (valEl) valEl.textContent = "err";
                }
              }
              btn.disabled = false;
              btn.innerHTML = "&#x21bb;";
            });
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

  function renderPositionsTable(positions) {
    var pBody = document.getElementById("positions-body");
    if (!pBody) return;
    pBody.innerHTML = "";

    positions.forEach(function (pos) {
      var docId = pos.id;
      var d = pos.data;
      var tr = document.createElement("tr");
      tr.className = rowPnlClass(d);
      var exitCell = d.status === "closed" && d.exit_price != null ? num(d.exit_price) : "—";

      var spotHtml = "—";
      var entryF = d.entry_price != null ? Number(d.entry_price) : null;
      var spotF = d.last_spot != null ? Number(d.last_spot) : null;
      if (spotF != null && Number.isFinite(spotF)) {
        var spotCls = "spot-val";
        var arrow = "";
        if (entryF != null && Number.isFinite(entryF) && entryF > 0) {
          if (spotF > entryF) { spotCls = "spot-val spot-up"; arrow = " &#9650;"; }
          else if (spotF < entryF) { spotCls = "spot-val spot-down"; arrow = " &#9660;"; }
        }
        var staleLine = "";
        if (d.last_alert_ts_utc) {
          var tsStr = String(d.last_alert_ts_utc);
          staleLine = '<div class="spot-stale">' + esc(tsStr.slice(0, 16).replace("T", " ")) + "</div>";
        }
        var refreshBtn = "";
        if (d.status === "open") {
          refreshBtn =
            ' <button type="button" class="btn-spot-refresh" data-doc-id="' +
            escAttr(docId) + '" data-ticker="' +
            escAttr(d.ticker) + '" title="Re-fetch spot price">&#x21bb;</button>';
        }
        spotHtml =
          '<div class="spot-wrap">' +
          '<span class="' + spotCls + '">' + spotF.toFixed(2) + arrow + "</span>" +
          refreshBtn + staleLine + "</div>";
      } else if (d.status === "open") {
        spotHtml =
          '— <button type="button" class="btn-spot-refresh" data-doc-id="' +
          escAttr(docId) + '" data-ticker="' +
          escAttr(d.ticker) + '" title="Fetch spot price">&#x21bb;</button>';
      }

      var actionHtml = "—";
      if (d.last_alert_kind) {
        var isSell = ["STOP_HIT", "TARGET_HIT", "DURATION_DUE"].indexOf(d.last_alert_kind) !== -1;
        var actionTag = isSell ? "SELL" : "WAIT";
        var actionCls = isSell ? "tag-sell" : "tag-wait";
        actionHtml = '<span class="' + actionCls + '">' + actionTag + "</span>";
      }

      var actionsHtml = "";
      if (d.status === "open") {
        actionsHtml =
          '<button type="button" class="btn-exit" data-exit="' +
          escAttr(docId) +
          '" data-ticker="' +
          escAttr(d.ticker) +
          '" data-entry="' +
          escAttr(String(d.entry_price ?? "")) +
          '">Exit…</button>' +
          ' <button type="button" class="btn-monitor-toggle" data-pos-id="' +
          escAttr(docId) +
          '" data-ticker="' +
          escAttr(d.ticker) +
          '">Monitor</button>' +
          ' <button type="button" class="btn-history-toggle" data-ticker="' +
          escAttr(d.ticker) +
          '" data-entry="' +
          escAttr(String(d.entry_price ?? "")) +
          '" data-bought="' +
          escAttr(d.bought_at || d.created_at_utc || "") +
          '">History</button>' +
          ' <button type="button" class="btn-check-now" data-ticker="' +
          escAttr(d.ticker) +
          '">Check</button>';
      }

      var sectorHtml = "—";
      if (d.sector) {
        sectorHtml = '<span class="sector-tag">' + esc(d.sector) + '</span>';
      }

      var holdHtml = "—";
      var hdFrom = d.hold_days_from_signal;
      var estHold = d.estimated_hold_days;
      var effectiveHold = hdFrom != null ? hdFrom : (estHold != null ? Math.ceil(estHold) : null);
      if (effectiveHold != null) {
        holdHtml = String(effectiveHold) + "d";
        if (hdFrom == null && estHold != null) {
          holdHtml += ' <span class="hold-est">(ATR est)</span>';
        } else if (estHold != null && estHold !== hdFrom) {
          holdHtml += ' <span class="hold-est">(ATR ' + Number(estHold).toFixed(1) + 'd)</span>';
        }
        var startDate = d.bought_at || d.created_at_utc;
        if (startDate) {
          try {
            var created = new Date(startDate);
            var due = addTradingDays(created, effectiveHold);
            var dueStr = due.toLocaleDateString("en-US", { month: "short", day: "numeric" });
            var tradingDaysHeld = countTradingDaysBetween(created, new Date());
            holdHtml += '<div class="hold-due">day ' + tradingDaysHeld + '/' + effectiveHold + ' · due ' + esc(dueStr) + '</div>';
          } catch (e) { /* ignore */ }
        }
      }

      var confHtml = "—";
      if (d.last_confidence != null) {
        var confVal = Number(d.last_confidence);
        var confCls = confVal >= 70 ? "conf-high" : (confVal >= 50 ? "conf-mid" : "conf-low");
        confHtml = '<span class="' + confCls + '">' + confVal + '%</span>';
      }

      tr.innerHTML =
        '<td class="code"><strong>' +
        esc(d.ticker) +
        "</strong></td>" +
        "<td>" + sectorHtml + "</td>" +
        "<td>" + num(d.entry_price) + "</td>" +
        "<td>" + exitCell + "</td>" +
        "<td>" + fmtPnlHtml(d) + "</td>" +
        "<td>" + num(d.stop_price) + "</td>" +
        "<td>" + num(d.target_price) + "</td>" +
        "<td>" + holdHtml + "</td>" +
        '<td class="spot-cell">' + spotHtml + "</td>" +
        "<td>" + confHtml + "</td>" +
        "<td>" + actionHtml + "</td>" +
        "<td>" + esc(d.status) + "</td>" +
        '<td class="code">' + esc(d.bought_at || d.created_at_utc || "") + "</td>" +
        "<td>" + actionsHtml + "</td>";

      var expandTr = document.createElement("tr");
      expandTr.className = "pos-monitor-expand";
      expandTr.hidden = true;
      expandTr.innerHTML =
        '<td colspan="14" class="pos-monitor-expand-cell">' +
        '<div class="pos-monitor-expand-inner">Loading checks…</div></td>';

      var historyTr = document.createElement("tr");
      historyTr.className = "pos-history-expand";
      historyTr.hidden = true;
      historyTr.innerHTML =
        '<td colspan="14" class="pos-history-expand-cell">' +
        '<div class="pos-history-expand-inner">Loading price history…</div></td>';

      pBody.appendChild(tr);
      pBody.appendChild(expandTr);
      pBody.appendChild(historyTr);
    });

    attachPositionsTableHandlers(pBody);
  }

  function attachPositionsTableHandlers(pBody) {
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
        pBody.querySelectorAll("tr.pos-history-expand").forEach(function (r) {
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

    pBody.querySelectorAll(".btn-history-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var ticker = btn.getAttribute("data-ticker") || "";
        var entry = parseFloat(btn.getAttribute("data-entry") || "0");
        var bought = btn.getAttribute("data-bought") || "";
        var row = btn.closest("tr");
        var expandRow = row ? row.nextElementSibling : null;
        if (expandRow) expandRow = expandRow.nextElementSibling;
        if (!expandRow || !expandRow.classList.contains("pos-history-expand")) return;
        var opening = expandRow.hidden;
        pBody.querySelectorAll("tr.pos-monitor-expand").forEach(function (r) {
          r.hidden = true;
        });
        pBody.querySelectorAll("tr.pos-history-expand").forEach(function (r) {
          r.hidden = true;
        });
        if (opening) {
          expandRow.hidden = false;
          var inner = expandRow.querySelector(".pos-history-expand-inner");
          if (inner) {
            inner.innerHTML = '<span class="dash-muted">Loading price history…</span>';
            loadPriceHistory(ticker, entry, bought, inner);
          }
        }
      });
    });

    pBody.querySelectorAll(".btn-spot-refresh").forEach(function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        var docId = btn.getAttribute("data-doc-id");
        var ticker = btn.getAttribute("data-ticker");
        if (!docId) return;
        btn.disabled = true;
        btn.textContent = "…";

        var cell = btn.closest(".spot-cell");
        var entry = null;
        try {
          var snap = await db.collection(COL_MY_POSITIONS).doc(docId).get();
          if (snap.exists) {
            var posData = snap.data();
            entry = posData.entry_price != null ? Number(posData.entry_price) : null;
          }
        } catch (e) { /* ignore */ }

        var spot = null;
        var tsLabel = "live";
        try {
          if (ticker) {
            spot = await fetchLivePrice(ticker);
          }
        } catch (liveErr) {
          console.warn("Finnhub fetch failed, falling back to Firestore:", liveErr);
          try {
            var snap2 = await db.collection(COL_MY_POSITIONS).doc(docId).get();
            if (snap2.exists) {
              var cached = snap2.data();
              spot = cached.last_spot != null ? Number(cached.last_spot) : null;
              tsLabel = cached.last_alert_ts_utc
                ? String(cached.last_alert_ts_utc).slice(0, 16).replace("T", " ")
                : "cached";
            }
          } catch (fsErr) {
            console.error("Firestore fallback failed:", fsErr);
          }
        }

        if (cell && spot != null && Number.isFinite(spot)) {
          var cls = "spot-val";
          var arrow = "";
          if (entry != null && Number.isFinite(entry) && entry > 0) {
            if (spot > entry) { cls = "spot-val spot-up"; arrow = " &#9650;"; }
            else if (spot < entry) { cls = "spot-val spot-down"; arrow = " &#9660;"; }
          }
          var valEl = cell.querySelector(".spot-val");
          if (valEl) { valEl.className = cls; valEl.innerHTML = spot.toFixed(2) + arrow; }
          var staleEl = cell.querySelector(".spot-stale");
          if (staleEl) { staleEl.textContent = tsLabel; }
        }

        btn.disabled = false;
        btn.innerHTML = "&#x21bb;";
      });
    });

    pBody.querySelectorAll(".btn-check-now").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var ticker = btn.getAttribute("data-ticker");
        if (!ticker) return;
        btn.disabled = true;
        var origText = btn.textContent;
        btn.textContent = "…";
        try {
          await triggerMonitorWorkflow(ticker);
          btn.textContent = "Triggered";
          setTimeout(function () {
            btn.textContent = origText;
            btn.disabled = false;
          }, 3000);
        } catch (err) {
          console.error("Check workflow error:", err);
          btn.textContent = "Error";
          setTimeout(function () {
            btn.textContent = origText;
            btn.disabled = false;
          }, 3000);
        }
      });
    });
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
          let openC = 0;
          let closedC = 0;
          var openPositions = [];
          var allPositions = [];
          var pnlCards = document.getElementById("positions-pnl-cards");
          if (snap.empty) {
            pHint.hidden = false;
            pHint.textContent = "No positions yet. Add one with the form above.";
            pWrap.hidden = true;
            if (pnlCards) pnlCards.hidden = true;
            updateDashboardPositionsSummary(0, 0, true);
            renderDashboardPositionCards([]);
            positionsDataCache = [];
            stopPriceRefreshInterval();
            return;
          }
          snap.forEach((docRef) => {
            const d = docRef.data();
            allPositions.push({ id: docRef.id, data: d });
            if (d.status === "open") {
              openC += 1;
              openPositions.push({ id: docRef.id, data: d });
            } else {
              closedC += 1;
            }
          });
          positionsDataCache = allPositions;
          updateDashboardPositionsSummary(openC, closedC, false);
          renderDashboardPositionCards(openPositions);
          updatePnlCards(openPositions);
          pHint.hidden = true;
          pWrap.hidden = false;
          if (pnlCards) pnlCards.hidden = false;
          var filtered = getFilteredPositions(allPositions);
          var sorted = sortPositionsData(filtered, positionsSortKey, positionsSortDir);
          renderPositionsTable(sorted);

          if (openPositions.length > 0) {
            startPriceRefreshInterval();
            fetchPreviousDayCloses();
          } else {
            stopPriceRefreshInterval();
          }
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
    var uid = auth.currentUser ? auth.currentUser.uid : null;
    if (!uid) {
      containerEl.innerHTML = '<span class="dash-muted">Sign in to view checks.</span>';
      return;
    }
    db.collection(COL_MY_POSITIONS)
      .doc(posId)
      .collection("checks")
      .where("owner_uid", "==", uid)
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
          var pnlStr = "—";
          if (c.pnl_pct != null) {
            var pv = Number(c.pnl_pct);
            var pCls = pv > 0.0001 ? "pnl-profit" : (pv < -0.0001 ? "pnl-loss" : "pnl-flat");
            var sign = pv > 0 ? "+" : "";
            pnlStr = '<span class="' + pCls + '">' + sign + pv.toFixed(2) + "%</span>";
          }
          var daysStr = c.days_held != null ? String(c.days_held) + "d" : "—";
          var atrEstStr = c.atr_hold_est != null ? String(c.atr_hold_est) + "d" : "—";
          rows +=
            "<tr>" +
            '<td class="code">' + esc(String(c.ts_utc || "").slice(0, 19).replace("T", " ")) + "</td>" +
            '<td><span class="' + tagCls + '">' + esc(c.tag || c.alert_kind || "") + "</span></td>" +
            "<td>" + (c.confidence != null ? c.confidence : "—") + "</td>" +
            "<td>" + (c.last_spot != null ? Number(c.last_spot).toFixed(2) : "—") + "</td>" +
            "<td>" + pnlStr + "</td>" +
            "<td>" + daysStr + "</td>" +
            "<td>" + atrEstStr + "</td>" +
            "<td>" + esc(c.alert_summary || "") + "</td>" +
            "</tr>";
        });
        containerEl.innerHTML =
          '<table class="monitor-mini-table">' +
          "<thead><tr><th>timestamp</th><th>action</th><th>conf</th><th>spot</th><th>P/L %</th><th>days</th><th>ATR est</th><th>reason</th></tr></thead>" +
          "<tbody>" + rows + "</tbody></table>";
      })
      .catch(function (err) {
        containerEl.innerHTML = '<span class="dash-muted">Error loading checks: ' + esc(err.message || String(err)) + "</span>";
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
            var pnlStr = "—";
            if (c.pnl_pct != null) {
              var pv = Number(c.pnl_pct);
              var pCls = pv > 0.0001 ? "pnl-profit" : (pv < -0.0001 ? "pnl-loss" : "pnl-flat");
              var sign = pv > 0 ? "+" : "";
              pnlStr = '<span class="' + pCls + '">' + sign + pv.toFixed(2) + "%</span>";
            }
            var daysStr = c.days_held != null ? String(c.days_held) + "d" : "—";
            var atrEstStr = c.atr_hold_est != null ? String(c.atr_hold_est) + "d" : "—";
            var tr = document.createElement("tr");
            tr.innerHTML =
              '<td class="code"><strong>' + esc(c.ticker || "") + "</strong></td>" +
              '<td><span class="' + tagCls + '">' + esc(c.tag || c.alert_kind || "") + "</span></td>" +
              "<td>" + (c.confidence != null ? c.confidence : "—") + "</td>" +
              "<td>" + (c.last_spot != null ? Number(c.last_spot).toFixed(2) : "—") + "</td>" +
              "<td>" + pnlStr + "</td>" +
              "<td>" + daysStr + "</td>" +
              "<td>" + atrEstStr + "</td>" +
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

  setupPositionsTableSort();

  var hideClosedToggle = document.getElementById("hide-closed-toggle");
  if (hideClosedToggle) {
    hideClosedToggle.addEventListener("change", function () {
      hideClosedPositions = hideClosedToggle.checked;
      var filtered = getFilteredPositions(positionsDataCache);
      var sorted = sortPositionsData(filtered, positionsSortKey, positionsSortDir);
      renderPositionsTable(sorted);
    });
  }
})();
