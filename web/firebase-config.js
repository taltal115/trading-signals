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
  allowedSignInEmails: ["taltal115@gmail.com"],
  // Optional: allow these Firebase Auth UIDs even if email matching is awkward (client-only; rules use owner_uid).
  allowedAuthUids: ["tgIBRfrP1ibiEi6P2LMsVoyvNaM2"],
};

window.firebaseConfig = firebaseConfig;
