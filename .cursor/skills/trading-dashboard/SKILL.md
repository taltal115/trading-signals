---
name: trading-dashboard
description: Build and modify the trading signals dashboard UI
---

# Trading Dashboard Development

## Use When
- Adding new UI components to the dashboard
- Modifying existing tables or cards
- Adding new API integrations (Finnhub, GitHub Actions)
- Creating new button actions or data displays

## Key Files
- web/index.html - Main HTML structure
- web/app.js - All JavaScript logic (vanilla JS, IIFE pattern)
- web/styles.css - CSS styling with CSS variables
- web/firebase-config.js - Firebase config and API keys

## Patterns

### Adding a new button with API call
1. Add button HTML in the appropriate table/section
2. Add click handler in app.js that calls an async function
3. Show loading state (disable button, change text to "…")
4. Handle success/error, restore button after timeout

Example:
```javascript
btn.addEventListener("click", async function () {
  btn.disabled = true;
  var origText = btn.textContent;
  btn.textContent = "…";
  try {
    await someAsyncOperation();
    btn.textContent = "Done";
    setTimeout(function () {
      btn.textContent = origText;
      btn.disabled = false;
    }, 3000);
  } catch (err) {
    console.error(err);
    btn.textContent = "Error";
    setTimeout(function () {
      btn.textContent = origText;
      btn.disabled = false;
    }, 3000);
  }
});
```

### Fetching live prices
Use `fetchLivePrice(ticker)` which calls Finnhub API:
```javascript
var price = await fetchLivePrice("AAPL");
```

### Triggering GitHub Actions
Use existing functions with PAT stored in localStorage:
- `triggerMonitorWorkflow(ticker)` - position monitor
- `triggerBotScanWorkflow(ticker)` - trading bot scan

### Firestore real-time updates
Use onSnapshot for live data:
```javascript
db.collection("signals").orderBy("ts_utc", "desc").limit(25)
  .onSnapshot((snap) => { /* handle data */ });
```

## Styling
- Use CSS variables from :root (--bg, --surface, --accent, --buy, --sell, --wait, etc.)
- Follow existing button patterns:
  - `.btn-log-buy` - green buy action
  - `.btn-reeval` - accent color for re-evaluate
  - `.btn-check-now` - muted for monitor check
  - `.btn-exit` - warn color for exit

## Data Structures

### Signal object (from Firestore)
```javascript
{
  ticker: "AAPL",
  close: 150.25,      // signal price
  stop: 145.00,
  target: 165.00,
  metrics: {
    sector: "Technology",
    industry: "Consumer Electronics",
    estimated_hold_days: 5
  }
}
```

### Position object (from Firestore)
```javascript
{
  ticker: "AAPL",
  entry_price: 150.25,
  stop_price: 145.00,
  target_price: 165.00,
  status: "open",
  last_spot: 155.00,
  last_alert_kind: "POSITION_WAIT"
}
```
