require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Service Account from Env
const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// BD Date Function
const getBDDate = () => new Date(new Date().getTime() + (6 * 60 * 60 * 1000)).toISOString().slice(0, 10);

const verify = (req, res, next) => {
    const data = req.headers['x-telegram-init-data'];
    if(!data) return res.status(403).json({message: "No Auth"});
    const params = new URLSearchParams(data);
    req.tgUser = JSON.parse(params.get('user'));
    next();
};

app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = getBDDate();
    const userRef = db.collection('users').doc(uid);
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) {
                t.set(userRef, { coins: 0, referrals: 0, adsToday: 0, adstarToday: 0, totalAdsWatched: 0, uName: req.tgUser.first_name, lastAdDate: today, lastAdstarDate: today });
            } else {
                const d = doc.data();
                if(d.lastAdDate !== today) t.update(userRef, { adsToday: 0, lastAdDate: today });
                if(d.lastAdstarDate !== today) t.update(userRef, { adstarToday: 0, lastAdstarDate: today });
            }
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claim-reward', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();
    if(d.adsToday >= 20) return res.json({message: "Monetag Daily Limit Reached!"});
    await ref.update({ coins: admin.firestore.FieldValue.increment(1), adsToday: d.adsToday + 1, totalAdsWatched: admin.firestore.FieldValue.increment(1) });
    res.json({message: "SUCCESS: +1 Point!"});
});

app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();
    if(d.adstarToday >= 10) return res.json({message: "Adstar Daily Limit Reached!"});
    await ref.update({ coins: admin.firestore.FieldValue.increment(1), adstarToday: d.adstarToday + 1, totalAdsWatched: admin.firestore.FieldValue.increment(1) });
    res.json({message: "Adstar View Counted (+1 Pt)"});
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { amount, method, phone } = req.body;
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const d = userSnap.data();

    if(d.coins < amount || d.referrals < 5) return res.json({message: "Need 2000 Pts & 5 Refs!"});

    await db.collection('withdrawals').add({ 
        uid, name: d.uName, amount, method, phone, status: "PENDING", 
        time: admin.firestore.FieldValue.serverTimestamp() 
    });

    await userRef.update({ coins: admin.firestore.FieldValue.increment(-amount) });

    // Telegram Notification from Env
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const text = `💰 *New Withdrawal Request*\n\n👤 Name: ${d.uName}\n🆔 ID: ${uid}\n💵 Amount: ${amount} Pts\n🏦 Method: ${method}\n📱 Phone: ${phone}\n\nCheck Firebase to pay!`;
    
    if(botToken && chatId) {
        axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text: text, parse_mode: 'Markdown' }).catch(e => console.log("TG Error"));
    }

    res.json({ ok: true, message: "২৪ ঘন্টার ভিতরে পেমেন্ট পেয়ে যাবেন!" });
});

app.listen(process.env.PORT || 3000);
