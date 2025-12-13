// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
// 1. Firebase Initialization
// On Render, we pass the Service Account JSON as a Base64 string in env vars
// to avoid uploading sensitive files to GitHub.
let serviceAccount;
try {
    const base64ServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (base64ServiceAccount) {
        const jsonString = Buffer.from(base64ServiceAccount, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } else {
        // Local development fallback (if file exists)
        serviceAccount = require('./serviceAccountKey.json');
    }
} catch (e) {
    console.error("Firebase Config Error: Ensure FIREBASE_SERVICE_ACCOUNT_BASE64 is set.");
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// --- MIDDLEWARE: TELEGRAM AUTHENTICATION ---
// Verifies that the request actually came from Telegram
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!initData || !botToken) {
        return res.status(403).json({ error: 'Missing Authentication Data' });
    }

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        // Sort keys alphabetically
        const dataToCheck = [...urlParams.entries()]
            .map(([key, val]) => `${key}=${val}`)
            .sort()
            .join('\n');

        // HMAC-SHA256 Signature Validation
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataToCheck).digest('hex');

        if (calculatedHash !== hash) {
            return res.status(403).json({ error: 'Data integrity check failed' });
        }

        // Attach user data to request
        req.telegramUser = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        return res.status(403).json({ error: 'Invalid Auth Data' });
    }
};

// --- ROUTES ---

// 1. Sync User (Create if not exists)
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.telegramUser.id);
    const userRef = db.collection('users').doc(uid);

    try {
        const doc = await userRef.get();
        if (!doc.exists) {
            await userRef.set({
                username: req.telegramUser.username || 'User',
                firstName: req.telegramUser.first_name || '',
                coins: 0,
                totalAdsWatched: 0,
                joinedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastAdTimestamp: 0 // For anti-spam
            });
        }
        res.json({ success: true, message: "Synced" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Database error" });
    }
});

// 2. Claim Reward (Secure Ad Verification)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.telegramUser.id);
    const userRef = db.collection('users').doc(uid);
    const REWARD_AMOUNT = 2; // Coins per ad
    const MIN_AD_INTERVAL = 15000; // 15 Seconds minimum between claims (Anti-spam)

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";

            const data = doc.data();
            const now = Date.now();
            const lastAd = data.lastAdTimestamp || 0;

            // Simple fraud check: If user claims too fast
            if (now - lastAd < MIN_AD_INTERVAL) {
                throw "Claiming too fast. Please wait.";
            }

            const newCoins = (data.coins || 0) + REWARD_AMOUNT;
            const newAds = (data.totalAdsWatched || 0) + 1;

            t.update(userRef, {
                coins: newCoins,
                totalAdsWatched: newAds,
                lastAdTimestamp: now
            });
        });

        res.json({ success: true, reward: REWARD_AMOUNT });
    } catch (e) {
        console.error("Claim Error:", e);
        res.status(400).json({ error: typeof e === 'string' ? e : "Transaction failed" });
    }
});

// 3. Withdraw Request
app.post('/api/withdraw', verifyTelegram, async (req, res) => {
    const uid = String(req.telegramUser.id);
    const { amount, method, phone } = req.body;
    const userRef = db.collection('users').doc(uid);
    const MIN_WITHDRAW = 1000; // 1000 Coins = $1.00

    try {
        const doc = await userRef.get();
        const currentCoins = doc.data()?.coins || 0;

        if (currentCoins < MIN_WITHDRAW) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // We DO NOT deduct coins here. Admin deducts manually after verification.
        await db.collection('withdrawalRequests').add({
            userId: uid,
            username: req.telegramUser.username,
            requestedAmountUSD: (currentCoins * 0.001).toFixed(3),
            currentCoinsSnapshot: currentCoins,
            method: method,
            phone: phone,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: "Request received" });
    } catch (e) {
        res.status(500).json({ error: "Failed to submit request" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
