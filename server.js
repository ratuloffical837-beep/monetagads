const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin Setup (Use environment variables for security)
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 🟢 MONETAG POSTBACK (শুধুমাত্র এখান থেকেই আসল পয়েন্ট আসবে)
app.get('/postback/monetag', async (req, res) => {
    const { ymid, txid, paid, event } = req.query;
    if (paid !== 'yes' || !['impression', 'click'].includes(event)) return res.send("ignored");

    try {
        const txRef = db.collection('transactions').doc(txid);
        const txDoc = await txRef.get();
        if (txDoc.exists) return res.send("duplicate");

        const userRef = db.collection('users').doc(ymid);
        await db.runTransaction(async (t) => {
            t.set(txRef, { time: admin.FieldValue.serverTimestamp(), user: ymid });
            t.update(userRef, { 
                balance: admin.FieldValue.increment(1),
                totalAds: admin.FieldValue.increment(1) 
            });
        });
        res.send("ok");
    } catch (e) { res.status(500).send("error"); }
});

// 🔵 USER SYNC & REFERRAL SYSTEM
app.post('/api/sync', async (req, res) => {
    const { userId, startParam } = req.body;
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();

    if (!doc.exists) {
        await userRef.set({
            balance: 0, referrals: 0, totalAds: 0, dailyTask: 0,
            joined: admin.FieldValue.serverTimestamp()
        });
        if (startParam && startParam !== userId) {
            const refRef = db.collection('users').doc(startParam);
            await refRef.update({ balance: admin.FieldValue.increment(1), referrals: admin.FieldValue.increment(1) });
        }
    }
    res.json({ success: true });
});

app.listen(process.env.PORT || 3000, () => console.log("Server Active"));
