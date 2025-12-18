require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios'); // For Telegram API

const app = express();
app.use(cors());
app.use(express.json());

const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// --- TELEGRAM CONFIG ---
const BOT_TOKEN = "7864878485:AAGrX9lO2i62XUa-Gv5_YQhU7YV7L6r1yis"; // তোমার বট টোকেন
const MY_CHAT_ID = "7449520443"; // তোমার চ্যাট আইডি
// -----------------------

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
    const today = getBDDate();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();
    if(d.adsToday >= 20) return res.json({message: "Limit Reached!"});
    await ref.update({ coins: admin.firestore.FieldValue.increment(1), adsToday: d.adsToday + 1 });
    res.json({message: "+1 Point Added!"});
});

app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = getBDDate();
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();
    if(d.adstarToday >= 10) return res.json({message: "Limit Reached!"});
    await ref.update({ coins: admin.firestore.FieldValue.increment(1), adstarToday: d.adstarToday + 1 });
    res.json({message: "Adstar +1 Pt!"});
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { amount, method, phone } = req.body;
    const userRef = db.collection('users').doc(uid);
    const d = (await userRef.get()).data();

    if(d.coins < amount || d.referrals < 5) return res.json({message: "Insufficient Balance/Refs!"});

    // Save to Firestore
    await db.collection('withdrawals').add({ uid, name: d.uName, amount, method, phone, status: "PENDING", time: admin.firestore.FieldValue.serverTimestamp() });
    // Deduct Coins
    await userRef.update({ coins: admin.firestore.FieldValue.increment(-amount) });

    // Send Telegram Notification
    const text = `💰 *New Withdrawal Request*\n\n👤 Name: ${d.uName}\n🆔 ID: ${uid}\n💵 Amount: ${amount} Pts\n🏦 Method: ${method}\n📱 Phone: ${phone}\n\nCheck Firebase to pay!`;
    axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: MY_CHAT_ID, text: text, parse_mode: 'Markdown' });

    res.json({ ok: true, message: "২৪ ঘন্টার ভিতরে পেমেন্ট পেয়ে যাবেন!" });
});

app.listen(process.env.PORT || 3000);
