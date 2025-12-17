const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin SDK Initializing with Base64
const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const decodedKey = JSON.parse(Buffer.from(base64Key, 'base64').toString('utf8'));
admin.initializeApp({ credential: admin.credential.cert(decodedKey) });

const db = admin.firestore();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = "8144732556"; 

// 🟢 Sync User & Refer (+1 Point No Limit)
app.post('/api/sync', async (req, res) => {
    const { userId, name, startParam } = req.body;
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();

    if (!doc.exists) {
        await userRef.set({
            balance: 0, referrals: 0, dailyMonetag: 0, totalMonetag: 0,
            lastMonetagTime: 0, dailyAdsterra: 0, lastAdsterraTime: 0,
            lastReset: Date.now(), name: name
        });
        if (startParam && startParam !== userId) {
            const refRef = db.collection('users').doc(startParam);
            await refRef.update({ balance: admin.FieldValue.increment(1), referrals: admin.FieldValue.increment(1) });
        }
    } else if (Date.now() - doc.data().lastReset > 86400000) {
        await userRef.update({ dailyMonetag: 0, dailyAdsterra: 0, lastReset: Date.now() });
    }
    res.json({ success: true });
});

// 💰 Monetag Postback
app.get('/api/monetag-callback', async (req, res) => {
    const { ymid, paid } = req.query;
    if (paid !== 'yes') return res.send("failed");
    const userRef = db.collection('users').doc(ymid);
    await userRef.update({
        balance: admin.FieldValue.increment(1), dailyMonetag: admin.FieldValue.increment(1),
        totalMonetag: admin.FieldValue.increment(1), lastMonetagTime: Date.now()
    });
    res.send("ok");
});

// 🔴 Cashout Request
app.post('/api/withdraw', async (req, res) => {
    const { userId, amount, method, number } = req.body;
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (doc.data().balance < amount) return res.status(400).send("Insufficient Balance");

    await userRef.update({ balance: admin.FieldValue.increment(-amount) });
    const msg = `🔔 *New Cashout*\nUser: ${userId}\nAmount: ${amount}\nMethod: ${method}\nNumber: ${number}`;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${ADMIN_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`);
    res.json({ success: true });
});

app.listen(process.env.PORT || 3000);
