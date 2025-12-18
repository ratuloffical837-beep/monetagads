require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const verify = (req, res, next) => {
    const data = req.headers['x-telegram-init-data'];
    if(!data) return res.status(403).json({message: "No Auth"});
    const params = new URLSearchParams(data);
    req.tgUser = JSON.parse(params.get('user'));
    req.startParam = req.headers['x-start-param'] || params.get('start_param') || '';
    next();
};

app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    try {
        await db.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            if (!doc.exists) {
                let rBy = null;
                if (req.startParam && req.startParam !== uid) {
                    const rRef = db.collection('users').doc(req.startParam);
                    const rDoc = await t.get(rRef);
                    if (rDoc.exists) {
                        rBy = req.startParam;
                        t.update(rRef, { 
                            referrals: admin.firestore.FieldValue.increment(1), 
                            coins: admin.firestore.FieldValue.increment(10) 
                        });
                    }
                }
                t.set(userRef, { 
                    coins: 0, referrals: 0, adsToday: 0, adstarToday: 0, 
                    totalAdsWatched: 0, referredBy: rBy, uName: req.tgUser.first_name, 
                    lastAdDate: "", lastAdstarDate: "" 
                });
            }
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/claim-reward', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    try {
        const result = await db.runTransaction(async (t) => {
            const d = (await t.get(ref)).data();
            const now = Date.now();
            if(d.lastAdTime && (now - d.lastAdTime.toDate().getTime() < 300000)) return "Wait for Cooldown!";
            const c = d.lastAdDate === today ? (d.adsToday || 0) : 0;
            if(c >= 20) return "Daily Limit Reached!";
            t.update(ref, { 
                coins: admin.firestore.FieldValue.increment(2), 
                adsToday: c + 1, 
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastAdDate: today, 
                lastAdTime: admin.firestore.FieldValue.serverTimestamp() 
            });
            return "Points Added!";
        });
        res.json({message: result});
    } catch(e) { res.status(500).json({message: "Error"}); }
});

app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    try {
        const result = await db.runTransaction(async (t) => {
            const d = (await t.get(ref)).data();
            const now = Date.now();
            if(d.lastAdstarTime && (now - d.lastAdstarTime.toDate().getTime() < 600000)) return "Wait for Adstar Cooldown!";
            const c = d.lastAdstarDate === today ? (d.adstarToday || 0) : 0;
            if(c >= 10) return "Adstar Limit Reached!";
            t.update(ref, { 
                coins: admin.firestore.FieldValue.increment(2), 
                adstarToday: c + 1, 
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastAdstarDate: today, 
                lastAdstarTime: admin.firestore.FieldValue.serverTimestamp() 
            });
            return "Adstar Points Added!";
        });
        res.json({message: result});
    } catch(e) { res.status(500).json({message: "Error"}); }
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const d = (await db.collection('users').doc(uid).get()).data();
    if(d.coins < 2000 || d.referrals < 5) return res.json({message: "Need 2000 Pts & 5 Referrals!"});
    await db.collection('withdrawals').add({ uid, name: d.uName, amount: 2000, status: "PENDING", time: admin.firestore.FieldValue.serverTimestamp() });
    await db.collection('users').doc(uid).update({ coins: admin.firestore.FieldValue.increment(-2000) });
    res.json({message: "Request Sent!"});
});

app.listen(process.env.PORT || 3000);
