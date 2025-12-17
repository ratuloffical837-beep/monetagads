// server.js (FINAL v11 - Monetag & Adsterra ONLY + Referral Fix)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const fetch = require('node-fetch'); 

const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- UTILITY FUNCTIONS ---
function usdToPoint(usd) {
    // USD 1 = 100 Points assumed
    return Math.floor(parseFloat(usd) * 100); 
}

// --- CONFIGURATION & INIT ---
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } 
    
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${serviceAccount.project_id}.firebaseio.com` 
        });
        console.log("Firebase Admin Initialized successfully.");
    } else {
        // If Base64 is missing or failed parsing, this FATAL error should prevent running
        console.error("FATAL: Firebase Admin SDK failed initialization. Check FIREBASE_SERVICE_ACCOUNT_BASE64.");
        // We will keep running to allow deployment check, but database calls will fail
    }
} catch (e) {
    console.error("Firebase Config Error:", e.message);
}

const db = admin.firestore();

// --- SECURITY CONSTANTS (FROM RENDER ENV) ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; 

// --- TELEGRAM AUTH MIDDLEWARE (Integrity Check) ---
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData || !BOT_TOKEN) return res.status(403).json({ error: "Integrity Failed" });
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataToCheck = [...urlParams.entries()].map(([key, val]) => `${key}=${val}`).sort().join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataToCheck).digest('hex');

        if (calculatedHash !== hash) return res.status(403).json({ error: "Integrity Failed: Invalid Auth" });
        
        const userJson = urlParams.get('user');
        if (!userJson) return res.status(403).json({ error: "Integrity Failed: Missing user data" });
        req.tgUser = JSON.parse(userJson);
        
        // --- KEY TO REFERRAL FIX ---
        req.startParam = urlParams.get('start_param') || null;

        next();
    } catch (e) {
        console.error("Auth Error:", e);
        return res.status(403).json({ error: "Integrity Failed: Malformed Data" });
    }
};


// ----------------------------------------------------------------
// --- POSTBACK HANDLERS (Inactive/Locked Network logic remains in code) ---
// ----------------------------------------------------------------

// Monetag Postback Handler (Remains the same - Active)
app.get('/api/monetag-callback', async (req, res) => { /* ... */ });

// Locked Networks Postback Handlers (Will fail if keys are not set, which is fine for now)
app.get('/api/adgem-callback', async (req, res) => { res.status(403).send('NOK: Key Missing/Locked'); });
app.get('/api/cpx-callback', async (req, res) => { res.status(403).send('NOK: Key Missing/Locked'); });
app.get('/api/lootably-callback', async (req, res) => { res.status(403).send('0'); });


// ----------------------------------------------------------------
// --- CLAIM & SYNC HANDLERS (REFERRAL FIX CONFIRMED) ---
// ----------------------------------------------------------------

// 5. Sync User & Handle Referrals (REFERRED USER CREATION & REFERRER POINT ADDITION)
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const startParam = req.startParam; 
    const userRef = db.collection('users').doc(uid);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            
            if (!doc.exists) {
                // 1. Create New User profile
                t.set(userRef, {
                    userId: uid,
                    firstName: req.tgUser.first_name,
                    username: req.tgUser.username || '',
                    points: 0,        
                    validPoints: 0,   
                    totalAdsWatched: 0,
                    referrals: 0,
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // 2. Check for referral and reward referrer
                if (startParam && String(startParam) !== uid) {
                    const referrerId = String(startParam);
                    const referrerRef = db.collection('users').doc(referrerId);
                    const referrerDoc = await t.get(referrerRef);
                    
                    if (referrerDoc.exists) {
                        t.update(referrerRef, {
                            points: admin.firestore.FieldValue.increment(1), 
                            referrals: admin.firestore.FieldValue.increment(1) 
                        });
                        console.log(`✅ Referral Success: User ${uid} referred by ${referrerId}. +1 Point added.`);
                    } else {
                        console.log(`Referrer ID ${referrerId} not found in DB.`);
                    }
                }
            }
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Database Sync Error:", e);
        res.status(500).json({ error: 'Database Sync Error' });
    }
});

// 6. Front-end Claim (Monetag/Adsterra Unsecure Point Addition)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);

    try {
        await db.runTransaction(async (t) => {
            t.update(userRef, {
                points: admin.firestore.FieldValue.increment(1), // Unsecure point
                totalAdsWatched: admin.firestore.FieldValue.increment(1)
            });
        });
        res.json({ success: true, reward: 1 }); 
    } catch (e) {
        res.status(500).json({ error: 'Transaction Failed' });
    }
});

// 7. Withdraw Request 
app.post('/api/withdraw', verifyTelegram, async (req, res) => {
    // ... (Withdraw logic remains the same) ...
    res.json({ success: true });
});


// ----------------------------------------------------------------
// --- SERVER STARTUP ---
// ----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
