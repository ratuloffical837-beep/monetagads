const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Firebase Admin (ENV থেকে)
const serviceAccount = JSON.parse(
  Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    "base64"
  ).toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ✅ Reward API
app.post("/reward", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.json({ error: "NO_USER" });

  const ref = db.collection("users").doc(String(userId));
  const snap = await ref.get();
  const now = Date.now();

  if (snap.exists) {
    const data = snap.data();

    // ⛔ 30 সেকেন্ড স্প্যাম ব্লক
    if (data.lastAd && now - data.lastAd < 30000) {
      return res.json({ status: "WAIT" });
    }

    await ref.update({
      coins: admin.firestore.FieldValue.increment(1),
      ads: admin.firestore.FieldValue.increment(1),
      lastAd: now,
    });
  } else {
    await ref.set({
      coins: 1,
      ads: 1,
      lastAd: now,
    });
  }

  res.json({ status: "OK" });
});

app.get("/", (req, res) => {
  res.send("Backend Running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));
