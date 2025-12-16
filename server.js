// server.js (UPDATED - Withdrawal uses Instant Coins)
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
    } else {
        console.error("FATAL: Firebase Admin SDK could not initialize.");
    }

} catch (e) {
    console.error("Firebase Config Error:", e.message);
}

const db = admin.firestore();

// --- SECURITY CONSTANTS ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; 
const MONETAG_SECRET_KEY = process.env.MONETAG_SECRET_KEY || 'MONETAG_SECRET_TOKEN_4241'; 
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ratulhossain123@$&'; 

// --- TELEGRAM AUTH MIDDLEWARE ---
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
        req.tgUser = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        return res.status(403).json({ error: "Integrity Failed: Malformed Data" });
    }
};

// --- CORE POSTBACK HANDLER FUNCTION ---
async function handleMonetagPostback(req, res) {
    const { tgid, pay, telegram_id, estimated_price, ymid, reward_type, secret } = req.query;

    const finalTgid = tgid || telegram_id;
    const finalPayout = pay || estimated_price;
    
    // 1. Secret Key Verification
    if (!secret || secret !== MONETAG_SECRET_KEY) {
        if (req.originalUrl === '/' && !req.query.ymid) {
            return res.sendFile(path.join(__dirname, 'index.html'));
        }
        if (req.query.ymid) {
             console.warn(`Postback Security Failure: Invalid Secret Key. Received: ${secret}`);
             return res.status(403).send('Invalid Secret Key');
        }
    }
    
    // 2. Validate essential parameters
    const uid = String(finalTgid); 
    const transactionId = String(ymid);
    
    if (!uid || !transactionId || reward_type !== 'yes') {
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

            // Record transaction
            t.set(transactionRef, {
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                userId: uid,
                source: req.originalUrl
            });

            // *** REWARD USER WITH 1 VALID POINT (Display Only as per user request) ***
            const userRef = db.collection('users').doc(uid);
            t.update(userRef, {
                validCoins: admin.firestore.FieldValue.increment(1), // Display Only
            });

            console.log(`Postback Success: Valid Reward given to user ${uid} (Display Only)`);
        });

        res.status(200).send('OK'); 

    } catch (e) {
        console.error("Monetag Postback DB Error:", e);
        res.status(500).send('Server Error');
    }
}


// --- ROUTES ---

app.get('/', handleMonetagPostback); 
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
                    coins: 0, // Withdrawal Balance (UNSECURE)
                    validCoins: 0, // Display Only
                    totalAdsWatched: 0,
                    referrals: 0,
                    joinedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                if (startParam && startParam !== uid) {
                    const referrerRef = db.collection('users').doc(String(startParam));
                    const referrerDoc = await t.get(referrerRef);
                    if (referrerDoc.exists) {
                        t.update(referrerRef, {
                            coins: admin.firestore.FieldValue.increment(1), // Referrals are UNSECURE points
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

// 2. Front-end Claim (IMMEDIATE POINT ADDITION FOR WITHDRAWAL)
app.post('/api/claim-reward', verifyTelegram, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    const today = new Date().toISOString().slice(0, 10);

    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) throw "User not found";
            
            // *** IMMEDIATE ADDITION OF WITHDRAWAL COINS (UNSECURE) ***
            t.update(userRef, {
                coins: admin.firestore.FieldValue.increment(1), // IMMEDIATE WITHDRAWAL POINT
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

// 3. Withdraw Request (USES UNSECURE coins BALANCE)
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
            const balance = data.coins || 0; // CHECKING THE UNSECURE COIN BALANCE
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

// 4. Admin Action Handler (Refund logic updated for coins)
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


// --- ADMIN & UTILITY ROUTES (Remains the same) ---

app.get('/admin', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html><head><title>Admin Login</title>
        <style>body{font-family:sans-serif;background:#1a1f2e;color:#fff;text-align:center;padding-top:50px;}input,button{padding:10px;margin:10px;border-radius:5px;border:none;}.container{background:#2a3142;padding:30px;border-radius:10px;display:inline-block;}</style>
        </head><body>
        <div class="container">
            <h2>Admin Login</h2>
            <form action="/admin/login" method="POST">
                <input type="password" name="password" placeholder="Admin Password" required>
                <button type="submit">Login</button>
            </form>
        </div>
        </body></html>
    `);
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        res.redirect(`/admin/withdrawals?token=${ADMIN_PASSWORD}`);
    } else {
        res.status(401).send('Unauthorized Access');
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
        
        let html = `
            <!DOCTYPE html>
            <html><head><title>Pending Withdrawals</title>
            <style>
            body{font-family:sans-serif;background:#1a1f2e;color:#fff;padding:20px;}
            h2{color:#00f0ff;}
            table{width:100%;border-collapse:collapse;margin-top:20px;background:#2a3142;}
            th,td{padding:12px;border:1px solid #444;text-align:left;}
            th{background:#3a4154;color:#00f0ff;}
            .btn-action{padding:8px 12px;border:none;border-radius:5px;cursor:pointer;margin:2px;}
            .btn-approve{background:#34c759;color:#fff;}
            .btn-reject{background:#ff3b30;color:#fff;}
            </style>
            </head><body>
            <h2>Pending Withdrawal Requests (${snapshot.size})</h2>
            <p><a href="/admin" style="color:#00f0ff;">Logout</a></p>
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>User</th>
                        <th>Amount (Pts)</th>
                        <th>Method</th>
                        <th>Number</th>
                        <th>Date</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
        `;

        snapshot.forEach(doc => {
            const data = doc.data();
            const date = data.timestamp ? new Date(data.timestamp.toDate()).toLocaleString() : 'N/A';
            
            html += `
                <tr>
                    <td>${doc.id.substring(0, 4)}...</td>
                    <td>${data.username} (${data.userId})</td>
                    <td>${data.amountPoints}</td>
                    <td>${data.method}</td>
                    <td>${data.number}</td>
                    <td>${date}</td>
                    <td>
                        <form action="/admin/action" method="POST" style="display:inline;">
                            <input type="hidden" name="token" value="${ADMIN_PASSWORD}">
                            <input type="hidden" name="id" value="${doc.id}">
                            <input type="hidden" name="action" value="approved">
                            <input type="hidden" name="user_id" value="${data.userId}">
                            <input type="hidden" name="amount" value="${data.amountPoints}">
                            <button type="submit" class="btn-action btn-approve">APPROVE</button>
                        </form>
                        <form action="/admin/action" method="POST" style="display:inline;">
                            <input type="hidden" name="token" value="${ADMIN_PASSWORD}">
                            <input type="hidden" name="id" value="${doc.id}">
                            <input type="hidden" name="action" value="rejected">
                            <input type="hidden" name="user_id" value="${data.userId}">
                            <input type="hidden" name="amount" value="${data.amountPoints}">
                            <button type="submit" class="btn-action btn-reject">REJECT</button>
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


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
