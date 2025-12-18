require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch').default;
const crypto = require('crypto');

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
    if (!data) return res.status(403).send("No Auth");
    const params = new URLSearchParams(data);
    req.tgUser = JSON.parse(params.get('user'));
    req.startParam = req.headers['x-start-param'] || params.get('start_param') || '';
    next();
};

app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();
    if (!doc.exists) {
        await userRef.set({ coins: 0, referrals: 0, totalAdsWatched: 0, adsToday: 0, adstarToday: 0, cpxPoints: 0, adgemPoints: 0, referredBy: null });
    }

    if (req.startParam && req.startParam !== uid) {
        const referrerRef = db.collection('users').doc(req.startParam);
        const referrerDoc = await referrerRef.get();
        if (referrerDoc.exists) {
            const userData = doc.data() || {};
            if (!userData.referredBy) {
                await referrerRef.update({
                    referrals: admin.firestore.FieldValue.increment(1),
                    coins: admin.firestore.FieldValue.increment(2)
                });
                await userRef.update({ referredBy: req.startParam });
            }
        }
    }
    res.send({ok: true});
});

app.post('/api/claim-reward', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        const d = doc.data();
        const count = d.lastAdDate === today ? (d.adsToday || 0) : 0;
        if (count < 20) {
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
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        const d = doc.data();
        const count = d.lastAdstarDate === today ? (d.adstarToday || 0) : 0;
        if (count < 10) {
            t.update(ref, {
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                adstarToday: count + 1,
                lastAdstarDate: today,
                lastAdstarTime: admin.firestore.FieldValue.serverTimestamp()
            });
        }
    });
    res.send({ok: true});
});

app.get('/api/cpx-postback', async (req, res) => {
    const { ext_user_id, amount_usd, status } = req.query;
    if (status !== '1' || !ext_user_id || !amount_usd) return res.send('OK');
    const earned = Math.round(parseFloat(amount_usd) * 1000);
    const ref = db.collection('users').doc(ext_user_id);
    await ref.update({
        coins: admin.firestore.FieldValue.increment(earned),
        cpxPoints: admin.firestore.FieldValue.increment(earned)
    });
    res.send('OK');
});

app.get('/api/adgem-postback', async (req, res) => {
    let query = req.query;
    const verifier = query.verifier || '';
    delete query.verifier;
    const sortedParams = Object.keys(query).sort().map(k => `\( {k}= \){query[k]}`).join('&');
    const calculated = crypto.createHmac('sha256', "f53db2f6e129kgi32hdnh66g").update(sortedParams).digest('hex');
    if (calculated !== verifier) return res.send('Invalid');
    const { player_id, amount } = query;
    if (!player_id || !amount) return res.send('OK');
    const earned = Math.round(parseFloat(amount));
    const ref = db.collection('users').doc(player_id);
    await ref.update({
        coins: admin.firestore.FieldValue.increment(earned),
        adgemPoints: admin.firestore.FieldValue.increment(earned)
    });
    res.send('OK');
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();
    if ((d.coins || 0) < 600 || (d.referrals || 0) < 3) return res.json({message: "Need 600 Points & 3 Referrals!"});
    await ref.update({ coins: admin.firestore.FieldValue.increment(-600) });
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    await fetch(`https://api.telegram.org/bot\( {botToken}/sendMessage?chat_id= \){uid}&text=Withdraw successful! 600 points deducted.`);
    res.json({message: "Withdraw successful! Check Telegram."});
});

app.listen(process.env.PORT || 3000);
