// server.js (FINAL CLEAN v7 - Monetag & Adsterra Fixed)
require('dotenv').config();
const express = require('express');
const cors = require = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const fetch = require('node-fetch'); 

const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- FIREBASE CONFIGURATION ---
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
        console.error("FATAL: Firebase Admin SDK failed initialization. Check FIREBASE_SERVICE_ACCOUNT_BASE64.");
    }

} catch (e) {
    console.error("Firebase Config Error:", e.message);
}

const db = admin.firestore();

// --- SECURITY CONSTANTS ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; 

// --- TELEGRAM AUTH MIDDLEWARE (Integrity Check) ---
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData || !BOT_TOKEN) return res.status(403).json({ error: "Integrity Failed: Missing Token or Data" });
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataToCheck = [...urlParams.entries()].map(([key, val]) => `${key}=${val}`).sort().join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataToCheck).digest('hex');

        if (calculatedHash !== hash) return res.status(403).json({ error: "Integrity Failed: Invalid Auth Token or Data" });
        
        const userJson = urlParams.get('user');
        if (!userJson) return res.status(403).json({ error: "Integrity Failed: Missing user data" });
        req.tgUser = JSON.parse(userJson);
        
        req.startParam = urlParams.get('start_param') || null;

        next();
    } catch (e) {
        console.error("Auth Error:", e);
        return res.status(403).json({ error: "Integrity Failed: Malformed Data" });
    }
};

// --- TELEGRAM MESSAGE HELPER ---
async function sendTelegramMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown' 
            })
        });
    } catch (error) {
        console.error("Failed to send Telegram message:", error);
    }
}


// --- CORE POSTBACK HANDLER (Monetag Secure Point) ---
// This is the server-side callback endpoint for Monetag
app.get('/api/monetag-callback', async (req, res) => {
    const { 
        telegram_id, 
        reward_event_type, 
        ymid, 
        value: reward_type_alt
    } = req.query;

    const finalTgid = telegram_id;
    const finalRewardType = reward_event_type || reward_type_alt; 
    
    const uid = String(finalTgid); 
    const transactionId = String(ymid);
    
    // Check if the event is valued
    if (!uid || !transactionId || (finalRewardType !== 'yes' && finalRewardType !== 'valued')) {
        return res.status(200).send('Ignored: Not a valued event.');
    }
    
    const transactionRef = db.collection('monetag_rewards').doc(transactionId);
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(transactionRef);

            if (doc.exists) {
                return; // Duplicate transaction ignored
            }

            // Record transaction
            t.set(transactionRef, {
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                userId: uid,
                source: req.originalUrl,
                rewardType: finalRewardType 
            });

            // REWARD USER WITH 1 VALID COIN (SECURE POSTBACK POINT)
            const userRef = db.collection('users').doc(uid);
            t.update(userRef, {
                validCoins: admin.firestore.FieldValue.increment(1), 
            });

            console.log(`✅ Monetag Postback Success: Secure Coin given to user ${uid}.`);
        });

        res.status(200).send('OK'); 

    } catch (e) {
        console.error("Monetag Postback DB Error:", e);
        res.status(500).send('Server Error');
    }
});


// 1. Sync User & Handle Referrals (POWERFUL REFERRAL COUNT)
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const startParam = req.startParam; 
    const userRef = db.collection('users').doc(uid);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            
            if (!doc.exists) {
                // User is new: Create user profile
                t.set(userRef, {
                    userId: uid,
                    firstName: req.tgUser.first_name,
                    username: req.tgUser.username || '',
                    coins: 0, 
                    validCoins: 0, 
                    totalAdsWatched: 0,
                    referrals: 0,
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Check for referral and reward referrer immediately
                if (startParam && String(startParam) !== uid) {
                    const referrerId = String(startParam);
                    const referrerRef = db.collection('users').doc(referrerId);
                    const referrerDoc = await t.get(referrerRef);
                    
                    if (referrerDoc.exists) {
                        t.update(referrerRef, {
                            coins: admin.firestore.FieldValue.increment(1), 
                            referrals: admin.firestore.FieldValue.increment(1) 
                        });
                        console.log(`✅ Referral Success: User ${uid} referred by ${referrerId}. +1 Point added.`);
                    } 
                }
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Database Sync Error' });
    }
});

// 2. Front-end Claim (IMMEDIATE UNSECURE POINT ADDITION & AD COUNT)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    const today = new Date().toISOString().slice(0, 10);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";
            
            // Increment Unsecure Coin and Ad Counts
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(1), 
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastAdTime: admin.firestore.FieldValue.serverTimestamp(),
                lastAdDate: today,
                adsToday: admin.firestore.FieldValue.increment(1) 
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
    const username = req.tgUser.username || 'N/A';
    const firstName = req.tgUser.first_name || 'User';

    const { method, number, amountPoints } = req.body;
    const userRef = db.collection('users').doc(uid);

    const MIN_POINTS = 600; 
    const MIN_REFERRALS = 10; 
    
    try {
        let isWithdrawSuccessful = false;
        
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";
            
            const data = doc.data();
            const balance = data.coins || 0; 
            const refCount = data.referrals || 0;

            if (balance < MIN_POINTS) throw `Minimum ${MIN_POINTS} Points required`;
            if (refCount < MIN_REFERRALS) throw `Minimum ${MIN_REFERRALS} Referrals required`;
            if (amountPoints > balance) throw "Insufficient Balance";
            if (amountPoints <= 0) throw "Invalid Amount";

            // Deduct Points from UNSECURE COINS
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(-amountPoints)
            });

            // Create Withdrawal Record
            const withdrawRef = db.collection('withdrawals').doc();
            t.set(withdrawRef, {
                userId: uid,
                username: username,
                firstName: firstName,
                amountPoints: parseInt(amountPoints),
                method: method,
                number: number,
                status: 'pending',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            
            isWithdrawSuccessful = true;
        });

        // SEND TELEGRAM NOTIFICATION
        if (isWithdrawSuccessful && ADMIN_CHAT_ID && BOT_TOKEN) {
            const message = 
`🔔 **NEW WITHDRAWAL REQUEST** 🔔
----------------------------------
👤 **Name:** ${firstName}
🆔 **ID/Username:** \`${uid}\` (@${username})
💰 **Amount:** ${amountPoints} Points
💳 **Method:** ${method}
📞 **Number:** \`${number}\`
----------------------------------
_Please check the Admin Panel to approve._`;

            await sendTelegramMessage(ADMIN_CHAT_ID, message);
        }

        res.json({ success: true });
    } catch (e) {
        const isLogicError = typeof e === 'string';
        res.status(isLogicError ? 400 : 500).json({ error: isLogicError ? e : 'Withdrawal Processing Error' });
    }
});

// --- ADMIN ROUTES (Minimal version) ---
app.get('/admin', (req, res) => res.send('Admin Panel Not Configured.'));
app.post('/admin/login', (req, res) => res.status(404).send('Not Found'));
app.get('/admin/withdrawals', (req, res) => res.status(404).send('Not Found'));
app.post('/admin/action', (req, res) => res.status(404).send('Not Found'));


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
