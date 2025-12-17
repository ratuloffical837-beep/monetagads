require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString());
    admin.initializeApp({ credential: admin.credential.cert(sa) });
}
const db = admin.firestore();

const verify = (req, res, next) => {
    const data = req.headers['x-telegram-init-data'];
    if(!data) return res.status(403).send("No Auth");
    const params = new URLSearchParams(data);
    req.tgUser = JSON.parse(params.get('user'));
    req.startParam = params.get('start_param');
    next();
};

app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();
    if(!doc.exists){
        await userRef.set({
            userId: uid, coins: 0, referrals: 0, totalAdsWatched: 0,
            adsToday: 0, adstarToday: 0, joinedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        if(req.startParam && req.startParam !== uid){
            await db.collection('users').doc(String(req.startParam)).update({
                referrals: admin.firestore.FieldValue.increment(1),
                coins: admin.firestore.FieldValue.increment(1)
            });
        }
    }
    res.send({ok: true});
});

app.post('/api/claim-reward', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0,10);
    const ref = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
        const d = (await t.get(ref)).data();
        const count = d.lastAdDate === today ? (d.adsToday || 0) : 0;
        if(count < 20) {
            t.update(ref, {
                coins: admin.firestore.FieldValue.increment(1),
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                adsToday: count + 1,
                lastAdDate: today,
                lastAdTime: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    });
    res.send({ok: true});
});

app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0,10);
    const ref = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
        const d = (await t.get(ref)).data();
        const count = d.lastAdstarDate === today ? (d.adstarToday || 0) : 0;
        if(count < 10) {
            t.update(ref, {
                adstarToday: count + 1,
                lastAdstarDate: today,
                lastAdstarTime: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    });
    res.send({ok: true});
});

app.listen(process.env.PORT || 3000);
