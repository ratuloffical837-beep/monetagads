// updated server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
// Ensure CORS is set up correctly for your frontend URL or allow all
app.use(cors({
    origin: '*', 
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: ['Content-Type', 'x-telegram-init-data']
}));
app.use(express.json());

// --- CONFIGURATION ---
let serviceAccount;
try {
    // Attempt to load from Base64 env variable (Recommended for Render)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        // Base64 string is CONFIGURED and used here
        const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } else {
        // Fallback to local file for development (unlikely on production)
        serviceAccount = require('./serviceAccountKey.json');
    }
} catch (e) {
    console.error("Firebase Config Error: Missing Service Account. Check FIREBASE_SERVICE_ACCOUNT_BASE64 env variable.");
    serviceAccount = null; // Prevent initialization if config fails
}

if (serviceAccount) {
    admin.initializeApp({
        // Note: projectId is "moneteg-ads-afb9f" from service account
        credential: admin.credential.cert(serviceAccount)
    });
} else {
    console.error("Firebase Admin SDK was NOT initialized. Server functions will fail.");
}
const db = admin.firestore();

// --- MIDDLEWARE: TELEGRAM SECURITY ---
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    // Bot Token is CONFIGURED via environment variable
    const botToken = process.env.TELEGRAM_BOT_TOKEN; 

    if (!initData) return res.status(403).json({ error: 'Auth Missing: initData' });
    if (!botToken) return res.status(500).json({ error: 'Server Config Error: Bot Token Missing' });

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        const dataToCheck = [...urlParams.entries()]
            .map(([key, val]) => `${key}=${val}`)
            .sort()
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataToCheck).digest('hex');

        if (calculatedHash !== hash) {
             console.log(`Integrity Failed for user: ${urlParams.get('user')}`);
             return res.status(403).json({ error: 'Integrity Failed' });
        }

        // Successfully verified user data attached to request
        req.tgUser = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        console.error("Telegram Auth Error:", e);
        return res.status(403).json({ error: 'Auth Error' });
    }
};

// --- ENDPOINTS ---

// 1. Sync User & Referrals (New user creation and referral awarding)
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { startParam } = req.body; // Potential Referrer ID
    const userRef = db.collection('users').doc(uid);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) {
                // --- NEW USER CREATION ---
                t.set(userRef, {
                    userId: uid,
                    firstName: req.tgUser.first_name,
                    username: req.tgUser.username || '',
                    coins: 0,
                    totalAdsWatched: 0,
                    referrals: 0, // New field initialized
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // --- REFERRAL LOGIC: Award +2 Points to referrer ---
                if (startParam && startParam !== uid) {
                    const referrerRef = db.collection('users').doc(String(startParam));
                    const referrerDoc = await t.get(referrerRef);
                    
                    // Check if referrer exists and if this user was already referred by someone else (optional check, handled by doc.exists)
                    if (referrerDoc.exists) {
                        // Award Referrer +2 Coins, +1 Referral Count
                        t.update(referrerRef, {
                            coins: admin.firestore.FieldValue.increment(2), // +2 Points for referral
                            referrals: admin.firestore.FieldValue.increment(1) 
                        });
                        console.log(`Referral: User ${uid} referred by ${startParam}. Awarded +2.`);
                    }
                }
            } else {
                // Existing user, just update last active time
                t.update(userRef, {
                    lastActive: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Sync Transaction Failed:", e);
        res.status(500).json({ error: 'DB Error' });
    }
});

// 2. Claim Reward (Watch Ad)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error("User not found or needs to be synced.");
            
            // Award +1 Point per Ad Watch
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(1), // +1 Point for ad watch
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.json({ success: true, reward: 1 });
    } catch (e) {
        console.error("Claim Reward Transaction Failed:", e);
        res.status(500).json({ error: 'Transaction Failed' });
    }
});

// 3. Withdraw Request
app.post('/api/withdraw', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { method, number, amountPoints } = req.body;

    // Basic Input Validation
    if (!method || !number || !amountPoints || typeof amountPoints !== 'number' || amountPoints < 1000) {
        return res.status(400).json({ error: "Invalid withdrawal amount or details." });
    }
    if (number.length !== 11) {
        return res.status(400).json({ error: "Wallet Number must be 11 digits." });
    }

    try {
        // Use Transaction to check balance and then subtract if successful
        await db.runTransaction(async (t) => {
            const userRef = db.collection('users').doc(uid);
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error("User data missing.");
            
            const data = doc.data();
            const balance = data?.coins || 0;
            const refCount = data?.referrals || 0;

            // --- Withdrawal Conditions ---
            if (balance < 1000) throw new Error("Min 1000 Points required");
            if (refCount < 20) throw new Error("Min 20 Referrals required");
            if (amountPoints > balance) throw new Error("Insufficient Balance");
            if (amountPoints < 1000) throw new Error("Min withdrawal is 1000 points");
            
            // 1. Subtract points from user's balance
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(-amountPoints)
            });

            // 2. Save Withdrawal Request
            db.collection('withdrawals').add({
                userId: uid,
                username: req.tgUser.username || req.tgUser.first_name,
                amountPoints: amountPoints, 
                method: method,
                number: number,
                status: 'pending',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({ success: true });
    } catch (e) {
        // Handle specific validation errors caught by the transaction
        if (e.message && e.message.includes("Points required")) {
             return res.status(400).json({ error: "You need 1000+ Points to withdraw!" });
        }
        if (e.message && e.message.includes("Referrals required")) {
             return res.status(400).json({ error: "You need to refer at least 20 people to withdraw!" });
        }
        if (e.message && e.message.includes("Insufficient Balance")) {
             return res.status(400).json({ error: "Insufficient Balance" });
        }
        
        console.error("Withdraw Error:", e);
        res.status(500).json({ error: 'Withdrawal processing failed.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
