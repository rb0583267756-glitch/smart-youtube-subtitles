// ==UserScript==
// @name         כתוביות חכמות ליוטיוב
// @namespace    smart-youtube-subtitles
// @version      1.1.0
// @description  הפעלה ותרגום אוטומטיים של כתוביות ביוטיוב ובנגנים מוטמעים
// @match        https://*.youtube.com/*
// @match        https://*.youtube-nocookie.com/embed/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/rb0583267756-glitch/smart-youtube-subtitles/main/smart-youtube-subtitles.user.js
// @downloadURL  https://raw.githubusercontent.com/rb0583267756-glitch/smart-youtube-subtitles/main/smart-youtube-subtitles.user.js
// ==/UserScript==

(() => {
'use strict';

/**
 * content.js
 * Core logic for automatically enabling and translating YouTube captions.
 * Optimized for both native YouTube and embedded iframe players.
 */

let isTranslated = false;
let isBotWorking = false;
let currentVideoSrc = "";
let targetLangKeywords = ['עברית', 'hebrew']; // Default fallback
let manualCcOnly = false; // הגדרה להפעלה בלחיצה ידנית בלבד

const utils = {
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    
    // Checks if we are running inside an embedded player (iframe)
    isEmbeddedPlayer: () => {
        return window.location.pathname.startsWith('/embed/') || window.location.hostname.includes('youtube-nocookie');
    }
};

/**
 * יצירת סרגל התקדמות מרובע (מלבני) ומדויק סביב כפתור הכתוביות שרץ בצורה חלקה
 */
function updateProgressUI(ccBtn, percentage) {
    if (!ccBtn) return;
    
    let container = document.getElementById('yt-cc-translation-progress');
    let rect;
    
    if (!container) {
        container = document.createElement('div');
        container.id = 'yt-cc-translation-progress';
        
        // פיצול הלוגיקה: התנהגות שונה ליוטיוב רגיל לעומת מוטמע
        const isEmbedded = utils.isEmbeddedPlayer();
        
        if (isEmbedded) {
            // הגרסה שאהבת באתרים מוטמעים (הוחזרה בדיוק מהקוד ששלחת - 32x22 עם Transform)
            container.style.cssText = `
                position: absolute;
                top: 50%; left: 50%;
                transform: translate(-50%, -50%);
                width: 32px; 
                height: 22px;
                pointer-events: none;
                z-index: 100;
            `;
        } else {
            // הפתרון המוחלט והמדויק ליוטיוב הרגיל (YouTube.com):
            // עוטף את כל הכפתור, ומשתמש ב-Flexbox שמכריח את הנחש למרכז המדויק ללא קשר לרווחים של יוטיוב.
            container.style.cssText = `
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: none;
                z-index: 100;
            `;
        }
        
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        
        if (isEmbedded) {
            svg.setAttribute('width', '100%');
            svg.setAttribute('height', '100%');
            svg.style.position = 'absolute';
            svg.style.top = '0';
            svg.style.left = '0';
        } else {
            // ביוטיוב הרגיל - מגדירים את התיבה במידות המדויקות של האייקון הלבן (CC) בתוך הכפתור
            // וה-Flexbox (מממשק האב למעלה) כבר דואג למרכז את זה בצורה מתמטית מושלמת!
            svg.setAttribute('width', '28px'); 
            svg.setAttribute('height', '20px');
        }
        
        svg.style.overflow = 'visible'; // מונע חיתוך של הקצוות
        
        rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', '0');
        rect.setAttribute('y', '0');
        rect.setAttribute('width', '100%');
        rect.setAttribute('height', '100%');
        rect.setAttribute('rx', isEmbedded ? '5' : '4'); // 5 למוטמע כפי שביקשת, 4 ליוטיוב
        rect.setAttribute('fill', 'none');
        rect.setAttribute('stroke', '#ff0000'); 
        rect.setAttribute('stroke-width', '2.5');
        rect.setAttribute('stroke-linecap', 'round');
        
        // טריק שמגדיר את כל המסלול כאורך 100 לניהול אחוזים מדויק
        rect.setAttribute('pathLength', '100');
        rect.style.strokeDasharray = '100';
        rect.style.strokeDashoffset = '100';
        // אנימציה ארוכה ורציפה לתחושה חלקה
        rect.style.transition = 'stroke-dashoffset 0.6s ease-out';
        
        svg.appendChild(rect);
        container.appendChild(svg);
        
        if (getComputedStyle(ccBtn).position === 'static') {
            ccBtn.style.position = 'relative';
        }
        ccBtn.appendChild(container);
    } else {
        rect = container.querySelector('rect');
    }
    
    if (rect) {
        // קידום חלק של סרגל ההתקדמות (נחש)
        rect.style.strokeDashoffset = Math.max(0, 100 - percentage);
    }
    
    if (percentage >= 100) {
        setTimeout(() => {
            if (container) {
                container.style.transition = 'opacity 0.4s ease';
                container.style.opacity = '0';
                setTimeout(() => container.remove(), 400);
            }
        }, 300);
    }
}

/**
 * Fast search and click functionality for YouTube menus.
 */
async function quickClick(keywords, timeoutMs = 2000) {
    const startTime = Date.now();
    const selectors = '.ytp-menuitem, [role="menuitem"], [role="menuitemradio"], [role="option"], .ytp-menuitem-label, .ytm-menu-item';
    
    while (Date.now() - startTime < timeoutMs) {
        const menuItems = Array.from(document.querySelectorAll(selectors));
        
        for (let item of menuItems) {
            const rect = item.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const text = item.textContent.trim();
                
                if (keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()))) {
                    const target = item.closest('[role="menuitemradio"], [role="menuitem"], .ytp-menuitem, .ytm-menu-item') || item;
                    target.click();
                    return true;
                }
            }
        }
        await utils.sleep(50);
    }
    return false;
}

/**
 * Main automated sequence (Stealth Mode)
 */
async function runFastStealthBot() {
    if (!enabledHere()) return;
    if (isTranslated || isBotWorking) return;
    
    isBotWorking = true;
    let settingsBtn = null;
    let ccBtn = document.querySelector('.ytp-subtitles-button, button[aria-label*="כתוביות"], button[aria-label*="Subtitles" i]');
    
    const setProgress = (val) => {
        if (ccBtn) updateProgressUI(ccBtn, val);
    };
    
    setProgress(5); 

    // --- חסימת תצוגת הכתוביות (למניעת "הבזק" של שפת ברירת המחדל) ---
    let hideCaptionsStyle = document.getElementById('hide-yt-captions-temp');
    if (!hideCaptionsStyle) {
        hideCaptionsStyle = document.createElement('style');
        hideCaptionsStyle.id = 'hide-yt-captions-temp';
        hideCaptionsStyle.innerHTML = `
            .ytp-caption-window-container, 
            .caption-window, 
            ytm-custom-control.player-captions-container {
                opacity: 0 !important;
                visibility: hidden !important;
            }
        `;
        document.head.appendChild(hideCaptionsStyle);
    }
    
    // חיפוש כפתור ההגדרות
    for (let i = 0; i < 20; i++) {
        settingsBtn = document.querySelector('.ytp-settings-button, .ytm-settings-button, .ytp-mobile-settings-button, button[aria-label*="הגדרות"], button[aria-label*="Settings" i], button[title*="הגדרות"], button[title*="Settings" i]');
        if (settingsBtn) break;
        await utils.sleep(200);
        setProgress(5 + i); 
    }
    
    if (!settingsBtn) {
        setProgress(100);
        if (hideCaptionsStyle) hideCaptionsStyle.remove();
        isBotWorking = false;
        return;
    }

    // --- מחיקת התראות מערכת מיותרות ---
    if (!document.getElementById('kill-yt-toasts')) {
        const toastKiller = document.createElement('style');
        toastKiller.id = 'kill-yt-toasts';
        toastKiller.innerHTML = `
            c3-toast, .hug-toast, .inverse-theme, 
            ytm-notification-action-renderer, 
            div.notification-action-response-text, 
            .ytp-toast, .ytp-caption-notification, .ytm-toast, ytm-snackbar, .ytm-snackbar,
            tp-yt-paper-toast { 
                display: none !important; 
                opacity: 0 !important; 
                visibility: hidden !important;
                transform: scale(0) !important;
                pointer-events: none !important;
                height: 0 !important; width: 0 !important;
                position: absolute !important;
                z-index: -1000 !important;
            }
        `;
        document.head.appendChild(toastKiller);
    }

    // --- מצב התגנבות לתפריטים ---
    let stealthStyle = document.getElementById('stealth-mode');
    if (!stealthStyle) {
        stealthStyle = document.createElement('style');
        stealthStyle.id = 'stealth-mode';
        document.head.appendChild(stealthStyle);
    }
    stealthStyle.innerHTML = `
        .ytp-popup, .ytp-settings-menu, .ytm-menu, .ytm-popup, 
        ytm-bottom-sheet, ytm-dialog, .ytp-dialog, 
        [role="dialog"], [role="menu"], .ytp-panel { 
            opacity: 0.001 !important; 
            transition: none !important; 
            box-shadow: none !important; 
            background: transparent !important;
        }
    `;

    try {
        setProgress(25);
        settingsBtn.click();
        await utils.sleep(400);
        setProgress(40);

        const clickedSubtitles = await quickClick(['כתוביות', 'subtitles', 'captions'], 1500);
        
        if (clickedSubtitles) {
            setProgress(60);
            await utils.sleep(300);

            let langSelected = await quickClick(targetLangKeywords, 500);
            setProgress(75);
            
            if (!langSelected) {
                const autoTranslateClicked = await quickClick(['תרגום אוטומטי', 'auto-translate', 'translate'], 1000);
                setProgress(85);
                
                if (autoTranslateClicked) {
                    await utils.sleep(300);
                    langSelected = await quickClick(targetLangKeywords, 2000);
                    setProgress(95);
                }
            }

            if (langSelected) {
                isTranslated = true;
            }
        }
    } catch (error) {
        console.warn("[Auto-Translate] Exception during translation sequence.", error);
    } finally {
        setProgress(100); 
        
        settingsBtn = document.querySelector('.ytp-settings-button, .ytm-settings-button, .ytp-mobile-settings-button');
        if (settingsBtn && settingsBtn.getAttribute('aria-expanded') === 'true') {
            settingsBtn.click();
        }

        ccBtn = document.querySelector('.ytp-subtitles-button, button[aria-label*="כתוביות"], button[aria-label*="Subtitles" i]');
        if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
            ccBtn.click();
        }

        setTimeout(() => {
            if (stealthStyle) stealthStyle.remove();
            // מסיר את חסימת התצוגה - עכשיו הכתוביות המאורגנות יופיעו במכה אחת!
            if (hideCaptionsStyle) hideCaptionsStyle.remove();
            isBotWorking = false;
        }, 1000);
    }
}

/**
 * מאזין ללחיצות על כפתור הכתוביות בצורה אגרסיבית (Capture Phase)
 * כדי לעבוד גם באתרים מוטמעים וגם ביוטיוב
 */
document.addEventListener('click', (e) => {
    const clickedCcBtn = e.target.closest?.('.ytp-subtitles-button, button[aria-label*="כתוביות"], button[aria-label*="Subtitles" i]');
    
    if (clickedCcBtn && enabledHere() && !isBotWorking) {
        setTimeout(() => {
            if (clickedCcBtn.getAttribute('aria-pressed') === 'true') {
                isTranslated = false;
                runFastStealthBot();
            }
        }, 100);
    }
}, true);

const defaults = {
    masterToggle: true,
    embeddedToggle: true,
    youtubeToggle: true,
    targetLanguage: 'he',
    manualCcOnly: false
};
const languages = {
    he: ['עברית', 'hebrew'],
    en: ['אנגלית', 'english', 'anglais'],
    fr: ['צרפתית', 'french', 'français']
};
const settings = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, GM_getValue(key, fallback)])
);

function enabledHere() {
    return settings.masterToggle &&
        (utils.isEmbeddedPlayer() ? settings.embeddedToggle : settings.youtubeToggle);
}

function applySettings() {
    targetLangKeywords = languages[settings.targetLanguage] || languages.he;
    manualCcOnly = settings.manualCcOnly;
}

applySettings();
for (const key of Object.keys(defaults)) {
    GM_addValueChangeListener(key, (_key, _previous, value) => {
        settings[key] = value ?? defaults[key];
        applySettings();
        isTranslated = false;
        const video = document.querySelector('video');
        const captionsOn = document.querySelector('.ytp-subtitles-button[aria-pressed="true"]');
        if (enabledHere() && ((video && !video.paused && !manualCcOnly) ||
            (key === 'targetLanguage' && captionsOn))) {
            runFastStealthBot();
        }
    });
}

for (const [key, label] of Object.entries({
    masterToggle: 'כתוביות חכמות',
    embeddedToggle: 'סרטונים מוטמעים',
    youtubeToggle: 'סרטונים באתר YouTube',
    manualCcOnly: 'תרגום רק בלחיצה על כפתור הכתוביות'
})) {
    GM_registerMenuCommand('הפעל או כבה · ' + label, () => {
        const enabled = !GM_getValue(key, defaults[key]);
        GM_setValue(key, enabled);
        window.alert(label + (enabled ? ' · פעיל' : ' · כבוי'));
    });
}
for (const [code, keywords] of Object.entries(languages)) {
    GM_registerMenuCommand('שפת כתוביות · ' + keywords[0], () => GM_setValue('targetLanguage', code));
}

function onPlaying(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;

    const videoSource = location.href + '|' + video.currentSrc;
    if (videoSource !== currentVideoSrc) {
        isTranslated = false;
        currentVideoSrc = videoSource;
    }
    if (enabledHere() && !isTranslated && !manualCcOnly) {
        setTimeout(() => {
            if (!video.paused && currentVideoSrc === videoSource && !manualCcOnly) {
                runFastStealthBot();
            }
        }, 500);
    }
}

document.addEventListener('playing', onPlaying, true);
const playingVideo = document.querySelector('video:not([paused])');
if (playingVideo && !playingVideo.paused) onPlaying({ target: playingVideo });
})();
