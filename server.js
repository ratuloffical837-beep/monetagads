require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch').default;

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

app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const firstName = req.tgUser.first_name || "User";
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    
    if(!doc.exists) {
        let rBy = null;
        if(req.startParam && req.startParam !== uid) {
            const rRef = db.collection('users').doc(req.startParam);
            const rDoc = await rRef.get();
            if(rDoc.exists) {
                rBy = req.startParam;
                await rRef.update({ referrals: admin.firestore.FieldValue.increment(1), coins: admin.firestore.FieldValue.increment(5) });
            }
        }
        await ref.set({ 
            coins: 0, referrals: 0, adsToday: 0, adstarToday: 0, 
            totalAdsWatched: 0, referredBy: rBy, uName: firstName, lastAdDate: "" 
        });
    } else {
        // নাম আপডেট করে রাখা যাতে টেলিগ্রামের নাম শনাক্ত হয়
        await ref.update({ uName: firstName });
    }
    res.json({ok: true});
});

app.post('/api/claim-reward', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    try {
        const result = await db.runTransaction(async (t) => {
            const doc = await t.get(ref);
            const d = doc.data();
            const lastT = d.lastAdTime?.toDate().getTime() || 0;
            if(Date.now() - lastT < 300000) return "Wait 5 minutes!";
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

app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    const d = (await ref.get()).data();
    const c = d.lastAdstarDate === today ? (d.adstarToday || 0) : 0;
    if(c >= 10) return res.json({message: "Limit Reached!"});
    await ref.update({ adstarToday: c+1, lastAdstarDate: today, lastAdstarTime: admin.firestore.FieldValue.serverTimestamp() });
    res.json({message: "Adstar View Counted!"});
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const d = (await ref.get()).data();
    
    if(d.coins < 2000 || d.referrals < 5) {
        return res.json({message: "Need 2000 Pts & 5 Referrals!"});
    }
    
    await db.collection('withdrawals').add({ 
        uid, name: d.uName, amount: 2000, status: "PENDING", 
        time: admin.firestore.FieldValue.serverTimestamp() 
    });
    await ref.update({ coins: admin.firestore.FieldValue.increment(-2000) });
    res.json({message: "Withdrawal Sent Successfully!"});
});

app.listen(process.env.PORT || 3000);
