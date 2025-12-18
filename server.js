require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
        const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
        admin.initializeApp({ credential: admin.credential.cert(sa) });
    } catch (e) { console.error("Firebase Auth Error"); }
}
const db = admin.firestore();

const verify = (req, res, next) => {
    const data = req.headers['x-telegram-init-data'];
    if(!data) return res.status(403).json({message: "No Auth"});
    const params = new URLSearchParams(data);
    const user = JSON.parse(params.get('user'));
    req.tgUser = user;
    req.startParam = req.headers['x-start-param'] || params.get('start_param') || '';
    next();
};

// 100% Reliable Referral & Sync
app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const firstName = req.tgUser.first_name || "User";
    const userRef = db.collection('users').doc(uid);

    try {
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) {
                let rBy = null;
                const sp = req.startParam;
                if (sp && sp !== uid) {
                    const rRef = db.collection('users').doc(sp);
                    const rDoc = await t.get(rRef);
                    if (rDoc.exists) {
                        rBy = sp;
                        t.update(rRef, { 
                            referrals: admin.firestore.FieldValue.increment(1), 
                            coins: admin.firestore.FieldValue.increment(5) 
                        });
                    }
                }
                t.set(userRef, { 
                    coins: 0, referrals: 0, adsToday: 0, adstarToday: 0, 
                    totalAdsWatched: 0, referredBy: rBy, uName: firstName, lastAdDate: "" 
                });
            } else {
                t.update(userRef, { uName: firstName });
            }
        });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: "Sync failed" }); }
});

// Monetag Cooldown Lockdown
app.post('/api/claim-reward', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    try {
        const result = await db.runTransaction(async (t) => {
            const doc = await t.get(ref);
            const d = doc.data();
            const now = Date.now();
            const lastT = d.lastAdTime?.toDate().getTime() || 0;
            if(now - lastT < 300000) return "Cooldown active!";
            const c = d.lastAdDate === today ? (d.adsToday || 0) : 0;
            if(c >= 20) return "Daily Limit Reached!";
            
            t.update(ref, { 
                coins: admin.firestore.FieldValue.increment(2), 
                totalAdsWatched: admin.firestore.FieldValue.increment(1), 
                adsToday: c + 1, lastAdDate: today, 
                lastAdTime: admin.firestore.FieldValue.serverTimestamp() 
            });
            return "SUCCESS: +2 Points!";
        });
        res.json({message: result});
    } catch(e) { res.status(500).json({message: "Error"}); }
});

// Adstar Cooldown Lockdown
app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    try {
        const result = await db.runTransaction(async (t) => {
            const doc = await t.get(ref);
            const d = doc.data();
            const now = Date.now();
            const lastT = d.lastAdstarTime?.toDate().getTime() || 0;
            if(now - lastT < 600000) return "Adstar Cooldown!";
            const c = d.lastAdstarDate === today ? (d.adstarToday || 0) : 0;
            if(c >= 10) return "Limit Reached!";
            
            t.update(ref, { 
                adstarToday: c + 1, lastAdstarDate: today, 
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                lastAdstarTime: admin.firestore.FieldValue.serverTimestamp() 
            });
            return "Adstar View Counted!";
        });
        res.json({message: result});
    } catch(e) { res.status(500).json({message: "Error"}); }
});

// BitLabs Postback
app.get('/api/postback/bitlabs', async (req, res) => {
    const { uid, val, secret } = req.query;
    if (secret !== "NLwQr5rviklMtWIXw4S56vfuqhYzEDt9") return res.status(403).send("Error");
    const ref = db.collection('users').doc(String(uid));
    await ref.update({ coins: admin.firestore.FieldValue.increment(parseInt(val)) });
    res.send("ok");
});

// Ayet Studios Postback
app.get('/api/postback/ayet', async (req, res) => {
    const { uid, points, secret } = req.query;
    if (secret !== "1c9b3fc7d343c1c607e09586e502c3f0") return res.status(403).send("Error");
    const ref = db.collection('users').doc(String(uid));
    await ref.update({ coins: admin.firestore.FieldValue.increment(parseInt(points)) });
    res.send("ok");
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const d = (await ref.get()).data();
    if(d.coins < 2000 || d.referrals < 5) return res.json({message: "Need 2000 Pts & 5 Referrals!"});
    await db.collection('withdrawals').add({ uid, name: d.uName, amount: 2000, status: "PENDING", time: admin.firestore.FieldValue.serverTimestamp() });
    await ref.update({ coins: admin.firestore.FieldValue.increment(-2000) });
    res.json({message: "Withdrawal Sent!"});
});

app.listen(process.env.PORT || 3000);
