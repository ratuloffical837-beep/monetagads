<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Multi-Network Earning App</title>
    
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js"></script>
    
    <script src='//libtl.com/sdk.js' data-zone='10318378' data-sdk='show_10318378'></script>

    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@500;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">

    <style>
        /* ... (Your CSS Styles remain the same) ... */
        :root {
            --bg: #0b0f19; --glass: rgba(255, 255, 255, 0.05); --neon-blue: #00f0ff;
            --neon-purple: #bc13fe; --neon-orange: #ff8b00; --text-main: #ffffff;
            --input-bg: #1a1a1a; --button-main: #00f0ff; --button-edge: #00aaff;
            --danger-red: #ff3b30; --adsterra: #f3586e; --cpx: #7c4dff; --lootably: #ff9800;
        }
        body, html { margin: 0; padding: 0; background: var(--bg); color: var(--text-main); font-family: 'Rajdhani', sans-serif; }
        .container { padding: 15px; max-width: 600px; margin: 0 auto; }
        
        .btn-adsterra { --button-main: var(--adsterra); --button-edge: #d13d54; } 
        .btn-adgem { --button-main: #3b82f6; --button-edge: #2563eb; } 
        .btn-cpx { --button-main: var(--cpx); --button-edge: #5e35b1; } 
        .btn-lootably { --button-main: var(--lootably); --button-edge: #e65100; } 
        
        .grid-menu { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; width: 100%; max-width: 400px; margin: 20px auto 0; }
        .grid-menu-full { grid-column: span 2; }
        
        /* STYLE FOR LOCKED BUTTONS */
        .btn-locked { 
            --button-main: #333; 
            --button-edge: #1a1a1a; 
            cursor: not-allowed; 
            opacity: 0.6;
            filter: grayscale(100%);
        }
        .btn-locked:active {
            transform: none;
            box-shadow: none;
        }
        /* ... (Rest of the CSS) ... */
    </style>
</head>
<body>
    
    <div class="top-header-bar">
        </div>
    
    <div class="marquee-container">
        </div>

    <div class="orb-stage">
        </div>
    
    <div class="balance-info">
        SECURE POSTBACK POINTS (Verified Tasks): 
        <strong id="validPointsDisplay">0</strong>
    </div>

    <div class="stats-panel">
        </div>

    <div class="grid-menu">
        <button class="btn-3d btn-primary" id="watchAdBtn" onclick="watchAd()">
            <span class="btn-edge"></span><span class="btn-face" id="watchAdFace">WATCH ADS (Monetag)</span>
        </button>
        
        <button class="btn-3d btn-adsterra" onclick="openAdsterraModal()">
            <span class="btn-edge"></span><span class="btn-face">QUICK ADS (Adsterra)</span>
        </button>

        <button class="btn-3d btn-adgem btn-locked" onclick="openLockedFeature('AdGem')">
            <span class="btn-edge"></span><span class="btn-face">HIGH TASKS (AdGem) (LOCKED)</span>
        </button>
        
        <button class="btn-3d btn-cpx btn-locked" onclick="openLockedFeature('CPX Research')">
            <span class="btn-edge"></span><span class="btn-face">SURVEYS (CPX) (LOCKED)</span>
        </button>
        
        <button class="btn-3d btn-lootably btn-locked" onclick="openLockedFeature('Lootably')">
            <span class="btn-edge"></span><span class="btn-face">MORE TASKS (Lootably) (LOCKED)</span>
        </button>

        <button class="btn-3d btn-secondary" onclick="openModal('withdrawModal')">
            <span class="btn-edge"></span><span class="btn-face">WITHDRAW (600/10)</span>
        </button>

        <button class="btn-3d btn-refer grid-menu-full" onclick="openReferralModal()">
            <span class="btn-edge"></span><span class="btn-face">REFER & EARN (+1 PT)</span>
        </button>
    </div>
    
    <button class="btn-3d btn-danger" onclick="Telegram.WebApp.close()" style="margin-top: 15px; width: 100%; max-width: 400px;">
        <span class="btn-edge"></span><span class="btn-face">EXIT APP</span>
    </button>


    <div class="modal-overlay" id="adsterraModal">
        <div class="modal">
            <h2>Quick Ads (Adsterra)</h2>
            <p style="font-size: 14px; color: var(--adsterra); margin-bottom: 20px;">
                Adsterra-এর বিজ্ঞাপন দেখার পর "Claim 1 Point" বাটনে ক্লিক করুন।
            </p>
            
            <button class="btn-3d btn-adsterra" onclick="openExternalAdsterraLink()">
                <span class="btn-edge"></span><span class="btn-face">START ADSTERRA ADS</span>
            </button>
            
            <button class="btn-3d btn-primary" onclick="claimAdsterraReward()" style="margin-top: 15px;">
                <span class="btn-edge"></span><span class="btn-face">CLAIM 1 POINT</span>
            </button>
            
            <button class="btn-3d btn-danger" onclick="closeModal('adsterraModal')" style="margin-top:15px;">
                <span class="btn-edge"></span><span class="btn-face">CLOSE</span>
            </button>
        </div>
    </div>
    
    <div class="toast" id="toast">Notification</div>

    <script>
        // --- CONFIGURATION (NETWORK IDs) ---
        const BACKEND_URL = "https://monetagads4241r.onrender.com"; 
        const TELEGRAM_BOT_USERNAME = "realldoler87ok_bot"; 
        const MONETAG_FUNC = "show_10318378"; 
        const DIRECT_LINK = "https://otieu.com/4/10315373"; 
        
        // ADSTERRA SMARTLINK 
        const ADSTERRA_POP_LINK = "https://smart-link-3065388"; 
        
        // Locked Network Configs (Not Used/Needed for current setup)
        const ADGEM_APP_ID = "31508"; 
        const CPX_APP_ID = "30038"; 
        const LOOTABLY_PLACEMENT_ID = "YOUR_LOOTABLY_PLACEMENT_ID"; 

        const firebaseConfig = {
          // NOTE: Update these with your real Firebase config
          apiKey: "AIzaSyBHgVkLJu7ROlQYcvx7sxDJjEJymZkXEdR", 
          authDomain: "monetas-ads-4241.firebaseapp.com",
          projectId: "monetas-ads-4241",
          storageBucket: "monetas-ads-4241.firebasestorage.app",
          messagingSenderId: "482009819786",
          appId: "1:482009819786:web:8606ae48b666bfd9a1db73"
        };
        
        // ... (rest of the functions remain the same) ...
        
        function openExternalAdsterraLink() {
            if (!ADSTERRA_POP_LINK || ADSTERRA_POP_LINK.includes('YOUR_')) return showToast("Adsterra Link Missing!", true);
            window.open(ADSTERRA_POP_LINK, '_blank'); 
            showToast("Opening Adsterra Popunder...");
        }

        function claimAdsterraReward() {
            // ... (Claim logic remains the same) ...
        }
        
        function openLockedFeature(networkName) {
            showToast(`${networkName} বর্তমানে লক করা আছে। এটি শীঘ্রই চালু করা হবে।`, true, 5000);
        }

        // ... (rest of the functions and initApp() call remain the same) ...
        initApp();
    </script>
</body>
</html>
