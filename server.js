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
} catch (e) { console.error("Firebase Init Fail"); }

const db = admin.firestore();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = "8144732556";

// Sync & Daily Reset
app.post('/api/sync', async (req, res) => {
    try {
        const { userId, name } = req.body;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        const today = new Date().toISOString().split('T')[0];

        if (!doc.exists) {
            await userRef.set({
                balance: 0, dailyMonetag: 0, totalMonetag: 0, dailyAdsterra: 0,
                lastMonetagTime: 0, lastAdsterraTime: 0, lastResetDate: today, name: name || "User"
            });
        } else {
            if (doc.data().lastResetDate !== today) {
                await userRef.update({ dailyMonetag: 0, dailyAdsterra: 0, lastResetDate: today });
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

// Reward Claim (Check First, Then Update)
app.post('/api/verify-reward', async (req, res) => {
    try {
        const { userId, type } = req.body;
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if(!doc.exists) return res.status(404).json({ allowed: false });

        const data = doc.data();
        const now = Date.now();
        
        if (type === 'monetag') {
            const diff = (now - (data.lastMonetagTime || 0)) / 1000;
            if (diff < 600) return res.status(400).json({ allowed: false, msg: "Cooldown" });
            if (data.dailyMonetag >= 20) return res.status(400).json({ allowed: false, msg: "Limit" });
            
            await userRef.update({
                balance: admin.FieldValue.increment(1),
                dailyMonetag: admin.FieldValue.increment(1),
                totalMonetag: admin.FieldValue.increment(1),
                lastMonetagTime: now
            });
        } else if (type === 'adsterra') {
            const diff = (now - (data.lastAdsterraTime || 0)) / 1000;
            if (diff < 1200) return res.status(400).json({ allowed: false, msg: "Cooldown" });
            if (data.dailyAdsterra >= 10) return res.status(400).json({ allowed: false, msg: "Limit" });
            
            await userRef.update({
                balance: admin.FieldValue.increment(1),
                dailyAdsterra: admin.FieldValue.increment(1),
                lastAdsterraTime: now
            });
        }
        res.json({ allowed: true });
    } catch (e) { res.status(500).json({ allowed: false }); }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, amount, method, number } = req.body;
        if (amount < 800) return res.status(400).send("Min 800");
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (doc.data().balance < amount) return res.status(400).send("Low Bal");

        await userRef.update({ balance: admin.FieldValue.increment(-amount) });
        const msg = `💰 *Cashout*\nID: \`${userId}\`\nAmt: ${amount}\nMethod: ${method}\nNum: ${number}`;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${ADMIN_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`);
        res.json({ success: true });
    } catch (e) { res.status(500).send("Error"); }
});

app.listen(process.env.PORT || 3000);
