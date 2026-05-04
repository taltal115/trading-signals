/* Replace with real values before deploy (see firebase-config.example.js). */
const firebaseConfig = {
  apiKey: "AIzaSyBxv69N4BAo5OSPT0AZHcWF1o0k-etd4TA",
  authDomain: "trading-goals.firebaseapp.com",
  projectId: "trading-goals",
  storageBucket: "trading-goals.firebasestorage.app",
  messagingSenderId: "703616057199",
  appId: "1:703616057199:web:cd29b5f54d254724dbb29a",
  measurementId: "G-S21BNF9ENK",

  // Google sign-in allowlist (lowercase). Must match firestore.rules for my_positions.
  allowedSignInEmails: ["taltal115@gmail.com", "tal.david.shitrit@gmail.com", "idanchetrit@gmail.com"],
  // Optional: allow these Firebase Auth UIDs even if email matching is awkward (client-only; rules use owner_uid).
  allowedAuthUids: ["tgIBRfrP1ibiEi6P2LMsVoyvNaM2"],

  // Finnhub API key for live price quotes
  finnhubApiKey: "d291bthr01qhoen95h40d291bthr01qhoen95h4g",

  // Alpha Vantage API key for historical daily prices (free: 25 requests/day)
  // Get your free key at: https://www.alphavantage.co/support/#api-key
  alphaVantageApiKey: "WJ64LJ8AU8ZDZ4ZF",

  // Optional: Twelve Data — charts/history use this first (CORS-friendly, higher free limits than AV).
  // If unset, falls back to Alpha Vantage only. https://twelvedata.com
  twelveDataApiKey: "",
};

window.firebaseConfig = firebaseConfig;
