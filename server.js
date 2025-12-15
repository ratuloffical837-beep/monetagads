// server.js (FINAL VERSION with Admin/Social Links/Postback Fix)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' })); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
// IMPORTANT: Initialize Firebase Admin SDK via Environment Variable (Base64)
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8');
        serviceAccount = JSON.parse(jsonString);
    } else {
        console.warn("Using local service account key path. Ensure FIREBASE_SERVICE_ACCOUNT_BASE64 is set in production.");
    }
    
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${serviceAccount.project_id}.firebaseio.com` 
        });
    } else {
        console.error("FATAL: Firebase Admin SDK could not initialize.");
    }

} catch (e) {
    console.error("Firebase Config Error:", e.message);
}

const db = admin.firestore();

// --- SECURITY CONSTANTS ---
// CRITICAL: Ensure you set these in Render Environment Variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const MONETAG_SECRET_KEY = process.env.MONETAG_SECRET_KEY || 'MONETAG_SECRET_TOKEN_4241'; // ডিফল্ট কী
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ratulhossain123@$&'; // আপনার সেট করা পাসওয়ার্ড

// --- TELEGRAM AUTH MIDDLEWARE (DO NOT REMOVE) ---
const verifyTelegram = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData || !BOT_TOKEN) {
        return res.status(403).json({ error: "Integrity Failed: Missing Token or Data" });
    }
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataToCheck = [...urlParams.entries()]
            .map(([key, val]) => `${key}=${val}`)
            .sort()
            .join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataToCheck).digest('hex');

        if (calculatedHash !== hash) {
            console.error("Hash Mismatch.");
            return res.status(403).json({ error: "Integrity Failed: Invalid Auth Token or Data" });
        }
        req.tgUser = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        console.error("Auth Error:", e);
        return res.status(403).json({ error: "Integrity Failed: Malformed Data" });
    }
};

// --- CORE POSTBACK HANDLER FUNCTION ---
// Function to process both postback routes
async function handleMonetagPostback(req, res) {
    // We look for tgid/pay (simplified) or telegram_id/estimated_price (Monetag preferred)
    const { tgid, pay, telegram_id, estimated_price, ymid, reward_type, secret } = req.query;

    // Determine which parameters were sent
    const finalTgid = tgid || telegram_id;
    const finalPayout = pay || estimated_price;
    
    // 1. Secret Key Verification - We check for the 'secret' parameter first
    if (!secret || secret !== MONETAG_SECRET_KEY) {
        // If 'secret' is missing, check if it's the Mini App loading (not a real postback attempt)
        if (req.originalUrl === '/' && !req.query.ymid) {
            return res.sendFile(path.join(__dirname, 'index.html'));
        }
        
        // If it has query parameters but no secret, it's a suspicious postback or failed simple config
        if (req.query.ymid) {
             console.warn(`Postback Security Failure: Invalid Secret Key. Received: ${secret}`);
             return res.status(403).send('Invalid Secret Key');
        }
    }
    
    // 2. Validate essential parameters
    const uid = String(finalTgid); 
    const transactionId = String(ymid);
    const rewardAmount = parseFloat(finalPayout); 

    if (!uid || !transactionId || reward_type !== 'yes' || rewardAmount <= 0) {
        return res.status(400).send('Invalid or non-rewardable event. (Missing UID, YMID, or paid event)');
    }

    // 3. Prevent duplicate transactions
    const transactionRef = db.collection('monetag_rewards').doc(transactionId);
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(transactionRef);

            if (doc.exists) {
                console.log(`Duplicate transaction ignored: ${transactionId}`);
                return; 
            }

            // Record transaction and reward user
            t.set(transactionRef, {
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                userId: uid,
                payout: rewardAmount,
                source: req.originalUrl
            });

            // *** REWARD USER WITH 1 POINT ***
            const userRef = db.collection('users').doc(uid);
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(1), 
            });

            console.log(`Postback Success: Reward given to user ${uid}`);
        });

        res.status(200).send('OK'); 

    } catch (e) {
        console.error("Monetag Postback DB Error:", e);
        res.status(500).send('Server Error');
    }
}


// --- ROUTES ---

// Route 1: Serves the HTML file OR handles Postback if sent to the root URL (For simple Monetag config)
app.get('/', handleMonetagPostback); 

// Route 2: Handles Postback if sent to the specified API endpoint (Standard config)
app.get('/api/monetag-callback', handleMonetagPostback); 


// 1. Sync User & Handle Referrals
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
                            coins: admin.firestore.FieldValue.increment(1), // 1 point per referral
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

// 2. Front-end Claim (Tracks ad views and cooldown time only)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    const today = new Date().toISOString().slice(0, 10);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";
            
            // Update ad watch counts and time
            t.update(userRef, {
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastAdTime: admin.firestore.FieldValue.serverTimestamp(),
                lastAdDate: today,
                adsToday: admin.firestore.FieldValue.increment(1) // Increment daily counter
            });
        });
        res.json({ success: true, reward: 0 }); 
    } catch (e) {
        console.error("Claim Error:", e);
        res.status(500).json({ error: 'Transaction Failed' });
    }
});

// 4. Withdraw Request
app.post('/api/withdraw', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { method, number, amountPoints } = req.body;
    const userRef = db.collection('users').doc(uid);

    const MIN_POINTS = 600; 
    const MIN_REFERRALS = 10; 

    try {
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

            // Deduct Points
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(-amountPoints)
            });

            // Create Withdrawal Record (Status: pending)
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
        const isLogicError = typeof e === 'string';
        res.status(isLogicError ? 400 : 500).json({ error: isLogicError ? e : 'Withdrawal Processing Error' });
    }
});

// 5. --- ADMIN PANEL ROUTES ---

// Admin Login Page
app.get('/admin', (req, res) => {
    res.send(`
        <body style="background: #0b0f19; color: white; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; font-family: sans-serif;">
            <h2 style="color: #00f0ff;">Admin Login</h2>
            <form method="POST" action="/admin/login" style="background: #151922; padding: 30px; border-radius: 10px; border: 1px solid #00f0ff;">
                <input type="password" name="password" placeholder="Enter Admin Password" required 
                       style="padding: 10px; margin-bottom: 15px; width: 100%; border-radius: 5px; border: 1px solid #444; background: #222; color: white;">
                <button type="submit" style="width: 100%; padding: 10px; background: #00f0ff; color: black; border: none; border-radius: 5px; font-weight: bold; cursor: pointer;">Login</button>
            </form>
        </body>
    `);
});

// Admin Login Handler
app.post('/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        res.redirect(`/admin/withdrawals?token=${ADMIN_PASSWORD}`);
    } else {
        res.status(401).send('Invalid Admin Password');
    }
});

// Admin Dashboard - View and Manage Withdrawals
app.get('/admin/withdrawals', async (req, res) => {
    // Token verification
    if (req.query.token !== ADMIN_PASSWORD) {
        return res.status(401).send('Unauthorized Access');
    }

    try {
        const snapshot = await db.collection('withdrawals').orderBy('timestamp', 'desc').get();
        let withdrawals = [];
        snapshot.forEach(doc => {
            withdrawals.push({ id: doc.id, ...doc.data() }); 
        });

        const listItems = withdrawals.map(w => {
            const statusColor = w.status === 'pending' ? 'yellow' : (w.status === 'approved' ? 'lime' : 'red');
            return `
                <div style="background: #1a1f2e; padding: 15px; margin-bottom: 10px; border-radius: 8px; border-left: 5px solid ${statusColor};">
                    <strong>ID: ${w.id}</strong><br>
                    User ID: ${w.userId} (Username: ${w.username})<br>
                    Amount: ${w.amountPoints} Points<br>
                    Method: ${w.method} / Number: ${w.number}<br>
                    Status: <strong style="color: ${statusColor};">${w.status.toUpperCase()}</strong><br>
                    Timestamp: ${w.timestamp.toDate().toLocaleString()}<br>
                    ${w.status === 'pending' ? `
                        <form method="POST" action="/admin/action" style="margin-top: 10px;">
                            <input type="hidden" name="id" value="${w.id}">
                            <input type="hidden" name="token" value="${ADMIN_PASSWORD}">
                            <input type="hidden" name="user_id" value="${w.userId}">
                            <input type="hidden" name="amount" value="${w.amountPoints}">
                            <button type="submit" name="action" value="approved" style="background: lime; color: black; border: none; padding: 8px; cursor: pointer; margin-right: 10px; border-radius: 5px;">APPROVE</button>
                            <button type="submit" name="action" value="rejected" style="background: red; color: white; border: none; padding: 8px; cursor: pointer; border-radius: 5px;">REJECT</button>
                        </form>
                    ` : ''}
                </div>
            `;
        }).join('');

        res.send(`
            <body style="background: #0b0f19; color: white; font-family: sans-serif; padding: 20px;">
                <h1 style="color: #00f0ff;">Admin Dashboard - Withdrawal Requests</h1>
                <p style="color: #ccc;">Total Requests: ${withdrawals.length}</p>
                <div style="max-width: 800px; margin: auto;">${listItems}</div>
                <a href="/admin" style="display: block; margin-top: 20px; color: #ff8b00;">Logout</a>
            </body>
        `);

    } catch (e) {
        console.error("Admin DB Error:", e);
        res.status(500).send('Database connection error in Admin panel.');
    }
});

// Admin Action Handler (Approve/Reject)
app.post('/admin/action', async (req, res) => {
    if (req.body.token !== ADMIN_PASSWORD) {
        return res.status(401).send('Unauthorized Access');
    }

    const { id, action, user_id, amount } = req.body;
    if (!id || !['approved', 'rejected'].includes(action)) {
        return res.status(400).send('Invalid request.');
    }

    try {
        await db.runTransaction(async (t) => {
            const withdrawalRef = db.collection('withdrawals').doc(id);
            const withdrawalDoc = await t.get(withdrawalRef);

            if (!withdrawalDoc.exists || withdrawalDoc.data().status !== 'pending') {
                return; // Already processed or doesn't exist
            }

            t.update(withdrawalRef, {
                status: action,
                processedAt: admin.firestore.FieldValue.serverTimestamp()
            });

            // If rejected, refund the points to the user
            if (action === 'rejected') {
                const userRef = db.collection('users').doc(user_id);
                // Refund the deducted amount
                t.update(userRef, {
                    coins: admin.firestore.FieldValue.increment(parseInt(amount)) 
                });
            }
        });
        
        res.redirect(`/admin/withdrawals?token=${ADMIN_PASSWORD}`);
    } catch (e) {
        console.error("Admin Action Failed:", e);
        res.status(500).send('Failed to update status.');
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
