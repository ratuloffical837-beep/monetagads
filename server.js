require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const getBDDate = () => new Date(new Date().getTime() + (6 * 60 * 60 * 1000)).toISOString().slice(0, 10);

const verify = (req, res, next) => {
    const data = req.headers['x-telegram-init-data'];
    if(!data) return res.status(403).json({message: "No Auth"});
    const params = new URLSearchParams(data);
    req.tgUser = JSON.parse(params.get('user'));
    req.startParam = req.headers['x-start-param'] || "";
    next();
};

app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = getBDDate();
    const userRef = db.collection('users').doc(uid);
    
    await db.runTransaction(async (t) => {
        const doc = await t.get(userRef);
        if (!doc.exists) {
            t.set(userRef, { coins: 0, referrals: 0, adsToday: 0, adstarToday: 0, totalAdsWatched: 0, uName: req.tgUser.first_name, lastAdDate: today, lastAdstarDate: today });
            if (req.startParam && req.startParam !== uid) {
                const rRef = db.collection('users').doc(req.startParam);
                t.update(rRef, { coins: admin.firestore.FieldValue.increment(10), referrals: admin.firestore.FieldValue.increment(1) });
            }
        } else {
            const d = doc.data();
            let up = {};
            if(d.lastAdDate !== today) { up.adsToday = 0; up.lastAdDate = today; }
            if(d.lastAdstarDate !== today) { up.adstarToday = 0; up.lastAdstarDate = today; }
            if(Object.keys(up).length > 0) t.update(userRef, up);
        }
    });
    res.json({ ok: true });
});

app.post('/api/claim-reward', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();
    if(d.adsToday >= 20) return res.json({message: "Monetag Limit Reached!"});
    
    await ref.update({ 
        coins: admin.firestore.FieldValue.increment(1), 
        adsToday: admin.firestore.FieldValue.increment(1), 
        totalAdsWatched: admin.firestore.FieldValue.increment(1),
        lastAdTime: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({message: "Success: +1 Pt Added!"});
});

app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();
    if(d.adstarToday >= 10) return res.json({message: "Adstar Limit Reached!"});
    
    await ref.update({ 
        coins: admin.firestore.FieldValue.increment(1), 
        adstarToday: admin.firestore.FieldValue.increment(1), 
        totalAdsWatched: admin.firestore.FieldValue.increment(1),
        lastAdstarTime: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({message: "Adstar: +1 Pt Counted!"});
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { amount, method, phone } = req.body;
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();

    if(d.coins < amount) return res.json({ok:false, message:"পয়েন্ট কম আছে!"});
    if(d.referrals < 5) return res.json({ok:false, message:"৫টি রেফার লাগবে!"});

    await db.collection('withdrawals').add({ uid, name: d.uName, amount, method, phone, status: "PENDING", time: admin.firestore.FieldValue.serverTimestamp() });
    await ref.update({ coins: admin.firestore.FieldValue.increment(-amount) });

    const text = `💰 *Withdraw Request*\n👤 ${d.uName}\n💵 ${amount} Pts\n🏦 ${method}\n📱 ${phone}`;
    axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: process.env.TELEGRAM_CHAT_ID, text: text, parse_mode: 'Markdown' }).catch(()=>{});
    
    res.json({ ok: true, message: "রিকোয়েস্ট সফল হয়েছে!" });
});

app.listen(process.env.PORT || 3000);
