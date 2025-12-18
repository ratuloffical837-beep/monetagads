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
    } catch (e) { console.error("Firebase Auth Error:", e); }
}
const db = admin.firestore();

const verify = (req, res, next) => {
    const data = req.headers['x-telegram-init-data'];
    if(!data) return res.status(403).json({message: "Unauthorized!"});
    const params = new URLSearchParams(data);
    const userStr = params.get('user');
    if(!userStr) return res.status(403).json({message: "Invalid Session!"});
    req.tgUser = JSON.parse(userStr);
    req.startParam = req.headers['x-start-param'] || params.get('start_param') || '';
    next();
};

app.post('/api/sync', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const userRef = db.collection('users').doc(uid);
    const doc = await userRef.get();
    
    if(!doc.exists) {
        await userRef.set({ 
            coins: 0, referrals: 0, totalAdsWatched: 0, 
            adsToday: 0, adstarToday: 0, referredBy: null,
            lastAdDate: "", lastAdstarDate: "", 
            lastAdTime: admin.firestore.FieldValue.serverTimestamp(),
            lastAdstarTime: admin.firestore.FieldValue.serverTimestamp(),
            uName: req.tgUser.first_name || "Guest"
        });

        if (req.startParam && req.startParam !== uid) {
            const referrerRef = db.collection('users').doc(req.startParam);
            const rDoc = await referrerRef.get();
            if (rDoc.exists) {
                await referrerRef.update({ 
                    referrals: admin.firestore.FieldValue.increment(1), 
                    coins: admin.firestore.FieldValue.increment(5) 
                });
                await userRef.update({ referredBy: req.startParam });
            }
        }
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
            
            // Fixed Timestamp Check
            const lastTime = (d.lastAdTime && typeof d.lastAdTime.toDate === 'function') 
                             ? d.lastAdTime.toDate().getTime() : 0;
            
            if (Date.now() - lastTime < 300000) return "Wait 5 minutes!"; 

            const count = d.lastAdDate === today ? (d.adsToday || 0) : 0;
            if(count >= 20) return "20 Ads Daily Limit!";

            t.update(ref, { 
                coins: admin.firestore.FieldValue.increment(2),
                totalAdsWatched: admin.firestore.FieldValue.increment(1),
                adsToday: count + 1, lastAdDate: today, 
                lastAdTime: admin.firestore.FieldValue.serverTimestamp() 
            });
            return "SUCCESS: 2 Coins Earned!";
        });
        res.json({message: result});
    } catch(e) { res.status(500).json({message: "Sync Error!"}); }
});

app.post('/api/claim-adstar', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const today = new Date().toISOString().slice(0, 10);
    const ref = db.collection('users').doc(uid);

    const result = await db.runTransaction(async (t) => {
        const doc = await t.get(ref);
        const d = doc.data();
        
        // Fixed Timestamp Check
        const lastTime = (d.lastAdstarTime && typeof d.lastAdstarTime.toDate === 'function') 
                         ? d.lastAdstarTime.toDate().getTime() : 0;

        if (Date.now() - lastTime < 600000) return "Wait 10 minutes!";

        const count = d.lastAdstarDate === today ? (d.adstarToday || 0) : 0;
        if(count >= 10) return "10 Ads Daily Limit!";

        t.update(ref, { 
            coins: admin.firestore.FieldValue.increment(1),
            adstarToday: count + 1, lastAdstarDate: today, 
            lastAdstarTime: admin.firestore.FieldValue.serverTimestamp() 
        });
        return "SUCCESS: 1 Coin Earned!";
    });
    res.json({message: result});
});

app.post('/api/withdraw', verify, async (req, res) => {
    const uid = String(req.tgUser.id);
    const ref = db.collection('users').doc(uid);
    const doc = await ref.get();
    const d = doc.data();

    if (d.coins < 600 || d.referrals < 3) return res.json({message: "Min: 600 Coins & 3 Ref!"});

    await db.collection('withdrawals').add({
        userId: uid, userName: d.uName, amount: 600, status: "PENDING",
        timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    await ref.update({ coins: admin.firestore.FieldValue.increment(-600) });
    
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const adminId = process.env.ADMIN_CHAT_ID;
    if(botToken && adminId) {
        fetch(`https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${adminId}&text=💰 Request: ${d.uName} (${uid})`);
    }
    res.json({message: "Withdrawal Sent!"});
});

app.listen(process.env.PORT || 3000);
