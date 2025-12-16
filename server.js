// server.js (FINAL v5 - Postback & Referral Fixes Applied)
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
// Serve index.html from root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- CONFIGURATION ---
let serviceAccount;
try {
    // Attempt to parse Firebase service account from environment variable
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
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
    }

} catch (e) {
    console.error("Firebase Config Error:", e.message);
}

const db = admin.firestore();

// --- SECURITY CONSTANTS (Set these in your Render Environment Variables) ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ratulhossain123@$&'; 

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
        
        // Extract start_param (Referral ID) from initData
        req.startParam = urlParams.get('start_param') || null;

        next();
    } catch (e) {
        console.error("Auth Error:", e);
        return res.status(403).json({ error: "Integrity Failed: Malformed Data" });
    }
};

// --- CORE POSTBACK HANDLER FUNCTION (SECURE POINT COUNTING) ---
async function handleMonetagPostback(req, res) {
    // Collect all macros from the URL
    const { 
        telegram_id, 
        reward_event_type, 
        ymid, 
        value: reward_type_alt // Alternate field for reward status
    } = req.query;

    const finalTgid = telegram_id;
    const finalRewardType = reward_event_type || reward_type_alt; 
    
    // 1. Validate essential parameters and reward status
    const uid = String(finalTgid); 
    const transactionId = String(ymid);
    
    // Only reward if Monetag confirms it was a paid event ('yes' or 'valued')
    if (!uid || !transactionId || (finalRewardType !== 'yes' && finalRewardType !== 'valued')) {
        console.warn(`Postback Ignored: Not a valued event for UID ${uid}. Type: ${finalRewardType}`);
        return res.status(200).send('Ignored: Not a valued event.');
    }
    
    // 2. Prevent duplicate transactions (ymid acts as transaction ID)
    const transactionRef = db.collection('monetag_rewards').doc(transactionId);
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(transactionRef);

            if (doc.exists) {
                console.log(`Duplicate transaction ignored: ${transactionId}`);
                return; 
            }

            // Record transaction
            t.set(transactionRef, {
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                userId: uid,
                source: req.originalUrl,
                rewardType: finalRewardType 
            });

            // *** REWARD USER WITH 1 VALID COIN (SECURE POSTBACK POINT) ***
            const userRef = db.collection('users').doc(uid);
            t.update(userRef, {
                validCoins: admin.firestore.FieldValue.increment(1), 
            });

            console.log(`✅ Postback Success: Secure Coin given to user ${uid}.`);
        });

        res.status(200).send('OK'); 

    } catch (e) {
        console.error("Monetag Postback DB Error:", e);
        res.status(500).send('Server Error');
    }
}


// --- API ROUTES ---

app.get('/api/monetag-callback', handleMonetagPostback); 


// 1. Sync User & Handle Referrals 
app.post('/api/sync', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const startParam = req.startParam; // Referral ID
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

                // Check for referral (if a new user came via a link)
                if (startParam && String(startParam) !== uid) {
                    const referrerId = String(startParam);
                    const referrerRef = db.collection('users').doc(referrerId);
                    const referrerDoc = await t.get(referrerRef);
                    
                    if (referrerDoc.exists) {
                        t.update(referrerRef, {
                            coins: admin.firestore.FieldValue.increment(1), // Referrer gets +1 Withdrawal Point
                            referrals: admin.firestore.FieldValue.increment(1) // Referrer gets +1 Count
                        });
                        console.log(`✅ Referral Success: User ${uid} referred by ${referrerId}.`);
                    } else {
                        console.warn(`Referrer ID ${referrerId} not found in DB.`);
                    }
                }
            } else {
                 // User exists, just syncing data for the front-end
            }
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Sync/Referral Error:", e);
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
        console.error("Claim Error:", e);
        res.status(500).json({ error: 'Transaction Failed' });
    }
});

// 3. Withdraw Request
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

            // Deduct Points from UNSECURE COINS
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
        const isLogicError = typeof e === 'string';
        res.status(isLogicError ? 400 : 500).json({ error: isLogicError ? e : 'Withdrawal Processing Error' });
    }
});

// --- ADMIN ROUTES (For viewing and managing withdrawals) ---
app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Admin Login</title><style>body{font-family: 'Rajdhani', sans-serif; background: #0b0f19; color: #fff; text-align: center; padding-top: 50px;}.container{background: rgba(42, 49, 66, 0.9); padding: 40px; border-radius: 15px; display: inline-block; box-shadow: 0 0 20px rgba(0, 240, 255, 0.3);}h2{color: #00f0ff; font-family: 'Orbitron', sans-serif;}input, button{padding: 12px 15px; margin: 10px 0; border-radius: 8px; border: 1px solid #444; background: #1a1a1a; color: #fff; width: 100%; box-sizing: border-box;}button{background: #bc13fe; cursor: pointer; border: none; font-weight: bold; transition: background 0.3s;}button:hover{background: #a410db;}</style></head><body><div class="container"><h2>ADMIN PANEL LOGIN</h2><form action="/admin/login" method="POST"><input type="password" name="password" placeholder="Admin Password" required><button type="submit">LOGIN SECURELY</button></form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.redirect(`/admin/withdrawals?token=${ADMIN_PASSWORD}`);
    } else {
        res.status(401).send(`<!DOCTYPE html><html><head><title>Unauthorized</title><style>body{font-family:sans-serif;background:#1a1f2e;color:#fff;text-align:center;padding-top:50px;} h2{color:#ff3b30;}</style></head><body><h2>UNAUTHORIZED ACCESS</h2><p>Invalid Password. Please <a href="/admin">try again</a>.</p></body></html>`);
    }
});

app.get('/admin/withdrawals', async (req, res) => {
    if (req.query.token !== ADMIN_PASSWORD) {
        return res.status(401).send('Unauthorized Access');
    }

    try {
        const snapshot = await db.collection('withdrawals')
            .where('status', '==', 'pending')
            .orderBy('timestamp', 'asc')
            .get();
        
        const userIds = [...new Set(snapshot.docs.map(doc => doc.data().userId))];
        const usersSnapshot = await db.collection('users').where(admin.firestore.FieldPath.documentId(), 'in', userIds).get();
        const userBalances = usersSnapshot.docs.reduce((acc, doc) => {
            acc[doc.id] = { 
                coins: doc.data().coins || 0,
                validCoins: doc.data().validCoins || 0,
                referrals: doc.data().referrals || 0
            };
            return acc;
        }, {});


        let html = `
            <!DOCTYPE html>
            <html><head><title>Pending Withdrawals</title>
            <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
            <style>
            body{font-family:'Rajdhani', sans-serif;background:#0b0f19;color:#fff;padding:20px;}
            h2{color:#00f0ff; font-family:'Orbitron', sans-serif;}
            table{width:100%;border-collapse:separate;border-spacing:0 10px;margin-top:20px;}
            th,td{padding:15px;text-align:left;background:#1a1f2e;border:none;vertical-align:top;}
            th{background:#2a3142;color:#00f0ff;text-transform:uppercase;font-size:14px;border-bottom:2px solid #00f0ff;}
            tr{box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);}
            td:first-child{border-top-left-radius:8px;border-bottom-left-radius:8px;}
            td:last-child{border-top-right-radius:8px;border-bottom-right-radius:8px;}
            .btn-action{padding:10px 15px;border:none;border-radius:5px;cursor:pointer;margin:4px 0;width:100%;font-weight:bold;}
            .btn-approve{background:#34c759;color:#fff;}
            .btn-reject{background:#ff3b30;color:#fff;}
            .status-box{background:#444;padding:8px;border-radius:5px;font-size:12px;}
            .balance-info{font-size:13px;color:#ccc;}
            .balance-info span{color:#00f0ff;font-weight:bold;}
            .danger{color:#ff3b30;font-weight:bold;}
            </style>
            </head><body>
            <h2>PENDING WITHDRAWAL REQUESTS (${snapshot.size})</h2>
            <p><a href="/admin" style="color:#bc13fe; text-decoration:none;">&#x2190; Logout</a> | <a href="/admin/withdrawals?token=${ADMIN_PASSWORD}" style="color:#34c759; text-decoration:none;">&#x21bb; Refresh</a></p>
            <table>
                <thead>
                    <tr>
                        <th style="width:10%;">ID</th>
                        <th style="width:25%;">User Info</th>
                        <th style="width:20%;">Request Details</th>
                        <th style="width:25%;">Balances (Audit)</th>
                        <th style="width:20%;">Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

        snapshot.forEach(doc => {
            const data = doc.data();
            const date = data.timestamp ? new Date(data.timestamp.toDate()).toLocaleString() : 'N/A';
            const balanceData = userBalances[data.userId] || { coins: 0, validCoins: 0, referrals: 0 };
            
            html += `
                <tr>
                    <td>${doc.id.substring(0, 6)}...</td>
                    <td>
                        <strong>${data.username}</strong><br>
                        <span class="status-box">ID: ${data.userId}</span>
                        <p style="margin:5px 0 0 0;">Requested: ${date}</p>
                    </td>
                    <td>
                        Points: <strong>${data.amountPoints}</strong><br>
                        Method: <span>${data.method}</span><br>
                        Number: <strong>${data.number}</strong>
                    </td>
                    <td>
                        <div class="balance-info">
                            <p style="margin:0;">**Withdrawal Balance (UNSECURE): <span>${balanceData.coins}</span></p>
                            <p style="margin:5px 0;">Postback Coins (SECURE): <span>${balanceData.validCoins}</span></p>
                            <p style="margin:0;">Referrals: <span>${balanceData.referrals}</span></p>
                            ${balanceData.coins < data.amountPoints ? '<p class="danger">INSUFFICIENT BALANCE</p>' : ''}
                        </div>
                    </td>
                    <td>
                        <form action="/admin/action" method="POST" style="display:block;">
                            <input type="hidden" name="token" value="${ADMIN_PASSWORD}">
                            <input type="hidden" name="id" value="${doc.id}">
                            <input type="hidden" name="action" value="approved">
                            <input type="hidden" name="user_id" value="${data.userId}">
                            <input type="hidden" name="amount" value="${data.amountPoints}">
                            <button type="submit" class="btn-action btn-approve">APPROVE</button>
                        </form>
                        <form action="/admin/action" method="POST" style="display:block;">
                            <input type="hidden" name="token" value="${ADMIN_PASSWORD}">
                            <input type="hidden" name="id" value="${doc.id}">
                            <input type="hidden" name="action" value="rejected">
                            <input type="hidden" name="user_id" value="${data.userId}">
                            <input type="hidden" name="amount" value="${data.amountPoints}">
                            <button type="submit" class="btn-action btn-reject">REJECT & REFUND</button>
                        </form>
                    </td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
            </body></html>
        `;
        res.send(html);

    } catch (e) {
        console.error("Admin Fetch Error:", e);
        res.status(500).send('Server Error fetching withdrawals.');
    }
});


app.post('/admin/action', async (req, res) => {
    if (req.body.token !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized Access');
    const { id, action, user_id, amount } = req.body;
    if (!id || !['approved', 'rejected'].includes(action)) return res.status(400).send('Invalid request.');

    try {
        await db.runTransaction(async (t) => {
            const withdrawalRef = db.collection('withdrawals').doc(id);
            const withdrawalDoc = await t.get(withdrawalRef);

            if (!withdrawalDoc.exists || withdrawalDoc.data().status !== 'pending') return;

            t.update(withdrawalRef, { status: action, processedAt: admin.firestore.FieldValue.serverTimestamp() });

            if (action === 'rejected') {
                const userRef = db.collection('users').doc(user_id);
                // Refund to UNSECURE COINS
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
