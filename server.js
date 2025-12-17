const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

try {
    const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    const decodedKey = JSON.parse(Buffer.from(base64Key, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(decodedKey) });
} catch (e) { console.error("Init Error:", e.message); }

const db = admin.firestore();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = "8144732556";

app.post('/api/sync', async (req, res) => {
    try {
        const { userId, name, startParam } = req.body;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (!doc.exists) {
            await userRef.set({
                balance: 0, dailyMonetag: 0, totalMonetag: 0, dailyAdsterra: 0,
                lastMonetagTime: 0, lastAdsterraTime: 0, name: name || "User"
            });
            if (startParam && startParam !== userId) {
                const refRef = db.collection('users').doc(startParam);
                await refRef.update({ balance: admin.FieldValue.increment(1) });
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, amount, method, number } = req.body;
        // মিনিমাম ৮০০ পয়েন্ট চেক
        if (amount < 800) return res.status(400).send("Minimum 800 PT");
        
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (doc.data().balance < amount) return res.status(400).send("Low Balance");

        await userRef.update({ balance: admin.FieldValue.increment(-amount) });
        const msg = `💰 *Cashout*\nUser: ${userId}\nAmt: ${amount}\nVia: ${method}\nNum: ${number}`;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${ADMIN_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(process.env.PORT || 3000);
