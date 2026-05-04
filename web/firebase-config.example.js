/* Copy to firebase-config.js and paste your web app config from:
   Firebase Console → Project settings → Your apps → SDK setup (CDN)
   The API key is public; access is enforced by Firestore rules. */
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxx",

  allowedSignInEmails: ["taltal115@gmail.com", "tal.david.shitrit@gmail.com", "idanchetrit@gmail.com"],
  // Optional client allowlist by uid (Firestore rules only require owner_uid == auth.uid).
  allowedAuthUids: [],

  // Optional — market data (copy from your real firebase-config.js when needed)
  // finnhubApiKey: "",
  // alphaVantageApiKey: "",
  // twelveDataApiKey: "", // recommended for dashboard charts if Alpha Vantage hits 25 req/day
};

window.firebaseConfig = firebaseConfig;
