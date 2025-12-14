// final server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
} catch (e) {
    console.error("Firebase Config Error: Missing Service Account");
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

// --- MIDDLEWARE: TELEGRAM SECURITY ---
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!initData || !botToken) return res.status(403).json({ error: 'Auth Missing' });

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');

        const dataToCheck = [...urlParams.entries()]
            .map(([key, val]) => `\( {key}= \){val}`)
            .sort()
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataToCheck).digest('hex');

        if (calculatedHash !== hash) return res.status(403).json({ error: 'Integrity Failed' });

        req.tgUser = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        return res.status(403).json({ error: 'Auth Error' });
    }
};

// --- ENDPOINTS ---

// 1. Sync User & Referrals
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { startParam } = req.body;
    const userRef = db.collection('users').doc(uid);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) {
                t.set(userRef, {
                    userId: uid,
                    firstName: req.tgUser.first_name,
                    username: req.tgUser.username || '',
                    coins: 0,
                    totalAdsWatched: 0,
                    referrals: 0,
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

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
        res.status(500).json({ error: 'DB Error' });
    }
});

// 2. Claim Reward
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
        res.status(500).json({ error: 'Transaction Failed' });
    }
});

// 3. Withdraw Request
app.post('/api/withdraw', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { method, number, amountPoints } = req.body;

    try {
        const userRef = db.collection('users').doc(uid);
        const doc = await userRef.get();
        const data = doc.data();
        const balance = data?.coins || 0;
        const refCount = data?.referrals || 0;

        if (balance < 1000) return res.status(400).json({ error: "Min 1000 Points required" });
        if (refCount < 20) return res.status(400).json({ error: "Min 20 Referrals required" });
        if (amountPoints > balance) return res.status(400).json({ error: "Insufficient Balance" });
        if (amountPoints < 1000) return res.status(400).json({ error: "Min withdrawal is 1000 points" });

        await db.collection('withdrawals').add({
            userId: uid,
            username: req.tgUser.username,
            amountPoints: amountPoints, 
            method: method,
            number: number,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Withdraw Error' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
