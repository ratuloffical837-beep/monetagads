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
// Initialize Firebase Admin SDK via Environment Variable (Base64)
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        // IMPORTANT: Reads from the Render Environment Variable
        const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } else {
        // Fallback for local testing (not for Render)
        console.warn("Using local service account key path. Ensure FIREBASE_SERVICE_ACCOUNT_BASE64 is set in production.");
    }
    
    // Check if serviceAccount was successfully loaded before initializing
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        console.error("FATAL: Firebase Admin SDK could not initialize due to missing service account data.");
    }

} catch (e) {
    console.error("Firebase Config Error:", e.message);
}

const db = admin.firestore();

// --- CRITICAL SECURITY MIDDLEWARE (DO NOT REMOVE) ---
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    const botToken = process.env.TELEGRAM_BOT_TOKEN; // CRITICAL: Reads from Env Variable

    if (!initData || !botToken) {
        return res.status(403).json({ error: "Integrity Failed: Missing Token or Data" });
    }

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        // Sort keys alphabetically to match Telegram's signing algorithm
        const dataToCheck = [...urlParams.entries()]
            .map(([key, val]) => `${key}=${val}`)
            .sort()
            .join('\n');

        // Calculate HMAC-SHA256
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataToCheck).digest('hex');

        if (calculatedHash !== hash) {
            console.error("Hash Mismatch. Calculated:", calculatedHash, "Received:", hash);
            return res.status(403).json({ error: "Integrity Failed: Invalid Auth Token or Data" });
        }

        // Attach user data to request
        req.tgUser = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        console.error("Auth Error:", e);
        return res.status(403).json({ error: "Integrity Failed: Malformed Data" });
    }
};

// --- ROUTES ---

// 1. Sync User & Handle Referrals
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { startParam } = req.body;
    const userRef = db.collection('users').doc(uid);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            
            if (!doc.exists) {
                // Create New User
                t.set(userRef, {
                    userId: uid,
                    firstName: req.tgUser.first_name,
                    username: req.tgUser.username || '',
                    coins: 0,
                    totalAdsWatched: 0,
                    referrals: 0,
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Handle Referral (Give 2 points to referrer)
                if (startParam && startParam !== uid) {
                    const referrerRef = db.collection('users').doc(String(startParam));
                    const referrerDoc = await t.get(referrerRef);
                    if (referrerDoc.exists) {
                        t.update(referrerRef, {
                            coins: admin.firestore.FieldValue.increment(2),
                            referrals: admin.firestore.FieldValue.increment(1)
                        });
                    }
                }
            }
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Sync Error:", e);
        res.status(500).json({ error: 'Database Sync Error' });
    }
});

// 2. Claim Reward (Ad Watched)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";
            
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(1),
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.json({ success: true, reward: 1 });
    } catch (e) {
        console.error("Claim Error:", e);
        res.status(500).json({ error: 'Transaction Failed' });
    }
});

// 3. Withdraw Request
app.post('/api/withdraw', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { method, number, amountPoints } = req.body;
    const userRef = db.collection('users').doc(uid);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";
            
            const data = doc.data();
            const balance = data.coins || 0;
            const refCount = data.referrals || 0;

            // Strict Validation
            if (balance < 1000) throw "Minimum 1000 Points required";
            if (refCount < 20) throw "Minimum 20 Referrals required";
            if (amountPoints > balance) throw "Insufficient Balance";
            if (amountPoints <= 0) throw "Invalid Amount";

            // Deduct Points
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(-amountPoints)
            });

            // Create Withdrawal Record
            const withdrawRef = db.collection('withdrawals').doc();
            t.set(withdrawRef, {
                userId: uid,
                username: req.tgUser.username || 'Unknown',
                amountPoints: parseInt(amountPoints),
                method: method,
                number: number,
                status: 'pending',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({ success: true });
    } catch (e) {
        // Return specific logic error or generic 500
        const isLogicError = typeof e === 'string';
        res.status(isLogicError ? 400 : 500).json({ error: isLogicError ? e : 'Withdrawal Processing Error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
