const admin = require("firebase-admin");

async function verifyToken(idToken) {
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded; // { uid, email, name, picture, ... }
  } catch (e) {
    console.error("Token verification failed:", e.message);
    return null;
  }
}

module.exports = { verifyToken };
