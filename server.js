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
    
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) {
                // New User Creation
                t.set(userRef, { 
                    coins: 0, referrals: 0, adsToday: 0, adstarToday: 0, 
                    totalAdsWatched: 0, uName: req.tgUser.first_name, 
                    lastAdDate: today, lastAdstarDate: today 
                });
                // Check Referral
                if (req.startParam && req.startParam !== uid) {
                    const refUserRef = db.collection('users').doc(req.startParam);
                    const refDoc = await t.get(refUserRef);
                    if(refDoc.exists) {
                        t.update(refUserRef, { 
                            coins: admin.firestore.FieldValue.increment(10), 
                            referrals: admin.firestore.FieldValue.increment(1) 
                        });
                    }
                }
            } else {
                const d = doc.data();
                let updates = {};
                if(d.lastAdDate !== today) { updates.adsToday = 0; updates.lastAdDate = today; }
                if(d.lastAdstarDate !== today) { updates.adstarToday = 0; updates.lastAdstarDate = today; }
                if(Object.keys(updates).length > 0) t.update(userRef, updates);
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
    if(d.adsToday >= 20) return res.json({message: "Daily Limit 20 Reached!"});
    
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
    if(d.adstarToday >= 10) return res.json({message: "Daily Limit 10 Reached!"});
    
    await ref.update({ 
        coins: admin.firestore.FieldValue.increment(1), 
        adstarToday: admin.firestore.FieldValue.increment(1), 
        totalAdsWatched: admin.firestore.FieldValue.increment(1),
        lastAdstarTime: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({message: "Adstar: +1 Pt Added!"});
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const { amount, method, phone } = req.body;
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();
    const d = doc.data();

    if(d.coins < amount) return res.json({ok: false, message: `আপনার পযাপ্ত ব্যালেন্স নেই। প্রয়োজন ${amount} পয়েন্ট!`});
    if(d.referrals < 5) return res.json({ok: false, message: "উইথড্র করতে কমপক্ষে ৫ জন রেফার লাগবে!"});

    await db.collection('withdrawals').add({ 
        uid, name: d.uName, amount, method, phone, status: "PENDING", 
        time: admin.firestore.FieldValue.serverTimestamp() 
    });
    await userRef.update({ coins: admin.firestore.FieldValue.increment(-amount) });

    const text = `💰 *Withdraw Request*\n👤 ${d.uName}\n💵 ${amount} Pts\n🏦 ${method}\n📱 ${phone}`;
    axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { 
        chat_id: process.env.TELEGRAM_CHAT_ID, text: text, parse_mode: 'Markdown' 
    }).catch(() => {});

    res.json({ ok: true, message: "রিকোয়েস্ট সফল! ২৪ ঘণ্টার মধ্যে পেমেন্ট পাবেন।" });
});

app.listen(process.env.PORT || 3000);
