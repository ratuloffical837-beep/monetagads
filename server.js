// server.js (FINAL v7 - Monetag + AdGem Secure Postbacks)
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
// Serve index.html from the root path
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));


// --- CONFIGURATION & INIT ---
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        // NOTE: This will only work if you set FIREBASE_SERVICE_ACCOUNT_BASE64 in Render Env
        const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } 
    
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${serviceAccount.project_id}.firebaseio.com` 
        });
        console.log("Firebase Admin Initialized.");
    } else {
        console.error("FATAL: Firebase Admin SDK could not initialize. Check FIREBASE_SERVICE_ACCOUNT_BASE64.");
        // If Firebase fails to init, transactions will fail.
    }

} catch (e) {
    console.error("Firebase Config Error:", e.message);
}

const db = admin.firestore();

// --- SECURITY CONSTANTS (FROM RENDER ENV) ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8144732556'; // Default to your ID
const ADGEM_POSTBACK_KEY = process.env.ADGEM_POSTBACK_KEY || 'ln52395j792ff3a7a44le0i5'; // Your AdGem Secret Key

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

// --- NEW FUNCTION TO SEND TELEGRAM MESSAGE ---
async function sendTelegramMessage(chatId, text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'Markdown' 
            })
        });
        const data = await response.json();
        if (!data.ok) {
            console.error("Telegram API Error:", data.description);
        }
    } catch (error) {
        console.error("Failed to send Telegram message:", error);
    }
}


// --- CORE HANDLERS ---

// 1. Monetag Postback Handler (Secure Point Counting)
app.get('/api/monetag-callback', async (req, res) => {
    // telegram_id is the user ID passed via ymid macro
    const { telegram_id, ymid, reward_event_type, value: reward_type_alt } = req.query;

    const finalRewardType = reward_event_type || reward_type_alt; 
    
    // Only reward if Monetag confirms it was a paid event ('yes' or 'valued')
    if (!telegram_id || !ymid || (finalRewardType !== 'yes' && finalRewardType !== 'valued')) {
        return res.status(200).send('Ignored: Not a valued Monetag event.');
    }
    
    const uid = String(telegram_id); 
    const transactionId = String(ymid); // ymid acts as a unique transaction ID
    const transactionRef = db.collection('monetag_rewards').doc(transactionId);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(transactionRef);

            if (doc.exists) {
                console.log(`Duplicate Monetag transaction ignored: ${transactionId}`);
                return; 
            }

            // Record transaction
            t.set(transactionRef, {
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                userId: uid,
                source: 'monetag',
                rewardType: finalRewardType 
            });

            // *** REWARD USER WITH 1 VALID COIN (SECURE POSTBACK POINT) ***
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


// 2. AdGem Postback Handler (Secure Offerwall Point Counting)
app.get('/api/adgem-callback', async (req, res) => {
    const { player_id, amount, transaction_id, verifier } = req.query;
    
    // Basic Validation
    if (!player_id || !amount || !transaction_id || !verifier) {
        console.log('AdGem: Missing required parameters.');
        return res.status(200).send('Error: Missing parameters.');
    }

    const uid = String(player_id); // Telegram User ID
    const points = parseInt(amount);
    
    // 1. Verify Hash (Security Check)
    const dataToHash = `${transaction_id}:${amount}:${player_id}:${ADGEM_POSTBACK_KEY}`;
    const calculatedHash = crypto.createHash('md5').update(dataToHash).digest('hex');

    if (calculatedHash !== verifier) {
        console.error(`AdGem: Hash mismatch for TxID ${transaction_id}. Calculated: ${calculatedHash}, Received: ${verifier}`);
        return res.status(200).send('Error: Invalid Verifier.');
    }
    
    // 2. Prevent Duplicate Transactions
    const transactionRef = db.collection('adgem_rewards').doc(transaction_id);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(transactionRef);

            if (doc.exists) {
                console.log(`Duplicate AdGem transaction ignored: ${transaction_id}`);
                return; 
            }
            
            // Record transaction
            t.set(transactionRef, {
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                userId: uid,
                amount: points,
                source: 'adgem'
            });

            // *** REWARD USER WITH VALID COINS (SECURE POSTBACK POINTS) ***
            const userRef = db.collection('users').doc(uid);
            t.update(userRef, {
                validCoins: admin.firestore.FieldValue.increment(points), 
            });

            console.log(`✅ AdGem Postback Success: ${points} Secure Coins given to user ${uid}.`);
        });

        res.status(200).send('OK'); 

    } catch (e) {
        console.error("AdGem Postback DB Error:", e);
        res.status(500).send('Server Error');
    }
});


// 3. Sync User & Handle Referrals 
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
                    coins: 0, // Unsecure Withdrawal Points
                    validCoins: 0, // Secure Postback Points (Monetag/AdGem)
                    totalAdsWatched: 0,
                    referrals: 0,
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Check for referral
                if (startParam && String(startParam) !== uid) {
                    const referrerId = String(startParam);
                    const referrerRef = db.collection('users').doc(referrerId);
                    const referrerDoc = await t.get(referrerRef);
                    
                    if (referrerDoc.exists) {
                        t.update(referrerRef, {
                            coins: admin.firestore.FieldValue.increment(1), // Referrer gets +1 Withdrawal Point
                            referrals: admin.firestore.FieldValue.increment(1) // Referrer gets +1 Count
                        });
                    }
                }
            }
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Database Sync Error' });
    }
});

// 4. Front-end Claim (Monetag Unsecure Point Addition & Ad Count)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    const today = new Date().toISOString().slice(0, 10);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";
            
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(1), // Unsecure point
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

// 5. Withdraw Request (Sends Notification to Telegram Admin)
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

        // --- SEND TELEGRAM NOTIFICATION (OUTSIDE TRANSACTION) ---
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
_You can check the Admin Panel to approve._`;

            await sendTelegramMessage(ADMIN_CHAT_ID, message);
        }

        res.json({ success: true });
    } catch (e) {
        const isLogicError = typeof e === 'string';
        res.status(isLogicError ? 400 : 500).json({ error: isLogicError ? e : 'Withdrawal Processing Error' });
    }
});


// --- ADMIN ROUTES (Placeholder) ---
// Note: You must implement Admin routes if you want to use the admin panel.

app.get('/admin', (req, res) => {
    res.send("Admin Panel is not yet implemented.");
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
