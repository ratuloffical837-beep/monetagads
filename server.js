require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');

const app = express();
app.use(cors({
    origin: '*', 
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: ['Content-Type', 'x-telegram-init-data', 'x-admin-key']
}));
app.use(express.json());

// --- CONFIGURATION: FIREBASE ADMIN ---
let serviceAccount;
try {
    // FIREBASE_SERVICE_ACCOUNT_BASE64: Render Env Variable থেকে লোড হবে
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } 
} catch (e) {
    console.error("Firebase Config Error: Missing or invalid FIREBASE_SERVICE_ACCOUNT_BASE64 env variable. Check Render Env.");
    serviceAccount = null; 
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} else {
    console.error("Firebase Admin SDK was NOT initialized. Database access will fail.");
}
const db = admin.firestore();

// --- SECRETS & CONSTANTS ---
// Render Env Variable থেকে টোকেন এবং অ্যাডমিন পাসওয়ার্ড লোড হবে
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const ADMIN_KEY = process.env.ADMIN_SECRET_KEY || 'default-admin-key-MUST-CHANGE'; 

// --- MIDDLEWARE: TELEGRAM SECURITY ---
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    const botToken = BOT_TOKEN; 

    if (!initData) return res.status(403).json({ error: 'Auth Missing: initData' });
    if (!botToken || botToken === 'YOUR_BOT_TOKEN_HERE') return res.status(500).json({ error: 'Server Config Error: TELEGRAM_BOT_TOKEN Missing in Render Env.' });

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
             // THIS IS THE INTEGRITY FAILED ERROR SOURCE
             console.log(`Integrity Failed for user: ${urlParams.get('user')}`);
             return res.status(403).json({ error: 'Integrity Failed: Invalid Auth/Token' });
        }

        req.tgUser = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        console.error("Telegram Auth Error:", e);
        return res.status(403).json({ error: 'Auth Error' });
    }
};

// --- MIDDLEWARE: ADMIN KEY SECURITY ---
const verifyAdmin = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    if (adminKey === ADMIN_KEY && ADMIN_KEY !== 'default-admin-key-MUST-CHANGE') {
        next();
    } else {
        res.status(403).json({ error: 'Admin Access Denied. Check x-admin-key header.' });
    }
};

// --- ENDPOINTS (LOGIC) ---

// 1. Sync User & Referrals
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { startParam } = req.body; 
    const userRef = db.collection('users').doc(uid);
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) {
                // New User Creation
                t.set(userRef, {
                    userId: uid,
                    firstName: req.tgUser.first_name,
                    username: req.tgUser.username || '',
                    coins: 0,
                    totalAdsWatched: 0,
                    referrals: 0, 
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Referral Logic
                if (startParam && startParam !== uid) {
                    const referrerRef = db.collection('users').doc(String(startParam));
                    const referrerDoc = await t.get(referrerRef);
                    
                    if (referrerDoc.exists) {
                        t.update(referrerRef, {
                            coins: admin.firestore.FieldValue.increment(2), // 2 point referral bonus
                            referrals: admin.firestore.FieldValue.increment(1) 
                        });
                    }
                }
            } else {
                t.update(userRef, {
                    lastActive: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Sync Transaction Failed:", e);
        res.status(500).json({ error: 'DB Error on Sync (Check Firebase Service Account/API)' });
    }
});

// 2. Claim Reward (Fixed and Secure Point Counting)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error("User data missing. Sync failed.");
            
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(1), 
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        res.json({ success: true, reward: 1 });
    } catch (e) {
        console.error("Claim Reward Transaction Failed:", e);
        res.status(500).json({ error: `DB Write Error: ${e.message}` });
    }
});

// 3. Withdraw Request
app.post('/api/withdraw', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { method, number, amountPoints } = req.body;

    if (!method || !number || !amountPoints || typeof amountPoints !== 'number' || amountPoints < 1000 || number.length !== 11) {
        return res.status(400).json({ error: "Invalid withdrawal amount or details." });
    }

    try {
        await db.runTransaction(async (t) => {
            const userRef = db.collection('users').doc(uid);
            const doc = await t.get(userRef);
            if (!doc.exists) throw new Error("User data missing.");
            
            const data = doc.data();
            const balance = data?.coins || 0;
            const refCount = data?.referrals || 0;

            if (balance < 1000) throw new Error("Min 1000 Points required");
            if (refCount < 20) throw new Error("Min 20 Referrals required");
            if (amountPoints > balance) throw new Error("Insufficient Balance");
            
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(-amountPoints)
            });

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
        if (e.message.includes("Points required")) return res.status(400).json({ error: "Need 1000+ Points!" });
        if (e.message.includes("Referrals required")) return res.status(400).json({ error: "Need 20+ Referrals!" });
        if (e.message.includes("Insufficient Balance")) return res.status(400).json({ error: "Insufficient Balance" });
        
        res.status(500).json({ error: 'Withdrawal processing failed.' });
    }
});


// 4. ADMIN ENDPOINT: Get All Pending Withdrawals
app.get('/admin/withdrawals', verifyAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection('withdrawals')
                                  .where('status', '==', 'pending')
                                  .orderBy('timestamp', 'asc')
                                  .get();
        
        const withdrawals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(withdrawals);

    } catch (e) {
        console.error("Admin Get Error:", e);
        res.status(500).json({ error: 'Failed to fetch withdrawals.' });
    }
});

// 5. ADMIN ENDPOINT: Update Withdrawal Status (Payment Confirmation)
app.post('/admin/update-withdrawal', verifyAdmin, async (req, res) => {
    const { withdrawalId, newStatus } = req.body;

    if (!withdrawalId || !['approved', 'rejected'].includes(newStatus)) {
        return res.status(400).json({ error: "Invalid parameters." });
    }

    try {
        const withdrawalRef = db.collection('withdrawals').doc(withdrawalId);
        
        await db.runTransaction(async (t) => {
            const withdrawalDoc = await t.get(withdrawalRef);
            if (!withdrawalDoc.exists) throw new Error("Withdrawal not found.");
            
            if (withdrawalDoc.data().status !== 'pending') {
                throw new Error("Withdrawal already processed.");
            }

            // Rejected হলে পয়েন্ট ফেরত
            if (newStatus === 'rejected') {
                const userId = withdrawalDoc.data().userId;
                const amountPoints = withdrawalDoc.data().amountPoints;
                
                const userRef = db.collection('users').doc(userId);
                
                t.update(userRef, {
                    coins: admin.firestore.FieldValue.increment(amountPoints)
                });
            }
            
            // Status আপডেট
            t.update(withdrawalRef, {
                status: newStatus,
                processedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.json({ success: true, message: `Withdrawal ${newStatus}.` });
    } catch (e) {
        res.status(500).json({ error: `Transaction failed: ${e.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
