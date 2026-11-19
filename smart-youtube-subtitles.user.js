// ==UserScript==
// @name         כתוביות חכמות ליוטיוב
// @namespace    smart-youtube-subtitles
// @version      1.2.0
// @description  כתוביות מותאמות, הקראה ואודיו עברי מתוך נגן YouTube
// @match        https://*.youtube.com/*
// @match        https://*.youtube-nocookie.com/*
// @run-at       document-start
// @sandbox      DOM
// @grant        GM_addElement
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      tts.speech.microsoft.com
// @connect      api.cognitive.microsoft.com
// @updateURL    https://raw.githubusercontent.com/rb0583267756-glitch/smart-youtube-subtitles/main/smart-youtube-subtitles.user.js
// @downloadURL  https://raw.githubusercontent.com/rb0583267756-glitch/smart-youtube-subtitles/main/smart-youtube-subtitles.user.js
// ==/UserScript==
(() => {
'use strict';

const bridgeScript = GM_addElement('script', { textContent: "/* כתוביות חכמות — לוגיקה טהורה (ללא DOM) המשותפת לנגן, לתוכן ולבדיקות */\n(function (root) {\n  const C = {};\n  const safe = fn => { try { return fn(); } catch { return undefined; } };\n  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));\n\n  /* ---------- שפות ---------- */\n  C.normLang = l => String(l || '').trim().replace(/_/g, '-').replace(/^iw(?=$|[-.])/i, 'he').toLowerCase();\n  C.baseLang = l => C.normLang(l).split(/[-.]/)[0];\n  C.sameLang = (a, b) => !!a && !!b && C.baseLang(a) === C.baseLang(b);\n  C.isHebrew = l => C.baseLang(l) === 'he';\n\n  /* ---------- פענוח קובצי timedtext (json3 / srv3 / XML ישן) ---------- */\n  const decode = s => String(s)\n    .replace(/<[^>]+>/g, '')\n    .replace(/&#(\\d+);/g, (_, n) => String.fromCodePoint(+n))\n    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))\n    .replace(/&quot;/g, '\"').replace(/&#39;|&apos;/g, \"'\").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');\n\n  // 3.0.6: דף חסימה של גוגל (\"we can't process your request\") או כל HTML אחר — אינו כתוביות\n  C.isNotCaptions = body => { const t = String(body || '').trim(); return !!t && t[0] === '<' && !/<(timedtext|transcript)\\b/i.test(t.slice(0, 3000)); };\n  C.parseTimedText = function (body) {\n    const text = String(body || '').trim();\n    if (!text || C.isNotCaptions(text)) return [];\n    if (text[0] === '{') {\n      const json = safe(() => JSON.parse(text));\n      if (!json || !Array.isArray(json.events)) return [];\n      return json.events.filter(e => Array.isArray(e.segs)).map(e => ({\n        start: Number(e.tStartMs) || 0,\n        dur: Number(e.dDurationMs) || 0,\n        append: !!e.aAppend,\n        segs: e.segs.map(s => ({ text: String(s.utf8 || ''), off: s.tOffsetMs == null ? null : Number(s.tOffsetMs) || 0 }))\n      }));\n    }\n    const events = [];\n    // srv3: <p t=\"ms\" d=\"ms\"><s t=\"ms\">word</s></p>\n    const pRe = /<p\\b([^>]*)>([\\s\\S]*?)<\\/p>/g; let m;\n    while ((m = pRe.exec(text))) {\n      const attr = m[1], t = +(/\\bt=\"(\\d+)\"/.exec(attr) || [])[1] || 0, d = +(/\\bd=\"(\\d+)\"/.exec(attr) || [])[1] || 0;\n      const segs = []; const sRe = /<s\\b([^>]*)>([\\s\\S]*?)<\\/s>/g; let s;\n      while ((s = sRe.exec(m[2]))) segs.push({ text: decode(s[2]), off: /\\bt=\"(\\d+)\"/.test(s[1]) ? +/\\bt=\"(\\d+)\"/.exec(s[1])[1] : null });\n      if (!segs.length) segs.push({ text: decode(m[2].replace(/<br\\s*\\/?>/g, '\\n')), off: null });\n      events.push({ start: t, dur: d, append: /\\ba=\"1\"/.test(attr), segs });\n    }\n    if (events.length) return events;\n    // פורמט ישן: <text start=\"s\" dur=\"s\">\n    const tRe = /<text\\b([^>]*)>([\\s\\S]*?)<\\/text>/g;\n    while ((m = tRe.exec(text))) {\n      const st = parseFloat((/\\bstart=\"([\\d.]+)\"/.exec(m[1]) || [])[1]) || 0, du = parseFloat((/\\bdur=\"([\\d.]+)\"/.exec(m[1]) || [])[1]) || 0;\n      events.push({ start: Math.round(st * 1000), dur: Math.round(du * 1000), append: false, segs: [{ text: decode(decode(m[2])), off: null }] });\n    }\n    return events;\n  };\n\n  /* ---------- בניית קטעים (cues) ---------- */\n  const clean = s => s.replace(/[​﻿]/g, '').replace(/\\s*\\n+\\s*/g, ' ').replace(/\\s{2,}/g, ' ').trim();\n  C.buildCues = function (events, opts = {}) {\n    const content = events.filter(e => !e.append && clean(e.segs.map(s => s.text).join('')));\n    const asr = !!opts.asr || content.some(e => e.segs.some(s => s.off != null && s.off > 0));\n    const cues = [];\n    content.sort((a, b) => a.start - b.start);\n    for (let i = 0; i < content.length; i++) {\n      const e = content[i], next = content[i + 1];\n      let end = e.start + (e.dur || 4000);\n      if (asr && next && next.start > e.start) end = Math.min(end, next.start);\n      const text = clean(e.segs.map(s => s.text).join(''));\n      if (!text || end <= e.start) continue;\n      let words = null;\n      if (e.segs.some(s => s.off != null)) {\n        words = [];\n        for (const s of e.segs) {\n          const w = clean(s.text); if (!w) continue;\n          words.push({ t: e.start + (s.off || 0), text: w });\n        }\n      }\n      cues.push({ start: e.start, end, text, words, asr });\n    }\n    return cues;\n  };\n\n  /* חלוקת מילים לאורך זמן הקטע — לתצוגה חיה כשאין תזמון מילים (תרגום אוטומטי) */\n  C.interpolateWords = function (cue) {\n    if (cue.words && cue.words.length) return cue.words;\n    const parts = cue.text.split(/\\s+/).filter(Boolean);\n    const total = parts.reduce((n, w) => n + w.length + 1, 0) || 1;\n    const span = Math.min(cue.end - cue.start, Math.max(600, total * 75));\n    let acc = 0;\n    return parts.map(w => { const t = cue.start + span * acc / total; acc += w.length + 1; return { t, text: w }; });\n  };\n\n  /* חיפוש בינארי: האיבר האחרון שהתחיל עד at */\n  C.lastStarted = function (list, at) {\n    let lo = 0, hi = list.length - 1, ans = -1;\n    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].start <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1; }\n    return ans;\n  };\n\n  /* ---------- שבירת שורות דטרמיניסטית ---------- */\n  C.wrap = function (text, maxWidth, measure) {\n    const words = String(text || '').split(/\\s+/).filter(Boolean);\n    const lines = []; let line = '';\n    const pushLong = w => { // מילה ארוכה מרוחב השורה\n      let part = '';\n      for (const ch of w) { if (part && measure(part + ch) > maxWidth) { lines.push(part); part = ch; } else part += ch; }\n      return part;\n    };\n    for (const w of words) {\n      const cand = line ? line + ' ' + w : w;\n      if (measure(cand) <= maxWidth) { line = cand; continue; }\n      if (line) lines.push(line);\n      line = measure(w) > maxWidth ? pushLong(w) : w;\n    }\n    if (line) lines.push(line);\n    return lines;\n  };\n\n  /* ---------- מצב חי: מילה אחרי מילה ---------- */\n  C.liveText = function (cues, at, opts = {}) {\n    const hold = opts.hold ?? 2500, gap = opts.gap ?? 2000;\n    const i = C.lastStarted(cues, at);\n    if (i < 0) return '';\n    const cur = cues[i];\n    if (!cur.asr) { // 3.0.4: גם כתוביות ידניות / מתורגמות — מילה אחרי מילה לאורך הקטע (לא שורה שלמה בבת אחת)\n      const active = [];\n      for (let j = i; j >= 0 && j > i - 6; j--) if (cues[j].start <= at && at < cues[j].end) active.unshift(cues[j]);\n      return active.map(c => C.interpolateWords(c).filter(w => w.t <= at).map(w => w.text).join(' ')).filter(Boolean).join(' ');\n    }\n    if (at > cur.end + hold) return '';\n    let first = i;\n    while (first > 0 && i - first < 8 && cues[first].start - cues[first - 1].end < gap) first--;\n    const out = [];\n    for (let j = first; j <= i; j++) for (const w of C.interpolateWords(cues[j])) if (w.t <= at) out.push(w.text);\n    return out.join(' ');\n  };\n\n  /* ---------- 3.0.4 מעקב מילה אחר מילה: ציר זמן של כל המילים (מילה = אסימון בין רווחים) ---------- */\n  // 3.0.9: זמן לכל מילה בדיוק לפי המילים של טקסט הקטע (אותה ספירה כמו בעמודים) — פסיקים/סימנים שהגיעו\n  // כקטע נפרד כבר לא מזיזים את הספירה, ולכן ההדגשה וההופעה מילה-מילה לא \"בורחות\" לסוף.\n  C.cueTokenTimes = function (c) {\n    const toks = c.text.split(/\\s+/).filter(Boolean);\n    if (!toks.length) return [];\n    const span = Math.max(300, (c.end - c.start) * 0.92);\n    const byChars = () => { const total = toks.reduce((n, w) => n + w.length + 1, 0) || 1; let acc = 0; return toks.map(w => { const t = c.start + span * acc / total; acc += w.length + 1; return t; }); };\n    if (!c.words || !c.words.length) return byChars();\n    // מיקום כל מילה מתוזמנת בתוך הטקסט, ואז לכל אסימון — הזמן של המילה שמתחילה לפניו\n    const marks = []; let pos = 0;\n    for (const w of c.words) { const i = c.text.indexOf(w.text, pos); if (i < 0) continue; marks.push({ i, t: w.t }); pos = i + w.text.length; }\n    if (!marks.length) return byChars();\n    const out = []; let p = 0, m = 0;\n    for (const tok of toks) {\n      const i = c.text.indexOf(tok, p); p = i < 0 ? p : i + tok.length;\n      while (m + 1 < marks.length && marks[m + 1].i <= (i < 0 ? p : i)) m++;\n      out.push(Math.max(c.start, marks[m].t));\n    }\n    for (let k = 1; k < out.length; k++) if (out[k] < out[k - 1]) out[k] = out[k - 1];\n    return out;\n  };\n  C.wordTimeline = function (cues) {\n    const out = [];\n    for (const c of cues) for (const t of C.cueTokenTimes(c)) out.push({ t, end: c.end });\n    for (let k = 0; k < out.length - 1; k++) if (out[k + 1].t > out[k].t) out[k].end = Math.min(out[k].end, out[k + 1].t);\n    return out;\n  };\n\n  /* ---------- 3.0.9: הערות של יוטיוב כמו [מוזיקה] / (מחיאות כפיים) / ♪ — לא מוצגות ולא מוקראות ---------- */\n  const NOISE_RE = /\\[[^\\]]{0,60}\\]|\\([^)]{0,30}\\)|\\*[^*\\n]{1,30}\\*|[♪♫🎵🎶]+/g;\n  // סימני החלפת דובר של יוטיוב (\">>\", \"<<\", \"»\", \"-\") — לא טקסט שנאמר\n  const MARK_RE = /(^|\\s)(?:>{1,3}|<{1,3}|[»«›‹]+|[-–—]{1,2}(?=\\s))\\s*/g;\n  const denoise = t => String(t).replace(NOISE_RE, ' ').replace(MARK_RE, '$1').replace(/\\s{2,}/g, ' ').trim();\n  C.stripNoise = function (cues) {\n    const out = [];\n    for (const c of cues) {\n      const text = denoise(c.text);\n      if (!text || !/[\\p{L}\\p{N}]/u.test(text)) continue;\n      if (text === c.text) { out.push(c); continue; }\n      const words = c.words ? c.words.map(w => ({ ...w, text: denoise(w.text) })).filter(w => w.text && /[\\p{L}\\p{N}]/u.test(w.text)) : null;\n      out.push({ ...c, text, words: words && words.length ? words : null });\n    }\n    return out;\n  };\n\n  /* ---------- מצב שורות שלמות: עמודים יציבים ---------- */\n  const SENTENCE_END = /[.?!…׃:;\"”»)]$/;\n  C.buildPages = function (cues, opts) {\n    const { lines: maxLines, maxWidth, measure, joinAll } = opts;\n    const fits = t => C.wrap(t, maxWidth, measure).length <= maxLines;\n    const groups = [];\n    let g = null;\n    for (const c of cues) {\n      if ((c.asr || joinAll) && g) {\n        const last = g.cues[g.cues.length - 1];\n        const joined = g.text + ' ' + c.text;\n        // joinAll (מצב חי/מעקב): ממלאים עד N שורות גם אחרי סוף משפט, כל עוד אין שתיקה ארוכה\n        if (c.start - last.end < 1200 && (joinAll || !SENTENCE_END.test(g.text)) && fits(joined)) { g.cues.push(c); g.text = joined; g.end = c.end; continue; }\n      }\n      g = { start: c.start, end: c.end, text: c.text, cues: [c] };\n      groups.push(g);\n    }\n    const pages = [];\n    let wi = 0; // אינדקס המילה הראשונה בעמוד בציר הזמן של המילים\n    const count = ls => ls.join(' ').split(/\\s+/).filter(Boolean).length;\n    for (const grp of groups) {\n      const wrapped = C.wrap(grp.text, maxWidth, measure);\n      const groupWords = grp.text.split(/\\s+/).filter(Boolean).length;\n      if (wrapped.length <= maxLines) { pages.push({ start: grp.start, end: grp.end, lines: wrapped, wi }); wi += groupWords; continue; }\n      let gwi = wi; wi += groupWords;\n      // קטע ארוך: מחלקים לעמודים — שום מילה לא נחתכת, הזמן מתחלק לפי אורך הטקסט\n      const total = wrapped.join(' ').length || 1; let acc = 0;\n      for (let k = 0; k < wrapped.length; k += maxLines) {\n        const chunk = wrapped.slice(k, k + maxLines), len = chunk.join(' ').length + 1;\n        const s = grp.start + (grp.end - grp.start) * acc / total; acc += len;\n        pages.push({ start: Math.round(s), end: Math.round(grp.start + (grp.end - grp.start) * Math.min(1, acc / total)), lines: chunk, wi: gwi });\n        gwi += count(chunk);\n      }\n    }\n    pages.sort((a, b) => a.start - b.start);\n    for (let k = 0; k < pages.length - 1; k++) if (pages[k].end > pages[k + 1].start && pages[k].end - pages[k + 1].start < 400) pages[k].end = pages[k + 1].start;\n    return pages;\n  };\n  C.pageAt = function (pages, at) {\n    const i = C.lastStarted(pages, at);\n    return i >= 0 && at < pages[i].end ? pages[i] : null;\n  };\n\n  /* ---------- יחידות הקראה (TTS): משפטים ---------- */\n  C.speechUnits = function (cues) {\n    const units = []; let u = null;\n    for (const c of cues) {\n      if (u && c.start - u.end < 900 && !SENTENCE_END.test(u.text) && u.text.length + c.text.length < 220) { u.text += ' ' + c.text; u.end = c.end; continue; }\n      u = { start: c.start, end: c.end, text: c.text }; units.push(u);\n    }\n    return units;\n  };\n\n  /* ---------- בחירת מסלול כתוביות ---------- */\n  C.chooseCaptionTrack = function (tracks, translationLangs, target, audioLang) {\n    tracks = (tracks || []).filter(Boolean);\n    if (!tracks.length) return { reason: 'none' };\n    const manual = tracks.filter(t => t.kind !== 'asr');\n    const direct = manual.find(t => C.sameLang(t.languageCode, target)) || tracks.find(t => C.sameLang(t.languageCode, target));\n    if (direct) return { track: direct, translate: false };\n    const canTranslate = !translationLangs || !translationLangs.length || translationLangs.some(l => C.sameLang(l.languageCode, target));\n    const translatable = tracks.filter(t => t.isTranslatable !== false && t.is_translateable !== false);\n    const src = translatable.find(t => t.kind !== 'asr' && audioLang && C.sameLang(t.languageCode, audioLang))\n      || translatable.find(t => t.kind === 'asr') || translatable.find(t => t.kind !== 'asr') || null;\n    if (!src || !canTranslate) return { reason: 'no-translation' };\n    return { track: src, translate: true };\n  };\n\n  /* ---------- זיהוי שפת האודיו המקורי ---------- */\n  const ORIGINAL_RE = /original|מקורי|מקור|オリジナル|原始|оригинал|originale|original/i;\n  C.detectAudioLanguage = function ({ formats, captionTracks } = {}) {\n    const seen = new Map();\n    for (const f of formats || []) if (f && f.audioTrack && f.audioTrack.id && !seen.has(f.audioTrack.id)) seen.set(f.audioTrack.id, f.audioTrack);\n    const tracks = [...seen.values()];\n    if (tracks.length) {\n      const named = tracks.find(t => ORIGINAL_RE.test(t.displayName || ''));\n      if (named) return { lang: C.baseLang(named.id), confidence: 'high', source: 'audio-track', multi: tracks.length > 1 };\n      if (tracks.length === 1) return { lang: C.baseLang(tracks[0].id), confidence: 'high', source: 'audio-track', multi: false };\n    }\n    const asr = (captionTracks || []).find(t => t.kind === 'asr');\n    if (asr) return { lang: C.baseLang(asr.languageCode), confidence: 'high', source: 'asr', multi: tracks.length > 1 };\n    if (tracks.length) { const def = tracks.find(t => t.audioIsDefault); if (def) return { lang: C.baseLang(def.id), confidence: 'medium', source: 'default-track', multi: true }; }\n    const manual = (captionTracks || []).filter(t => t.kind !== 'asr');\n    if (manual.length && manual.every(t => C.isHebrew(t.languageCode))) return { lang: 'he', confidence: 'low', source: 'captions-only-hebrew', multi: false };\n    return { lang: '', confidence: 'unknown', source: 'none', multi: tracks.length > 1 };\n  };\n  C.shouldHideForHebrew = (detected, showHebrew) => !showHebrew && C.isHebrew(detected.lang) && (detected.confidence === 'high' || detected.confidence === 'medium');\n\n  /* ---------- אובייקטי ערוץ אודיו של נגן יוטיוב (שמות מאפיינים מוקטנים) ---------- */\n  const ID_RE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*\\.\\d+$/;\n  const strings = obj => { const out = []; if (!obj || typeof obj !== 'object') return out; for (const k of Object.keys(obj)) { const v = safe(() => obj[k]); if (typeof v === 'string') out.push(v); } return out; };\n  C.audioTrackInfo = function (t) {\n    if (!t) return { id: '', lang: '', name: '', original: false };\n    const info = safe(() => t.getLanguageInfo && t.getLanguageInfo()) || t.languageInfo || null;\n    const ids = [t.id, t.audioTrackId, safe(() => t.getId && t.getId()), info && info.id, safe(() => info && info.getId && info.getId()), ...strings(t), ...strings(info)];\n    const id = ids.find(v => typeof v === 'string' && ID_RE.test(v)) || '';\n    const names = [t.displayName, t.name, info && info.name, safe(() => info && info.getName && info.getName()), ...strings(info), ...strings(t)].filter(v => typeof v === 'string' && v && !ID_RE.test(v) && /\\p{L}{2}/u.test(v));\n    const name = names.find(n => ORIGINAL_RE.test(n)) || names[0] || '';\n    const lang = id ? C.baseLang(id) : C.baseLang(t.languageCode || (info && info.languageCode) || '');\n    const original = ORIGINAL_RE.test(name) || t.isOriginal === true || !!(info && info.isOriginal === true);\n    return { id, lang, name, original };\n  };\n  C.pickMixTracks = function (tracks, formatsHint) {\n    const infos = (tracks || []).map(t => ({ t, ...C.audioTrackInfo(t) }));\n    const dub = infos.find(i => C.isHebrew(i.lang));\n    const hint = formatsHint ? C.detectAudioLanguage({ formats: formatsHint }) : null;\n    const original = infos.find(i => i.original && !C.isHebrew(i.lang))\n      || (hint && hint.lang && !C.isHebrew(hint.lang) ? infos.find(i => i.lang === hint.lang) : null)\n      || infos.find(i => !C.isHebrew(i.lang) && i.lang);\n    return { dub: dub || null, original: original || null };\n  };\n\n  // 3.0.3: הערוץ המקורי של הסרטון (גם אם הוא בעברית) — לפי השם \"מקורי/original\", ואם אין — לפי ערוץ ברירת המחדל בנתוני הסרטון. לא מנחשים.\n  C.pickOriginalTrack = function (tracks, formatsHint) {\n    const infos = (tracks || []).map(t => ({ t, ...C.audioTrackInfo(t) }));\n    if (infos.length < 2) return null;\n    const named = infos.find(i => i.original);\n    if (named) return named;\n    const seen = new Map();\n    for (const f of formatsHint || []) if (f && f.audioTrack && f.audioTrack.id && !seen.has(f.audioTrack.id)) seen.set(f.audioTrack.id, f.audioTrack);\n    const fmt = [...seen.values()];\n    const byName = fmt.find(a => ORIGINAL_RE.test(a.displayName || ''));\n    const def = byName || fmt.find(a => a.audioIsDefault);\n    return def ? (infos.find(i => i.id && i.id === def.id) || null) : null;\n  };\n\n  /* ---------- סנכרון נגן המקור ---------- */\n  C.syncDecision = function (drift, masterRate) {\n    const a = Math.abs(drift);\n    if (a > 0.45) return { seek: true, rate: masterRate };\n    if (a > 0.04) return { seek: false, rate: +(masterRate * (1 - clamp(drift * 0.6, -0.08, 0.08))).toFixed(4) };\n    return { seek: false, rate: masterRate };\n  };\n\n  /* ---------- כתובת timedtext ---------- */\n  C.timedTextInfo = function (url) {\n    const u = safe(() => new URL(url, 'https://www.youtube.com'));\n    if (!u || !/\\/api\\/timedtext/.test(u.pathname)) return null;\n    const p = u.searchParams;\n    return { v: p.get('v') || '', lang: p.get('lang') || '', tlang: p.get('tlang') || '', kind: p.get('kind') || '', effective: p.get('tlang') || p.get('lang') || '' };\n  };\n  C.retargetTimedText = function (url, sourceLang, target) {\n    const u = new URL(url, 'https://www.youtube.com');\n    if (C.sameLang(sourceLang || u.searchParams.get('lang'), target)) u.searchParams.delete('tlang'); else u.searchParams.set('tlang', target);\n    u.searchParams.set('fmt', 'json3');\n    return u.toString();\n  };\n\n  root.SmartCaptionsCore = C;\n  if (typeof module === 'object' && module.exports) module.exports = C;\n})(globalThis);\n\n/* כתוביות חכמות — גשר בעולם הדף (MAIN): גישה ל-API הפנימי של נגן יוטיוב,\n   לכידת קובצי הכתוביות שהנגן מוריד, אכיפת שפה וערבוב דיבוב עם קול המקור. */\n(() => {\n  if (window.__smartCaptionsBridge) return;\n  window.__smartCaptionsBridge = true;\n  const C = globalThis.SmartCaptionsCore;\n  const ORIGIN = location.origin;\n  const params = new URL(location.href).searchParams;\n  const COMPANION = params.has('smartcc_companion');\n  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };\n  const getPlayer = () => document.querySelector('#movie_player');\n  const post = (type, data) => window.postMessage({ source: 'smartcc-bridge', type, ...data }, ORIGIN);\n  const origFetch = window.fetch;\n\n  /* ======================= נגן מקור נסתר (companion) ======================= */\n  if (COMPANION) { companion(); return; }\n\n  let cfg = null;\n  let videoId = '';\n  const urls = new Map();       // videoId -> {url, info}\n  const cueCache = new Map();   // videoId|lang -> cues\n  const pending = new Set();\n  let delivered = '';\n  let lastLoadModule = 0, lastEnforce = 0, enforceTries = 0, moduleRequestedAt = 0, baseUrlTried = '';\n  let lastStateKey = '', blockedAt = 0;\n\n  /* ---------- לכידת timedtext ---------- */\n  function onTimedText(url, body) {\n    const info = C.timedTextInfo(url);\n    if (!info) return;\n    const v = info.v || videoId;\n    if (!v) return;\n    urls.set(v, { url, info });\n    if (!cfg) return;\n    if (C.sameLang(info.effective, cfg.language)) {\n      const events = C.parseTimedText(body);\n      if (events.length) store(v, cfg.language, C.buildCues(events, { asr: info.kind === 'asr' }), info);\n    } else fetchTarget(v);\n  }\n  function store(v, lang, cues, info) {\n    if (!cues.length) return;\n    cueCache.set(v + '|' + C.baseLang(lang), { cues, translated: !!(info && info.tlang && !C.sameLang(info.lang, lang)), from: info ? info.lang : '' });\n    if (v === videoId && C.sameLang(lang, cfg.language)) deliver();\n  }\n  function deliver(force) {\n    if (!cfg || !videoId) return;\n    const key = videoId + '|' + C.baseLang(cfg.language);\n    const entry = cueCache.get(key);\n    if (!entry || (!force && delivered === key)) return;\n    delivered = key;\n    post('cues', { videoId, lang: cfg.language, cues: entry.cues, translated: entry.translated, from: entry.from });\n  }\n  async function fetchTarget(v) {\n    if (!cfg) return;\n    const key = v + '|' + C.baseLang(cfg.language);\n    if (cueCache.has(key)) { if (v === videoId) deliver(); return; }\n    const src = urls.get(v);\n    if (!src || pending.has(key)) return;\n    pending.add(key);\n    try {\n      const url = C.retargetTimedText(src.url, src.info.lang, cfg.language);\n      const r = await origFetch.call(window, url, { credentials: 'include' });\n      const body = r.ok ? await r.text() : '';\n      if (!r.ok || C.isNotCaptions(body)) { blockedAt = Date.now(); lastStateKey = ''; }\n      const events = C.parseTimedText(body);\n      if (events.length) store(v, cfg.language, C.buildCues(events, { asr: src.info.kind === 'asr' }), C.timedTextInfo(url));\n    } catch { /* נשאר מצב גיבוי: קריאת הטקסט מהתצוגה של יוטיוב */ }\n    finally { setTimeout(() => pending.delete(key), 4000); }\n  }\n  async function fetchBaseUrl(v, track, translate) {\n    const id = v + '|' + track.baseUrl + '|' + cfg.language;\n    if (baseUrlTried === id) return;\n    baseUrlTried = id;\n    try {\n      const u = new URL(track.baseUrl, ORIGIN);\n      u.searchParams.set('fmt', 'json3');\n      if (translate) u.searchParams.set('tlang', cfg.language);\n      const r = await origFetch.call(window, u.toString(), { credentials: 'include' });\n      const txt = r.ok ? await r.text() : '';\n      if (!r.ok || C.isNotCaptions(txt)) { blockedAt = Date.now(); lastStateKey = ''; }\n      const events = C.parseTimedText(txt);\n      if (events.length) store(v, cfg.language, C.buildCues(events, { asr: track.kind === 'asr' }), C.timedTextInfo(u.toString()));\n    } catch { }\n  }\n\n  window.fetch = function (input, init) {\n    const p = origFetch.apply(this, arguments);\n    try {\n      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;\n      if (url && url.includes('/api/timedtext')) p.then(r => r.clone().text()).then(t => onTimedText(url, t)).catch(() => {});\n    } catch { }\n    return p;\n  };\n  const xOpen = XMLHttpRequest.prototype.open, xSend = XMLHttpRequest.prototype.send;\n  XMLHttpRequest.prototype.open = function (method, url) { try { this.__smartccUrl = String(url); } catch { } return xOpen.apply(this, arguments); };\n  XMLHttpRequest.prototype.send = function () {\n    if (this.__smartccUrl && this.__smartccUrl.includes('/api/timedtext')) {\n      this.addEventListener('load', () => {\n        try {\n          const rt = this.responseType;\n          const body = !rt || rt === 'text' ? this.responseText : rt === 'json' ? JSON.stringify(this.response) : rt === 'arraybuffer' ? new TextDecoder().decode(this.response) : '';\n          onTimedText(this.responseURL || this.__smartccUrl, body);\n        } catch { }\n      });\n    }\n    return xSend.apply(this, arguments);\n  };\n\n  /* ---------- הודעות מסקריפט התוכן ---------- */\n  window.addEventListener('message', e => {\n    if (e.source !== window || e.origin !== ORIGIN || !e.data || e.data.source !== 'smartcc-content') return;\n    if (dead) return;\n    lastPing = Date.now();\n    // 3.0.1: התוסף כובה / הוסר / נטען מחדש — הקוד שכבר רץ בדף נעצר לגמרי ומחזיר את הנגן למצב שלפני\n    if (e.data.type === 'shutdown') { shutdown(); return; }\n    if (e.data.type === 'config') {\n      const prev = cfg; cfg = e.data.cfg;\n      if (!prev || !C.sameLang(prev.language, cfg.language)) { delivered = ''; enforceTries = 0; lastEnforce = 0; if (videoId) { deliver(); fetchTarget(videoId); } }\n      if (prev && (prev.enabled !== cfg.enabled || prev.tts !== cfg.tts)) { lastEnforce = 0; lastLoadModule = 0; }\n      if (prev && prev.dubVolume !== cfg.dubVolume && (mix.state === 'active' || mix.state === 'starting')) safe(() => getPlayer().setVolume(cfg.dubVolume));\n      if (prev && prev.hebrewDub && !cfg.hebrewDub) { stopMix(true); forceOrigUntil = Date.now() + 12000; lastOrigFix = 0; }\n      if (prev && !prev.hebrewDub && cfg.hebrewDub) mix.error = '';\n      lastStateKey = '';\n    }\n    if (e.data.type === 'need-cues') deliver(true);\n  });\n\n  /* ---------- ערבוב אודיו (3.0.1): הסרטון הראשי בדיבוב העברי + נגן מקביל נסתר שמנגן את הקול המקורי חלש מאחורה.\n     רק כשבסרטון יש באמת ערוץ אודיו בעברית. אם הנגן המקביל נכשל — נשארים בעברית (לעולם לא אנגלית לבד). ---------- */\n  let dead = false, lastPing = 0, visibleSince = document.visibilityState === 'visible' ? Date.now() : 0;\n  document.addEventListener('visibilitychange', () => { visibleSince = document.visibilityState === 'visible' ? Date.now() : 0; });\n  function shutdown() {\n    if (dead) return;\n    dead = true;\n    safe(() => stopMix(true));\n    safe(() => clearInterval(loop));\n    window.__smartCaptionsBridge = false;\n  }\n  const mix = { state: 'off', error: '', frame: null, saved: null, original: null, dub: null, startedAt: 0, waitingSince: 0, status: '', video: '', lastFix: 0, detail: '', kind: '' };\n  // 3.0.2: הנגן המקביל נפתח קודם כדף צפייה מלא (שם יוטיוב חושף את ערוצי האודיו), ואם נכשל — כנגן מוטמע.\n  const COMPANION_KINDS = ['watch', 'embed'];\n  function companionUrl(kind, t) {\n    const id = encodeURIComponent(videoId);\n    if (kind === 'watch') return `${ORIGIN}/watch?v=${id}&t=${t}s&smartcc_companion=1`;\n    return `${ORIGIN}/embed/${id}?autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&playsinline=1&rel=0&enablejsapi=1&start=${t}&hl=he&smartcc_companion=1`;\n  }\n  function openCompanion(p, kind) {\n    if (mix.frame) { mix.frame.remove(); mix.frame = null; }\n    const t = Math.floor(safe(() => p.querySelector('video').currentTime, 0));\n    const f = document.createElement('iframe');\n    f.dataset.smartccCompanion = kind;\n    f.title = 'כתוביות חכמות · נגן קול מקורי ברקע';\n    f.allow = 'autoplay; encrypted-media';\n    f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;\n    f.style.cssText = 'position:absolute;left:0;bottom:0;width:240px;height:240px;border:0;opacity:0;pointer-events:none;z-index:-1';\n    f.src = companionUrl(kind, t);\n    p.prepend(f);\n    mix.frame = f; mix.kind = kind; mix.state = 'starting'; mix.startedAt = Date.now(); mix.detail = ''; mix.status = 'מפעיל את הקול המקורי ברקע…';\n  }\n  // כשל בנגן המקביל: קודם מנסים את הסוג הבא, ורק אז מוותרים (הראשי נשאר בעברית)\n  function companionFailed(msg) {\n    const next = COMPANION_KINDS[COMPANION_KINDS.indexOf(mix.kind) + 1];\n    const p = getPlayer();\n    if (next && p) { mix.lastFail = msg; openCompanion(p, next); return; }\n    failMix(msg);\n  }\n  function stopMix(restore) {\n    const p = getPlayer();\n    if (mix.frame) { mix.frame.remove(); mix.frame = null; }\n    if (mix.saved && p) {\n      if (restore && mix.video === videoId && mix.saved.changedTrack) safe(() => p.setAudioTrack(mix.saved.track));\n      safe(() => p.setVolume(mix.saved.volume));\n    }\n    detachVideo();\n    Object.assign(mix, { state: 'off', saved: null, original: null, dub: null, startedAt: 0, waitingSince: 0, status: '', detail: '', kind: '' });\n  }\n  function failMix(msg) { const d = mix.detail; stopMix(false); /* the main player stays on Hebrew */ mix.error = msg + (d ? ' (' + d + ')' : ''); mix.state = 'error'; }\n  let boundVideo = null;\n  const onVideoEvent = () => syncCompanion();\n  const VIDEO_EVENTS = ['play', 'pause', 'seeked', 'seeking', 'ratechange', 'waiting', 'playing', 'volumechange'];\n  function attachVideo(v) { if (boundVideo === v) return; detachVideo(); boundVideo = v; for (const ev of VIDEO_EVENTS) v.addEventListener(ev, onVideoEvent); }\n  function detachVideo() { if (!boundVideo) return; for (const ev of VIDEO_EVENTS) boundVideo.removeEventListener(ev, onVideoEvent); boundVideo = null; }\n  function syncCompanion() {\n    const p = getPlayer(), v = p && p.querySelector('video');\n    if (!mix.frame || !v || !mix.frame.contentWindow || !cfg) return;\n    const ad = p.classList.contains('ad-showing');\n    const muted = safe(() => p.isMuted(), false) || v.muted;\n    mix.frame.contentWindow.postMessage({\n      source: 'smartcc-master', type: 'sync', t: v.currentTime, paused: v.paused || ad || v.readyState < 3,\n      rate: v.playbackRate, volume: muted ? 0 : Math.max(0, Math.min(1, cfg.originalVolume / 100)),\n      track: mix.original.id, trackLang: mix.original.lang, videoId\n    }, ORIGIN);\n  }\n  // 3.0.3: כשהדיבוב כבוי (או שאין דיבוב עברי) — יוטיוב לא יחליף לבד לדיבוב אוטומטי (למשל אנגלית):\n  // בתחילת כל סרטון מחזירים לערוץ המקורי. אחרי 30 שניות לא נוגעים — אם המשתמש בחר ערוץ בעצמו, זו בחירתו.\n  let videoStartAt = 0, lastOrigFix = 0, forceOrigUntil = 0;\n  const audioLog = [];\n  function keepOriginal(p, response) {\n    // 3.0.10: אחרי כיבוי הדיבוב מחזירים לערוץ המקורי של הסרטון בכל שלב (לא רק ב-30 השניות הראשונות)\n    if (!(forceOrigUntil > Date.now()) && (!videoStartAt || Date.now() - videoStartAt > 30000)) return;\n    if (Date.now() - lastOrigFix < 1500) return;\n    if (p.classList.contains('ad-showing') || typeof p.setAudioTrack !== 'function') return;\n    const tracks = safe(() => Array.from(p.getAvailableAudioTracks() || []), []);\n    const orig = C.pickOriginalTrack(tracks, safe(() => response.streamingData.adaptiveFormats, []));\n    if (!orig) return;\n    const cur = C.audioTrackInfo(safe(() => p.getAudioTrack()));\n    if (!cur.id || cur.id === orig.id) return;\n    lastOrigFix = Date.now();\n    audioLog.push(new Date().toISOString().slice(11, 19) + ' ' + cur.id + ' → ' + orig.id + ' (מקורי)'); if (audioLog.length > 10) audioLog.shift();\n    safe(() => p.setAudioTrack(orig.t));\n  }\n  function tickMix(p, response) {\n    if (!cfg || !cfg.hebrewDub) { if (mix.state !== 'off' && mix.state !== 'error') stopMix(true); mix.error = ''; keepOriginal(p, response); return; }\n    if (mix.state === 'error') { // דיבוב מופעל: אם יש ערוץ עברי — הראשי נשאר בעברית; רק בלי ערוץ עברי שומרים על המקורי\n      const hasHe = C.pickMixTracks(safe(() => Array.from(p.getAvailableAudioTracks() || []), []), null).dub;\n      if (!hasHe) keepOriginal(p, response);\n      return;\n    }\n    if (mix.state === 'off') {\n      const tracks = safe(() => Array.from(p.getAvailableAudioTracks() || []), []);\n      const formats = safe(() => response.streamingData.adaptiveFormats, []);\n      const pick = C.pickMixTracks(tracks, formats);\n      if (!pick.dub || !pick.original) {\n        if (!mix.waitingSince) mix.waitingSince = Date.now();\n        mix.status = 'בודק ערוצי אודיו…';\n        if (Date.now() - mix.waitingSince > 8000) {\n          mix.error = !pick.dub ? 'בסרטון הזה אין ערוץ דיבוב בעברית. אפשר להפעיל \"הקראת הכתוביות בקול\" במקום.' : 'לא נמצא ערוץ אודיו מקורי נפרד בסרטון הזה.';\n          mix.state = 'error';\n        }\n        return;\n      }\n      if (p.classList.contains('ad-showing')) { mix.status = 'ממתין לסיום הפרסומת…'; return; }\n      const cur = C.audioTrackInfo(safe(() => p.getAudioTrack()));\n      mix.saved = { track: safe(() => p.getAudioTrack()), volume: safe(() => p.getVolume(), 100), changedTrack: false };\n      mix.dub = pick.dub; mix.original = pick.original; mix.video = videoId;\n      // הסרטון הראשי: הדיבוב בעברית, בעוצמת הדיבוב. הקול המקורי — בנגן המקביל, חלש מאחורה\n      if (cur.id !== pick.dub.id && typeof p.setAudioTrack === 'function') { safe(() => p.setAudioTrack(pick.dub.t)); mix.saved.changedTrack = true; }\n      safe(() => p.setVolume(cfg.dubVolume));\n      openCompanion(p, COMPANION_KINDS[0]);\n      attachVideo(p.querySelector('video'));\n      return;\n    }\n    const v = p.querySelector('video'); if (v) attachVideo(v);\n    if (mix.state === 'starting' && Date.now() - mix.startedAt > 20000) { companionFailed('הקול המקורי ברקע לא התחיל לנגן — נשאר הדיבוב בעברית בלבד.'); return; }\n    if (Date.now() - mix.lastFix > 3000) {\n      mix.lastFix = Date.now();\n      const cur = C.audioTrackInfo(safe(() => p.getAudioTrack()));\n      if (cur.id && !C.isHebrew(cur.lang)) safe(() => p.setAudioTrack(mix.dub.t)); // הראשי נשאר בעברית\n    }\n    syncCompanion();\n  }\n  window.addEventListener('message', e => {\n    if (!mix.frame || e.source !== mix.frame.contentWindow || e.origin !== ORIGIN || !e.data || e.data.source !== 'smartcc-companion') return;\n    if (e.data.type === 'ready' && mix.state === 'starting') { mix.state = 'active'; mix.status = ''; }\n    if (e.data.type === 'status') { mix.detail = e.data.text || ''; if (mix.state === 'starting') mix.status = 'מפעיל את הקול המקורי ברקע… ' + mix.detail; }\n    if (e.data.type === 'error' && mix.state === 'starting') companionFailed(e.data.text || 'נגן הקול המקורי נכשל.');\n    else if (e.data.type === 'error') failMix(e.data.text || 'נגן הקול המקורי נכשל.');\n  });\n\n  /* ---------- לולאת הנגן הראשית ---------- */\n  function tick() {\n    const p = getPlayer();\n    if (!p || !cfg || typeof p.getVideoData !== 'function') return;\n    const data = safe(() => p.getVideoData(), {}) || {};\n    const id = data.video_id || '';\n    if (!id) return;\n    if (id !== videoId) {\n      if (mix.state !== 'off') stopMix(false);\n      mix.error = '';\n      videoId = id; videoStartAt = Date.now(); lastOrigFix = 0; delivered = ''; enforceTries = 0; lastEnforce = 0; lastLoadModule = 0; moduleRequestedAt = 0;\n      post('video', { videoId: id });\n      deliver(); fetchTarget(id);\n    }\n    const response = safe(() => p.getPlayerResponse(), {}) || {};\n    const renderer = safe(() => response.captions.playerCaptionsTracklistRenderer, null);\n    const captionTracks = (renderer && renderer.captionTracks) || [];\n    const audio = C.detectAudioLanguage({ formats: safe(() => response.streamingData.adaptiveFormats, []), captionTracks });\n    const hideHebrew = C.shouldHideForHebrew(audio, cfg.showHebrew);\n    // 3.0.6: גם כשהכתוביות מוסתרות והדיבוב הקולי פועל — טוענים את הכתוביות (מוסתרות) כדי להקריא אותן\n    const want = (cfg.enabled || cfg.tts) && !hideHebrew;\n    const choice = C.chooseCaptionTrack(captionTracks, renderer && renderer.translationLanguages, cfg.language, audio.lang);\n    let ytLang = '';\n    let status;\n\n    if (!captionTracks.length) status = renderer ? 'לסרטון הזה אין כתוביות זמינות' : 'לסרטון הזה אין כתוביות זמינות';\n    else if (!choice.track) status = 'אין לסרטון הזה תרגום אוטומטי לשפה שנבחרה';\n    if (want && choice.track) {\n      let list = safe(() => p.getOption('captions', 'tracklist'), []) || [];\n      if (!list.length) list = safe(() => p.getOption('captions', 'tracklist', { includeAsr: true }), []) || [];\n      const curTrack = safe(() => p.getOption('captions', 'track'), null);\n      const moduleOn = list.length || (curTrack && curTrack.languageCode) || p.querySelector('.ytp-caption-segment');\n      // בנגן החדש הרשימה לפעמים ריקה גם כשהכתוביות פועלות — בונים אותה מנתוני הסרטון\n      if (!list.length && moduleOn) list = captionTracks.map(t => ({ languageCode: t.languageCode, kind: t.kind || '', vss_id: t.vssId, name: t.name && (t.name.simpleText || t.name.runs && t.name.runs.map(r => r.text).join('')), languageName: t.name && t.name.simpleText, is_translateable: t.isTranslatable }));\n      if (!list.length) {\n        if (Date.now() - lastLoadModule > 3000) { lastLoadModule = Date.now(); if (!moduleRequestedAt) moduleRequestedAt = Date.now(); safe(() => p.loadModule('captions')); }\n        status = 'טוען כתוביות…';\n      } else {\n        const cur = safe(() => p.getOption('captions', 'track'), {}) || {};\n        ytLang = (cur.translationLanguage && cur.translationLanguage.languageCode) || cur.languageCode || '';\n        if (!C.sameLang(ytLang, cfg.language) && Date.now() - lastEnforce > 1200 && enforceTries < 12) {\n          lastEnforce = Date.now(); enforceTries++;\n          const src = choice.track;\n          const m = list.find(t => t.languageCode === src.languageCode && (t.kind || '') === (src.kind || '')) || list.find(t => t.languageCode === src.languageCode) || list[0];\n          const langName = ((renderer.translationLanguages || []).find(l => C.sameLang(l.languageCode, cfg.language)) || {}).languageName;\n          const next = choice.translate ? { ...m, translationLanguage: { languageCode: cfg.language, languageName: (langName && langName.simpleText) || cfg.language } } : m;\n          safe(() => p.setOption('captions', 'track', next));\n        }\n        if (C.sameLang(ytLang, cfg.language)) enforceTries = 0;\n      }\n      if (!cueCache.has(videoId + '|' + C.baseLang(cfg.language)) && moduleRequestedAt && Date.now() - moduleRequestedAt > 1800 && !urls.has(videoId) && choice.track.baseUrl) fetchBaseUrl(videoId, choice.track, choice.translate);\n      if (!status) status = choice.translate ? 'תרגום אוטומטי של יוטיוב' : 'כתוביות מקוריות בשפה שנבחרה';\n    }\n    if (blockedAt && !cueCache.has(videoId + '|' + C.baseLang(cfg.language))) status = 'יוטיוב חסם לרגע את הורדת התרגום (יותר מדי בקשות מהרשת) — מוצגות הכתוביות שהנגן עצמו מציג';\n    if (!cfg.enabled) status = 'הכתוביות כבויות';\n    else if (hideHebrew) status = 'אודיו המקור בעברית · הכתוביות מוסתרות';\n\n    safe(() => tickMix(p, response));\n\n    const tracks = safe(() => Array.from(p.getAvailableAudioTracks() || []), []);\n    const pick = C.pickMixTracks(tracks, safe(() => response.streamingData.adaptiveFormats, []));\n    const state = {\n      videoId, status, want, hideHebrew, hasCaptions: captionTracks.length > 0, canTranslate: !!choice.track,\n      audioLang: audio.lang, audioConfidence: audio.confidence, ytLang,\n      sourceLang: choice.track ? choice.track.languageCode : '', translate: !!choice.translate,\n      audio: { cur: C.audioTrackInfo(safe(() => p.getAudioTrack())).id, tracks: tracks.map(t => { const i = C.audioTrackInfo(t); return i.id + (i.original ? '*' : '') + ' ' + i.name; }), log: audioLog.slice() },\n      haveCues: cueCache.has(videoId + '|' + C.baseLang(cfg.language)),\n      cueCount: (cueCache.get(videoId + '|' + C.baseLang(cfg.language)) || { cues: [] }).cues.length,\n      delivered,\n      mix: { state: mix.state, error: mix.error, status: mix.status, hasDub: !!pick.dub, hasOriginal: !!pick.original }\n    };\n    const key = JSON.stringify(state);\n    if (key !== lastStateKey) { lastStateKey = key; post('state', { state }); }\n  }\n  let lastErr = '';\n  const loop = setInterval(() => { if (dead) return; if (cfg && visibleSince && Date.now() - visibleSince > 6000 && Date.now() - lastPing > 6000) { shutdown(); return; } try { tick(); } catch (e) { const m = String(e && e.stack || e).slice(0, 400); if (m !== lastErr) { lastErr = m; post('error', { where: 'bridge', msg: m }); } } }, 250);\n  window.addEventListener('pagehide', () => { if (!dead) stopMix(true); });\n\n  /* ======================= צד נגן המקור ======================= */\n  function companion() {\n    const parentWin = window.parent;\n    const send = (type, data) => parentWin.postMessage({ source: 'smartcc-companion', type, ...data }, ORIGIN);\n    // 3.0.2: שקט מוחלט עד שהערוץ המקורי נבחר — שלא יישמע לרגע דיבוב/שפה אחרת מהנגן הנסתר\n    let trackOk = false;\n    const hush = setInterval(() => { const v = document.querySelector('#movie_player video'); if (v && !trackOk) v.muted = true; }, 100);\n    let readySent = false, lastSeek = 0, lastTrackSet = 0, playRequestedAt = 0, prepared = false, firstSync = 0, lastSyncAt = 0;\n    // דיווח מצב מפורט לנגן הראשי — כדי שתמיד יהיה ברור למה הדיבוב לא מתחיל\n    setInterval(() => {\n      const p = getPlayer(), v = p && p.querySelector('video');\n      const tracks = safe(() => Array.from(p.getAvailableAudioTracks() || []), []);\n      const info = [!p ? 'אין נגן' : 'נגן', !v ? 'אין וידאו' : (v.paused ? 'מושהה' : 'מנגן'), 'מצב ' + safe(() => p.getPlayerState(), '?'), 'ערוצים ' + tracks.length, 'נוכחי ' + (C.audioTrackInfo(safe(() => p.getAudioTrack())).id || '-'), lastSyncAt ? 'מסונכרן' : 'ללא סנכרון'].join(' · ');\n      send('status', { text: info });\n    }, 1500);\n    window.addEventListener('message', e => {\n      if (e.source !== parentWin || e.origin !== ORIGIN || !e.data || e.data.source !== 'smartcc-master' || e.data.type !== 'sync') return;\n      const d = e.data, p = getPlayer(), v = p && p.querySelector('video');\n      lastSyncAt = Date.now(); if (!firstSync) firstSync = Date.now();\n      if (!p || !v || typeof p.getVideoData !== 'function') return;\n      if (!prepared) {\n        prepared = true;\n        safe(() => p.unloadModule('captions'));\n        safe(() => p.setPlaybackQualityRange('tiny', 'tiny'));\n        safe(() => p.setPlaybackQuality('tiny'));\n        safe(() => p.addEventListener('onError', code => send('error', { text: (code === 101 || code === 150) ? 'בעל הסרטון חסם ניגון בהטמעה, לכן אי אפשר לנגן את הקול המקורי במקביל.' : 'נגן הקול המקורי נכשל (קוד שגיאה ' + code + ').' })));\n      }\n      const ad = p.classList.contains('ad-showing');\n      // ערוץ המקור\n      const tracks = safe(() => Array.from(p.getAvailableAudioTracks() || []), []);\n      const want = tracks.map(t => ({ t, ...C.audioTrackInfo(t) })).find(i => i.id === d.track) || tracks.map(t => ({ t, ...C.audioTrackInfo(t) })).find(i => i.lang === d.trackLang);\n      const cur = C.audioTrackInfo(safe(() => p.getAudioTrack()));\n      if (want && cur.id !== want.id && Date.now() - lastTrackSet > 2000) { lastTrackSet = Date.now(); safe(() => p.setAudioTrack(want.t)); }\n      trackOk = !!(want && cur.id === want.id && !C.isHebrew(cur.lang));\n      if (!trackOk) { v.muted = true; }\n      else clearInterval(hush);\n      if (tracks.length && !want && Date.now() - firstSync > 8000) { send('error', { text: 'בנגן המקביל לא נמצא הערוץ המקורי.' }); return; }\n      if (!tracks.length && !v.paused && Date.now() - firstSync > 12000) { send('error', { text: 'הנגן המקביל לא חושף את ערוצי האודיו, ולכן אי אפשר לבחור בו את הקול המקורי.' }); return; }\n      // עוצמה — ישירות על רכיב הווידאו כדי לא לשנות את העוצמה השמורה של המשתמש ביוטיוב\n      if (ad) { v.muted = true; send('status', { text: 'פרסומת בנגן הדיבוב…' }); return; }\n      if (d.volume > 0 && safe(() => p.isMuted(), false)) safe(() => p.unMute());\n      v.muted = !trackOk || d.volume <= 0;\n      if (Math.abs(v.volume - d.volume) > 0.01) v.volume = d.volume;\n      // זמן, השהיה ומהירות\n      const drift = v.currentTime - d.t;\n      if (d.paused) {\n        if (!v.paused) safe(() => p.pauseVideo());\n        if (Math.abs(drift) > 0.25 && Date.now() - lastSeek > 600) { lastSeek = Date.now(); safe(() => p.seekTo(d.t, true)); }\n        v.playbackRate = d.rate;\n      } else {\n        if (v.paused) {\n          safe(() => p.playVideo());\n          if (!playRequestedAt) playRequestedAt = Date.now();\n          if (Date.now() - playRequestedAt > 6000) { send('error', { text: 'הדפדפן חסם ניגון אוטומטי של הקול המקורי. לחצו על הסרטון ואז הפעילו שוב את השילוב.' }); playRequestedAt = Date.now(); }\n        } else playRequestedAt = 0;\n        const dec = C.syncDecision(drift, d.rate);\n        if (dec.seek) { if (Date.now() - lastSeek > 1500) { lastSeek = Date.now(); safe(() => p.seekTo(d.t + 0.2 * d.rate, true)); } }\n        else if (Math.abs(v.playbackRate - dec.rate) > 0.001) v.playbackRate = dec.rate;\n      }\n      if (!readySent && trackOk && !v.paused && Math.abs(drift) < 1) { readySent = true; send('ready', {}); }\n    });\n  }\n})();\n" });
bridgeScript.remove();


const storageKeys = ['settings', 'videoOv', "fontsAvail"];
const local = {
  async get(key) { return { [key]: GM_getValue(key) }; },
  async set(values) {
    for (const [key, value] of Object.entries(values)) GM_setValue(key, value);
  }
};
const chrome = {
  storage: {
    local,
    onChanged: {
      addListener(listener) {
        for (const key of storageKeys) {
          GM_addValueChangeListener(key, (_key, oldValue, newValue) => {
            listener({ [key]: { oldValue, newValue } }, 'local');
          });
        }
      }
    }
  },
  runtime: { id: 'smartcc-userscript', sendMessage }
};

function azureRequest(url, options) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: options.method,
      url,
      headers: options.headers,
      data: options.body,
      responseType: 'arraybuffer',
      anonymous: true,
      redirect: 'error',
      timeout: 15000,
      onload: result => resolve({
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        arrayBuffer: async () => result.response
      }),
      onerror: () => reject(new Error('החיבור ל־Azure Speech נכשל')),
      ontimeout: () => reject(new Error('החיבור ל־Azure Speech לא הגיב'))
    });
  });
}

async function sendMessage(message) {
  if (message.type === 'smartcc-tts') {
    try { return await synth(message.text, message.voice); }
    catch (error) { return { ok: false, msg: error.message }; }
  }
  if (message.type === 'smartcc-tts-warm') return warm();
  if (message.type === 'smartcc-open-help') {
    window.open('https://learn.microsoft.com/azure/ai-services/speech-service/get-started-text-to-speech', '_blank', 'noopener,noreferrer');
  }
}

if (window === window.top) {
  GM_registerMenuCommand('הגדרת מפתח Azure Speech', () => {
    const value = window.prompt('הדביקו מפתח Azure Speech. שדה ריק מוחק את המפתח.');
    if (value !== null) {
      local.set({ settings: { ...CaptionSettings.normalize(GM_getValue('settings')), azureKey: value.trim() } });
    }
  });
}

let lastWarm = 0;
async function warm() {
  if (Date.now() - lastWarm < 120000) return;
  lastWarm = Date.now();
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (!String(settings.azureKey || '').trim()) return;
    const region = String(settings.azureRegion || 'northeurope').replace(/[^a-z0-9]/g, '');
    await azureRequest(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'OPTIONS' }).catch(() => { });
  } catch { }
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// 3.0.8: אם האזור שנבחר לא מתאים למפתח — מחפשים לבד את האזור הנכון ושומרים אותו
const REGIONS = ['northeurope', 'westeurope', 'eastus', 'westus2', 'uksouth', 'francecentral', 'germanywestcentral', 'israelcentral', 'swedencentral', 'centralindia', 'southeastasia', 'eastus2', 'westus', 'centralus', 'japaneast', 'australiaeast', 'canadacentral', 'switzerlandnorth', 'norwayeast', 'koreacentral', 'brazilsouth', 'southafricanorth', 'uaenorth', 'qatarcentral', 'italynorth', 'polandcentral', 'spaincentral'];
let regionSearch = null;
async function findRegion(key) {
  for (const r of REGIONS) {
    try {
      const res = await azureRequest(`https://${r}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key } });
      if (res.ok) return r;
    } catch { }
  }
  return '';
}
async function synth(text, voiceOverride) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const key = String(settings.azureKey || '').trim();
  let region = String(settings.azureRegion || 'northeurope').replace(/[^a-z0-9]/g, '');
  const voice = /^he-IL-\w+Neural$/.test(voiceOverride || '') ? voiceOverride : (settings.azureVoice || 'he-IL-AvriNeural');
  if (!key) return { ok: false, status: 0, msg: 'אין מפתח' };
  const call = reg => azureRequest(`https://${reg}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'smart-captions' },
    body: `<speak version='1.0' xml:lang='he-IL'><voice name='${voice}'>${esc(text)}</voice></speak>`
  });
  let r = await call(region);
  if (r.status === 401 || r.status === 418) {
    if (!regionSearch) regionSearch = findRegion(key).finally(() => setTimeout(() => { regionSearch = null; }, 30000));
    const found = await regionSearch;
    if (found && found !== region) {
      region = found;
      const cur = (await chrome.storage.local.get('settings')).settings || {};
      await chrome.storage.local.set({ settings: { ...cur, azureRegion: found } });
      r = await call(region);
    }
  }
  if (r.status === 418) return { ok: false, status: 418, msg: 'נטפרי חוסם את השרת של האזור הזה' };
  if (!r.ok) return { ok: false, status: r.status, msg: r.status === 401 ? 'המפתח לא נכון (או שהשירות עוד מופעל — נסו שוב בעוד דקה)' : r.status === 429 ? 'עברתם את המכסה החינמית לרגע — ממתינים' : 'שגיאה ' + r.status };
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { ok: true, b64: btoa(bin), region };
}

/* כתוביות חכמות — סכימת הגדרות משותפת (פופאפ, תפריט בתוך הנגן ובדיקות) */
(function (root) {
  const LANGS = [
    ['he', 'עברית'], ['en', 'English'], ['ar', 'العربية'], ['ru', 'Русский'], ['fr', 'Français'],
    ['es', 'Español'], ['de', 'Deutsch'], ['yi', 'ייִדיש'], ['am', 'አማርኛ'], ['uk', 'Українська'],
    ['it', 'Italiano'], ['pt', 'Português'], ['tr', 'Türkçe'], ['zh-Hans', '中文 (简体)'], ['ja', '日本語']
  ];
  // גופנים שמותקנים ב-Windows (כולל גופני העברית). גופן שלא מותקן במחשב מוסתר מהרשימה בנגן.
  const FONTS = ['Arial', 'Segoe UI', 'Tahoma', 'Calibri', 'Gisha', 'Levenim MT', 'Aharoni', 'David', 'FrankRuehl', 'Narkisim', 'Miriam', 'Rod', 'Guttman Yad', 'Assistant', 'Heebo', 'Rubik', 'Verdana', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Comic Sans MS', 'Impact'];

  // key, label, type, options/[min,max,step], hint, format
  const SECTIONS = [
    { id: 'watch', title: 'צפייה ושפה', icon: 'language', fields: [
      { key: 'enabled', label: 'כתוביות חכמות', type: 'toggle', hint: 'גם כפתור CC והמקש C בנגן מפעילים ומכבים' },
      { key: 'language', label: 'שפת כתוביות', type: 'select', options: LANGS, hint: 'אם אין כתוביות בשפה זו — תרגום אוטומטי של יוטיוב' },
      { key: 'showHebrew', label: 'הצג כתוביות גם בסרטונים בעברית', type: 'toggle', hint: 'כבוי: כשאודיו המקור מזוהה כעברית, הכתוביות מוסתרות' },
      { key: 'mode', label: 'אופן הצגה', type: 'select', options: [['live', 'מילה אחרי מילה — המילים מופיעות כשהן נאמרות'], ['follow', 'שורות מלאות מראש + הדגשת המילה שנאמרת'], ['lines', 'שורות מלאות בלי הדגשה']], hint: 'במילה אחרי מילה: המילים מתווספות לשורה, יורדות לשורה השנייה, ואז מתחיל עמוד חדש' },
      { key: 'highlightStyle', label: 'הדגשת המילה שנאמרת עכשיו', type: 'select', options: [['pill', 'רקע מעוגל מאחורי המילה'], ['text', 'צבע המילה'], ['underline', 'קו מתחת למילה'], ['none', 'בלי הדגשה']] },
      { key: 'wordColor', label: 'צבע ההדגשה', type: 'color', swatches: ['#1e88e5', '#8e24aa', '#e53935', '#43a047', '#fb8c00', '#ffd54f'] },
      { key: 'skipNoise', label: 'דילוג על הערות כמו [מוזיקה] וסוגריים', type: 'toggle', hint: 'לא מציג ולא מקריא הערות של יוטיוב בסוגריים ותווי מוזיקה ♪' },
      { key: 'lines', label: 'מספר שורות', type: 'select', options: [[1, 'שורה אחת'], [2, 'שתי שורות'], [3, 'שלוש שורות'], [4, 'ארבע שורות']] },
      { key: 'offset', label: 'תיקון תזמון', type: 'range', range: [-5, 5, 0.1], unit: ' ש׳', hint: 'חיובי = הכתוביות מופיעות מאוחר יותר' }
    ]},
    { id: 'text', title: 'טקסט', icon: 'text', fields: [
      { key: 'font', label: 'גופן', type: 'select', options: FONTS.map(f => [f, f]) },
      { key: 'size', label: 'גודל', type: 'range', range: [16, 80, 1], hint: 'מותאם אוטומטית לגודל הנגן ולמסך מלא' },
      { key: 'color', label: 'צבע טקסט', type: 'color', swatches: ['#ffffff', '#fff59d', '#ffe082', '#b3e5fc', '#c8e6c9', '#000000'] },
      { key: 'bold', label: 'הדגשה', type: 'toggle' },
      { key: 'outline', label: 'עובי מסגרת', type: 'range', range: [0, 6, 0.5], unit: 'px' },
      { key: 'outlineColor', label: 'צבע מסגרת', type: 'color', swatches: ['#000000', '#1a1a1a', '#0d47a1', '#ffffff'] },
      { key: 'shadow', label: 'צל', type: 'range', range: [0, 10, 1] }
    ]},
    { id: 'box', title: 'רקע', icon: 'box', fields: [
      { key: 'bgStyle', label: 'סוג רקע', type: 'select', options: [['none', 'ללא רקע'], ['line', 'מאחורי כל שורה'], ['strip', 'רצועה קבועה']] },
      { key: 'background', label: 'אטימות', type: 'range', range: [0, 1, 0.01], percent: true },
      { key: 'backgroundColor', label: 'צבע רקע', type: 'color', swatches: ['#000000', '#202124', '#0b2545', '#3e2723', '#ffffff'] },
      { key: 'radius', label: 'עיגול פינות', type: 'range', range: [0, 32, 1], unit: 'px' },
      { key: 'lineLength', label: 'אורך שורה מרבי', type: 'range', range: [16, 70, 1], unit: ' תווים', hint: 'שורות קצרות קלות יותר לקריאה' },
      { key: 'width', label: 'רוחב אזור הכתוביות', type: 'range', range: [30, 100, 1], unit: '%' }
    ]},
    { id: 'place', title: 'מיקום', icon: 'move', fields: [
      { key: 'y', label: 'מיקום למעלה / למטה', type: 'range', range: [0, 100, 1], unit: '%', hint: '100 = הכי למטה. אפשר גם לגרור את הכתוביות בעכבר' },
      { key: 'x', label: 'מיקום ימינה / שמאלה', type: 'range', range: [0, 100, 1], unit: '%', hint: '50 = באמצע' },
      { key: 'lockPosition', label: 'נעילת מיקום', type: 'toggle', hint: 'כבוי: גוררים את הכתוביות ישירות בעכבר — גם כשפס ההתקדמות מוצג' },
      { key: 'avoidControls', label: 'להתרחק מפס הנגן', type: 'toggle', hint: 'כשפס השליטה מוצג, הכתוביות זזות מעליו בעדינות' }
    ], actions: [['resetPosition', 'החזרת מיקום לברירת מחדל']] },
    { id: 'audio', title: 'אודיו ודיבוב', icon: 'audio', fields: [
      { key: 'hebrewDub', label: 'דיבוב עברי מעל הקול המקורי', type: 'toggle', hint: 'כבוי כברירת מחדל. כשמדליקים: רק אם ליוטיוב יש בסרטון ערוץ אודיו בעברית — הנגן עובר לדיבוב העברי, ונגן מקביל נסתר מנגן את הקול המקורי חלש מאחוריו בסנכרון. בלי ערוץ עברי לא נוגעים באודיו (אף פעם לא אנגלית או שפה אחרת)' },
      { key: 'dubVolume', label: 'עוצמת הדיבוב בעברית (מעל)', type: 'range', range: [0, 100, 1], unit: '%' },
      { key: 'originalVolume', label: 'עוצמת הקול המקורי (ברקע)', type: 'range', range: [0, 100, 1], unit: '%', hint: 'הקול המקורי מתנגן חלש מאחורי הדיבוב בעברית. רק בסרטון שיש לו ערוץ אודיו בעברית. בכיבוי חוזרים הערוץ והעוצמה הקודמים' },
      { key: 'tts', label: 'דיבוב קולי בעברית (הקראת הכתוביות)', type: 'toggle', hint: 'קול עברי מקריא את הכתוביות בזמן אמת. עובד גם כשהכתוביות מוסתרות. בסרטון שהמקור שלו בעברית — לא מקריא' },
      { key: 'ttsMode', label: 'איך לשמוע', type: 'select', options: [['mix', 'משולב — הקול העברי מעל, המקור שקט ברקע'], ['only', 'רק הדיבוב העברי (המקור מושתק)']] },
      { key: 'ttsVolume', label: 'עוצמת הקריינות העברית', type: 'range', range: [0, 100, 1], unit: '%', hint: 'עוצמת הקול העברי שמקריא את הכתוביות' },
      { key: 'ttsDuck', label: 'עוצמת הקול המקורי בזמן שהקול העברי מדבר', type: 'range', range: [0, 100, 1], unit: '%', hint: 'במצב משולב: עוצמת המקור בזמן שהקול העברי מדבר' },
      { key: 'ttsIdle', label: 'עוצמת הקול המקורי כשאין דיבור', type: 'range', range: [0, 100, 1], unit: '%', hint: 'ברקע, בין משפטים — הקול המקורי חוזר אליה בהדרגה' },
      { key: 'ttsAuto', label: 'איזון אוטומטי לקול של הדפדפן', type: 'toggle', hint: 'הקול של הדפדפן (בלי מפתח) חלש יחסית, ולכן הקול המקורי יורד אליו חזק יותר, כדי שיישמע ברור. כבוי: אותה עוצמה לכל הקולות' },
      { key: 'ttsEngine', label: 'מנוע הקול', type: 'select', options: [['azure', 'אברי / הילה — קול טבעי של מיקרוסופט'], ['browser', 'קול של הדפדפן (בכרום: אסף)']] },
      { key: 'azureVoice', label: 'קול טבעי', type: 'select', options: [['he-IL-AvriNeural', 'אברי (גבר)'], ['he-IL-HilaNeural', 'הילה (אישה)']] },
      { key: 'azureKey', label: 'מפתח Azure Speech', type: 'secret', hint: 'נשמר רק במחשב הזה. בלי מפתח — משתמשים בקול של הדפדפן. הוראות לקבלת מפתח חינמי: הקישור מתחת לשדה' },
      { key: 'azureRegion', label: 'אזור (Region) של המפתח', type: 'select', hint: 'אם האזור לא נכון — התוסף מוצא לבד את הנכון', options: [['northeurope', 'North Europe'], ['westeurope', 'West Europe'], ['israelcentral', 'Israel Central'], ['eastus', 'East US'], ['westus2', 'West US 2'], ['uksouth', 'UK South'], ['francecentral', 'France Central'], ['germanywestcentral', 'Germany West Central'], ['swedencentral', 'Sweden Central'], ['centralindia', 'Central India'], ['southeastasia', 'Southeast Asia']] },
      { key: 'ttsVoice', label: 'קול הדפדפן', type: 'voice' },
      { key: 'ttsRate', label: 'מהירות בסיס', type: 'range', range: [0.7, 2, 0.05], unit: '×', hint: 'כשמשפט ארוך מהזמן שלו, המהירות עולה אוטומטית כדי לא לפגר אחרי הסרטון' }
    ], actions: [['resetBalance', 'איפוס האיזון בין הקול העברי לקול המקורי']] }
  ];

  const defaults = {
    enabled: true, language: 'he', showHebrew: false, mode: 'live', lines: 2, highlightStyle: 'pill', wordColor: '#1e88e5', skipNoise: true, offset: 0,
    font: 'Arial', size: 34, color: '#ffffff', bold: true, outline: 2.5, outlineColor: '#000000', shadow: 3,
    bgStyle: 'none', background: 0.6, backgroundColor: '#000000', radius: 8, width: 80,
    x: 50, y: 90, lockPosition: false, avoidControls: true,
    hebrewDub: false, dubVolume: 100, originalVolume: 35, lineLength: 36,
    tts: false, ttsVoice: '', ttsRate: 1, ttsDuck: 30, ttsVolume: 100, ttsIdle: 100, ttsAuto: true, ttsMode: 'mix', ttsEngine: 'azure', azureVoice: 'he-IL-AvriNeural', azureKey: '', azureRegion: 'northeurope'
  };

  // 3.0.4: כל סגנון קובע את כל שדות העיצוב (לא נשארים שאריות מסגנון קודם). הראשון = ברירת המחדל המקורית.
  const DESIGN_KEYS = ['font', 'size', 'color', 'bold', 'outline', 'outlineColor', 'shadow', 'bgStyle', 'background', 'backgroundColor', 'radius', 'width', 'lineLength', 'highlightStyle', 'wordColor'];
  const PRESETS = {};
  const preset = (id, label, diff) => { PRESETS[id] = { label, patch: Object.assign(Object.fromEntries(DESIGN_KEYS.map(k => [k, defaults[k]])), diff) }; };
  preset('default', 'ברירת המחדל', {});
  preset('yellow', 'צהוב קלאסי', { color: '#fff176', outline: 2, shadow: 4 });
  preset('soft', 'צל רך, בלי מסגרת', { outline: 0, shadow: 7, bold: true });
  preset('thick', 'מסגרת עבה', { outline: 4, shadow: 2, size: 36 });
  preset('box', 'תיבה כהה מאחורי השורה', { bgStyle: 'line', background: 0.65, outline: 0, shadow: 0, radius: 6 });
  preset('book', 'גופן ספר (דוד)', { font: 'David', size: 40, bold: true, outline: 2, shadow: 3 });
  preset('modern', 'מודרני (Segoe UI)', { font: 'Segoe UI', size: 34, bold: true, outline: 2, shadow: 4 });
  preset('large', 'גדול ונגיש', { size: 50, color: '#fff59d', bgStyle: 'line', background: 0.8, outline: 1, radius: 10 });

  const RANGES = {};
  for (const s of SECTIONS) for (const f of s.fields) if (f.range) RANGES[f.key] = f.range;
  const BOOLS = Object.keys(defaults).filter(k => typeof defaults[k] === 'boolean');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function normalize(value) {
    const s = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
    if (typeof s.shadow === 'boolean') s.shadow = s.shadow ? 3 : 0; // גרסה קודמת שמרה כן/לא
    for (const [k, [min, max]] of Object.entries(RANGES)) {
      const n = Number(s[k]);
      s[k] = clamp(Number.isFinite(n) ? n : defaults[k], min, max);
    }
    s.x = clamp(Number.isFinite(+s.x) ? +s.x : defaults.x, 0, 100);
    s.y = clamp(Number.isFinite(+s.y) ? +s.y : defaults.y, 0, 100);
    s.lines = clamp(Math.round(+s.lines) || defaults.lines, 1, 4);
    for (const k of BOOLS) s[k] = !!s[k];
    if (typeof s.shadow === 'boolean') s.shadow = s.shadow ? 3 : 0;
    if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(String(s.language))) s.language = defaults.language;
    for (const k of ['color', 'backgroundColor', 'outlineColor', 'wordColor']) if (!/^#[0-9a-f]{6}$/i.test(String(s[k]))) s[k] = defaults[k];
    if (!['pill', 'text', 'underline', 'none'].includes(s.highlightStyle)) s.highlightStyle = defaults.highlightStyle;
    if (!['live', 'lines', 'follow'].includes(s.mode)) s.mode = s.mode === 'stable' ? 'lines' : 'live';
    if (!['none', 'line', 'strip'].includes(s.bgStyle)) s.bgStyle = defaults.bgStyle;
    if (typeof s.font !== 'string' || !s.font || s.font.length > 60) s.font = defaults.font;
    if (typeof s.ttsVoice !== 'string') s.ttsVoice = '';
    for (const k of ['ttsMode', 'ttsEngine', 'azureVoice', 'azureRegion']) { const f = SECTIONS.flatMap(x => x.fields).find(x => x.key === k); if (!f.options.some(o => o[0] === s[k])) s[k] = defaults[k]; }
    s.azureKey = typeof s.azureKey === 'string' ? s.azureKey.trim().slice(0, 200) : '';
    for (const k of Object.keys(s)) if (!(k in defaults)) delete s[k];
    return s;
  }

  const field = key => { for (const s of SECTIONS) for (const f of s.fields) if (f.key === key) return f; return null; };
  function formatValue(key, value) {
    const f = field(key);
    if (!f) return String(value);
    if (f.type === 'toggle') return value ? 'פועל' : 'כבוי';
    if (f.type === 'select') { const o = f.options.find(o => String(o[0]) === String(value)); return o ? o[1] : String(value); }
    if (f.type === 'range') {
      if (f.percent) return Math.round(value * 100) + '%';
      const step = f.range[2];
      const n = step < 1 ? Number(value).toFixed(step < 0.1 ? 2 : 1) : String(Math.round(value));
      return (key === 'offset' && value > 0 ? '+' : '') + n + (f.unit || '');
    }
    if (f.type === 'voice') return value || 'אוטומטי';
    return String(value);
  }

  // 3.0.4: מסגרת אחידה סביב האותיות — טבעת צללים בכל הכיוונים (במקום text-stroke שיצא עבה בחלק ודק בחלק)
  function textShadow(outline, outlineColor, shadow, scale = 1) {
    const out = [];
    const r = outline * scale;
    if (r > 0) {
      const rings = r > 2 ? [r, r * 0.55] : [r];
      for (const rr of rings) { const n = Math.max(12, Math.ceil(rr * 8)); for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; out.push(`${(Math.cos(a) * rr).toFixed(2)}px ${(Math.sin(a) * rr).toFixed(2)}px 0 ${outlineColor}`); } }
    }
    if (shadow) out.push(`0 ${(shadow * 0.25 * scale).toFixed(2)}px ${(shadow * scale).toFixed(2)}px rgba(0,0,0,.9)`);
    return out.length ? out.join(',') : 'none';
  }

  // 3.0.10: זיהוי גופנים מותקנים לוקח כ-2 שניות — עושים אותו ברקע, פרוס על פני משימות, ושומרים ל-7 ימים
  const FONT_KEY = 'fontsAvail';
  function detectFonts(done) {
    let c = null; try { c = document.createElement('canvas').getContext('2d'); } catch { }
    if (!c) return done(null);
    const sample = 'אבגדהו שלום abcdefghij 0123', bases = ['monospace', 'serif', 'sans-serif'];
    const w0 = bases.map(b => { c.font = '40px ' + b; return c.measureText(sample).width; });
    const out = {}; let i = 0;
    (function step() {
      if (i >= FONTS.length) return done(out);
      const f = FONTS[i++];
      out[f] = bases.some((b, k) => { c.font = '40px "' + f + '", ' + b; return c.measureText(sample).width !== w0[k]; });
      setTimeout(step, 0);
    })();
  }
  function ensureFonts(cb) {
    let p = null; try { p = chrome.storage.local.get(FONT_KEY); } catch { }
    const run = () => detectFonts(f => { if (f) { try { chrome.storage.local.set({ [FONT_KEY]: { v: 1, t: Date.now(), f } }); } catch { } } cb(f); });
    if (!p || !p.then) return run();
    p.then(v => { const x = v && v[FONT_KEY]; if (x && x.v === 1 && Date.now() - x.t < 7 * 864e5) cb(x.f); else run(); }).catch(run);
  }

  // 3.0.13: איפוס האיזון (עוצמות הקריינות / המקור / מהירות) לברירת המחדל
  const BALANCE_KEYS = ['ttsVolume', 'ttsDuck', 'ttsIdle', 'ttsAuto', 'ttsRate'];
  const balanceDefaults = () => Object.fromEntries(BALANCE_KEYS.map(k => [k, defaults[k]]));

  root.CaptionSettings = { balanceDefaults, BALANCE_KEYS, ensureFonts, textShadow, DESIGN_KEYS, defaults, normalize, SECTIONS, PRESETS, LANGS, FONTS, field, formatValue };
})(globalThis);

/* כתוביות חכמות — לוגיקה טהורה (ללא DOM) המשותפת לנגן, לתוכן ולבדיקות */
(function (root) {
  const C = {};
  const safe = fn => { try { return fn(); } catch { return undefined; } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ---------- שפות ---------- */
  C.normLang = l => String(l || '').trim().replace(/_/g, '-').replace(/^iw(?=$|[-.])/i, 'he').toLowerCase();
  C.baseLang = l => C.normLang(l).split(/[-.]/)[0];
  C.sameLang = (a, b) => !!a && !!b && C.baseLang(a) === C.baseLang(b);
  C.isHebrew = l => C.baseLang(l) === 'he';

  /* ---------- פענוח קובצי timedtext (json3 / srv3 / XML ישן) ---------- */
  const decode = s => String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  // 3.0.6: דף חסימה של גוגל ("we can't process your request") או כל HTML אחר — אינו כתוביות
  C.isNotCaptions = body => { const t = String(body || '').trim(); return !!t && t[0] === '<' && !/<(timedtext|transcript)\b/i.test(t.slice(0, 3000)); };
  C.parseTimedText = function (body) {
    const text = String(body || '').trim();
    if (!text || C.isNotCaptions(text)) return [];
    if (text[0] === '{') {
      const json = safe(() => JSON.parse(text));
      if (!json || !Array.isArray(json.events)) return [];
      return json.events.filter(e => Array.isArray(e.segs)).map(e => ({
        start: Number(e.tStartMs) || 0,
        dur: Number(e.dDurationMs) || 0,
        append: !!e.aAppend,
        segs: e.segs.map(s => ({ text: String(s.utf8 || ''), off: s.tOffsetMs == null ? null : Number(s.tOffsetMs) || 0 }))
      }));
    }
    const events = [];
    // srv3: <p t="ms" d="ms"><s t="ms">word</s></p>
    const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g; let m;
    while ((m = pRe.exec(text))) {
      const attr = m[1], t = +(/\bt="(\d+)"/.exec(attr) || [])[1] || 0, d = +(/\bd="(\d+)"/.exec(attr) || [])[1] || 0;
      const segs = []; const sRe = /<s\b([^>]*)>([\s\S]*?)<\/s>/g; let s;
      while ((s = sRe.exec(m[2]))) segs.push({ text: decode(s[2]), off: /\bt="(\d+)"/.test(s[1]) ? +/\bt="(\d+)"/.exec(s[1])[1] : null });
      if (!segs.length) segs.push({ text: decode(m[2].replace(/<br\s*\/?>/g, '\n')), off: null });
      events.push({ start: t, dur: d, append: /\ba="1"/.test(attr), segs });
    }
    if (events.length) return events;
    // פורמט ישן: <text start="s" dur="s">
    const tRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    while ((m = tRe.exec(text))) {
      const st = parseFloat((/\bstart="([\d.]+)"/.exec(m[1]) || [])[1]) || 0, du = parseFloat((/\bdur="([\d.]+)"/.exec(m[1]) || [])[1]) || 0;
      events.push({ start: Math.round(st * 1000), dur: Math.round(du * 1000), append: false, segs: [{ text: decode(decode(m[2])), off: null }] });
    }
    return events;
  };

  /* ---------- בניית קטעים (cues) ---------- */
  const clean = s => s.replace(/[​﻿]/g, '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  C.buildCues = function (events, opts = {}) {
    const content = events.filter(e => !e.append && clean(e.segs.map(s => s.text).join('')));
    const asr = !!opts.asr || content.some(e => e.segs.some(s => s.off != null && s.off > 0));
    const cues = [];
    content.sort((a, b) => a.start - b.start);
    for (let i = 0; i < content.length; i++) {
      const e = content[i], next = content[i + 1];
      let end = e.start + (e.dur || 4000);
      if (asr && next && next.start > e.start) end = Math.min(end, next.start);
      const text = clean(e.segs.map(s => s.text).join(''));
      if (!text || end <= e.start) continue;
      let words = null;
      if (e.segs.some(s => s.off != null)) {
        words = [];
        for (const s of e.segs) {
          const w = clean(s.text); if (!w) continue;
          words.push({ t: e.start + (s.off || 0), text: w });
        }
      }
      cues.push({ start: e.start, end, text, words, asr });
    }
    return cues;
  };

  /* חלוקת מילים לאורך זמן הקטע — לתצוגה חיה כשאין תזמון מילים (תרגום אוטומטי) */
  C.interpolateWords = function (cue) {
    if (cue.words && cue.words.length) return cue.words;
    const parts = cue.text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((n, w) => n + w.length + 1, 0) || 1;
    const span = Math.min(cue.end - cue.start, Math.max(600, total * 75));
    let acc = 0;
    return parts.map(w => { const t = cue.start + span * acc / total; acc += w.length + 1; return { t, text: w }; });
  };

  /* חיפוש בינארי: האיבר האחרון שהתחיל עד at */
  C.lastStarted = function (list, at) {
    let lo = 0, hi = list.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].start <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };

  /* ---------- שבירת שורות דטרמיניסטית ---------- */
  C.wrap = function (text, maxWidth, measure) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = []; let line = '';
    const pushLong = w => { // מילה ארוכה מרוחב השורה
      let part = '';
      for (const ch of w) { if (part && measure(part + ch) > maxWidth) { lines.push(part); part = ch; } else part += ch; }
      return part;
    };
    for (const w of words) {
      const cand = line ? line + ' ' + w : w;
      if (measure(cand) <= maxWidth) { line = cand; continue; }
      if (line) lines.push(line);
      line = measure(w) > maxWidth ? pushLong(w) : w;
    }
    if (line) lines.push(line);
    return lines;
  };

  /* ---------- מצב חי: מילה אחרי מילה ---------- */
  C.liveText = function (cues, at, opts = {}) {
    const hold = opts.hold ?? 2500, gap = opts.gap ?? 2000;
    const i = C.lastStarted(cues, at);
    if (i < 0) return '';
    const cur = cues[i];
    if (!cur.asr) { // 3.0.4: גם כתוביות ידניות / מתורגמות — מילה אחרי מילה לאורך הקטע (לא שורה שלמה בבת אחת)
      const active = [];
      for (let j = i; j >= 0 && j > i - 6; j--) if (cues[j].start <= at && at < cues[j].end) active.unshift(cues[j]);
      return active.map(c => C.interpolateWords(c).filter(w => w.t <= at).map(w => w.text).join(' ')).filter(Boolean).join(' ');
    }
    if (at > cur.end + hold) return '';
    let first = i;
    while (first > 0 && i - first < 8 && cues[first].start - cues[first - 1].end < gap) first--;
    const out = [];
    for (let j = first; j <= i; j++) for (const w of C.interpolateWords(cues[j])) if (w.t <= at) out.push(w.text);
    return out.join(' ');
  };

  /* ---------- 3.0.4 מעקב מילה אחר מילה: ציר זמן של כל המילים (מילה = אסימון בין רווחים) ---------- */
  // 3.0.9: זמן לכל מילה בדיוק לפי המילים של טקסט הקטע (אותה ספירה כמו בעמודים) — פסיקים/סימנים שהגיעו
  // כקטע נפרד כבר לא מזיזים את הספירה, ולכן ההדגשה וההופעה מילה-מילה לא "בורחות" לסוף.
  C.cueTokenTimes = function (c) {
    const toks = c.text.split(/\s+/).filter(Boolean);
    if (!toks.length) return [];
    const span = Math.max(300, (c.end - c.start) * 0.92);
    const byChars = () => { const total = toks.reduce((n, w) => n + w.length + 1, 0) || 1; let acc = 0; return toks.map(w => { const t = c.start + span * acc / total; acc += w.length + 1; return t; }); };
    if (!c.words || !c.words.length) return byChars();
    // מיקום כל מילה מתוזמנת בתוך הטקסט, ואז לכל אסימון — הזמן של המילה שמתחילה לפניו
    const marks = []; let pos = 0;
    for (const w of c.words) { const i = c.text.indexOf(w.text, pos); if (i < 0) continue; marks.push({ i, t: w.t }); pos = i + w.text.length; }
    if (!marks.length) return byChars();
    const out = []; let p = 0, m = 0;
    for (const tok of toks) {
      const i = c.text.indexOf(tok, p); p = i < 0 ? p : i + tok.length;
      while (m + 1 < marks.length && marks[m + 1].i <= (i < 0 ? p : i)) m++;
      out.push(Math.max(c.start, marks[m].t));
    }
    for (let k = 1; k < out.length; k++) if (out[k] < out[k - 1]) out[k] = out[k - 1];
    return out;
  };
  C.wordTimeline = function (cues) {
    const out = [];
    for (const c of cues) for (const t of C.cueTokenTimes(c)) out.push({ t, end: c.end });
    for (let k = 0; k < out.length - 1; k++) if (out[k + 1].t > out[k].t) out[k].end = Math.min(out[k].end, out[k + 1].t);
    return out;
  };

  /* ---------- 3.0.9: הערות של יוטיוב כמו [מוזיקה] / (מחיאות כפיים) / ♪ — לא מוצגות ולא מוקראות ---------- */
  const NOISE_RE = /\[[^\]]{0,60}\]|\([^)]{0,30}\)|\*[^*\n]{1,30}\*|[♪♫🎵🎶]+/g;
  // סימני החלפת דובר של יוטיוב (">>", "<<", "»", "-") — לא טקסט שנאמר
  const MARK_RE = /(^|\s)(?:>{1,3}|<{1,3}|[»«›‹]+|[-–—]{1,2}(?=\s))\s*/g;
  const denoise = t => String(t).replace(NOISE_RE, ' ').replace(MARK_RE, '$1').replace(/\s{2,}/g, ' ').trim();
  C.stripNoise = function (cues) {
    const out = [];
    for (const c of cues) {
      const text = denoise(c.text);
      if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
      if (text === c.text) { out.push(c); continue; }
      const words = c.words ? c.words.map(w => ({ ...w, text: denoise(w.text) })).filter(w => w.text && /[\p{L}\p{N}]/u.test(w.text)) : null;
      out.push({ ...c, text, words: words && words.length ? words : null });
    }
    return out;
  };

  /* ---------- מצב שורות שלמות: עמודים יציבים ---------- */
  const SENTENCE_END = /[.?!…׃:;"”»)]$/;
  C.buildPages = function (cues, opts) {
    const { lines: maxLines, maxWidth, measure, joinAll } = opts;
    const fits = t => C.wrap(t, maxWidth, measure).length <= maxLines;
    const groups = [];
    let g = null;
    for (const c of cues) {
      if ((c.asr || joinAll) && g) {
        const last = g.cues[g.cues.length - 1];
        const joined = g.text + ' ' + c.text;
        // joinAll (מצב חי/מעקב): ממלאים עד N שורות גם אחרי סוף משפט, כל עוד אין שתיקה ארוכה
        if (c.start - last.end < 1200 && (joinAll || !SENTENCE_END.test(g.text)) && fits(joined)) { g.cues.push(c); g.text = joined; g.end = c.end; continue; }
      }
      g = { start: c.start, end: c.end, text: c.text, cues: [c] };
      groups.push(g);
    }
    const pages = [];
    let wi = 0; // אינדקס המילה הראשונה בעמוד בציר הזמן של המילים
    const count = ls => ls.join(' ').split(/\s+/).filter(Boolean).length;
    for (const grp of groups) {
      const wrapped = C.wrap(grp.text, maxWidth, measure);
      const groupWords = grp.text.split(/\s+/).filter(Boolean).length;
      if (wrapped.length <= maxLines) { pages.push({ start: grp.start, end: grp.end, lines: wrapped, wi }); wi += groupWords; continue; }
      let gwi = wi; wi += groupWords;
      // קטע ארוך: מחלקים לעמודים — שום מילה לא נחתכת, הזמן מתחלק לפי אורך הטקסט
      const total = wrapped.join(' ').length || 1; let acc = 0;
      for (let k = 0; k < wrapped.length; k += maxLines) {
        const chunk = wrapped.slice(k, k + maxLines), len = chunk.join(' ').length + 1;
        const s = grp.start + (grp.end - grp.start) * acc / total; acc += len;
        pages.push({ start: Math.round(s), end: Math.round(grp.start + (grp.end - grp.start) * Math.min(1, acc / total)), lines: chunk, wi: gwi });
        gwi += count(chunk);
      }
    }
    pages.sort((a, b) => a.start - b.start);
    for (let k = 0; k < pages.length - 1; k++) if (pages[k].end > pages[k + 1].start && pages[k].end - pages[k + 1].start < 400) pages[k].end = pages[k + 1].start;
    return pages;
  };
  C.pageAt = function (pages, at) {
    const i = C.lastStarted(pages, at);
    return i >= 0 && at < pages[i].end ? pages[i] : null;
  };

  /* ---------- יחידות הקראה (TTS): משפטים ---------- */
  C.speechUnits = function (cues) {
    const units = []; let u = null;
    for (const c of cues) {
      if (u && c.start - u.end < 900 && !SENTENCE_END.test(u.text) && u.text.length + c.text.length < 220) { u.text += ' ' + c.text; u.end = c.end; continue; }
      u = { start: c.start, end: c.end, text: c.text }; units.push(u);
    }
    return units;
  };

  /* ---------- בחירת מסלול כתוביות ---------- */
  C.chooseCaptionTrack = function (tracks, translationLangs, target, audioLang) {
    tracks = (tracks || []).filter(Boolean);
    if (!tracks.length) return { reason: 'none' };
    const manual = tracks.filter(t => t.kind !== 'asr');
    const direct = manual.find(t => C.sameLang(t.languageCode, target)) || tracks.find(t => C.sameLang(t.languageCode, target));
    if (direct) return { track: direct, translate: false };
    const canTranslate = !translationLangs || !translationLangs.length || translationLangs.some(l => C.sameLang(l.languageCode, target));
    const translatable = tracks.filter(t => t.isTranslatable !== false && t.is_translateable !== false);
    const src = translatable.find(t => t.kind !== 'asr' && audioLang && C.sameLang(t.languageCode, audioLang))
      || translatable.find(t => t.kind === 'asr') || translatable.find(t => t.kind !== 'asr') || null;
    if (!src || !canTranslate) return { reason: 'no-translation' };
    return { track: src, translate: true };
  };

  /* ---------- זיהוי שפת האודיו המקורי ---------- */
  const ORIGINAL_RE = /original|מקורי|מקור|オリジナル|原始|оригинал|originale|original/i;
  C.detectAudioLanguage = function ({ formats, captionTracks } = {}) {
    const seen = new Map();
    for (const f of formats || []) if (f && f.audioTrack && f.audioTrack.id && !seen.has(f.audioTrack.id)) seen.set(f.audioTrack.id, f.audioTrack);
    const tracks = [...seen.values()];
    if (tracks.length) {
      const named = tracks.find(t => ORIGINAL_RE.test(t.displayName || ''));
      if (named) return { lang: C.baseLang(named.id), confidence: 'high', source: 'audio-track', multi: tracks.length > 1 };
      if (tracks.length === 1) return { lang: C.baseLang(tracks[0].id), confidence: 'high', source: 'audio-track', multi: false };
    }
    const asr = (captionTracks || []).find(t => t.kind === 'asr');
    if (asr) return { lang: C.baseLang(asr.languageCode), confidence: 'high', source: 'asr', multi: tracks.length > 1 };
    if (tracks.length) { const def = tracks.find(t => t.audioIsDefault); if (def) return { lang: C.baseLang(def.id), confidence: 'medium', source: 'default-track', multi: true }; }
    const manual = (captionTracks || []).filter(t => t.kind !== 'asr');
    if (manual.length && manual.every(t => C.isHebrew(t.languageCode))) return { lang: 'he', confidence: 'low', source: 'captions-only-hebrew', multi: false };
    return { lang: '', confidence: 'unknown', source: 'none', multi: tracks.length > 1 };
  };
  C.shouldHideForHebrew = (detected, showHebrew) => !showHebrew && C.isHebrew(detected.lang) && (detected.confidence === 'high' || detected.confidence === 'medium');

  /* ---------- אובייקטי ערוץ אודיו של נגן יוטיוב (שמות מאפיינים מוקטנים) ---------- */
  const ID_RE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*\.\d+$/;
  const strings = obj => { const out = []; if (!obj || typeof obj !== 'object') return out; for (const k of Object.keys(obj)) { const v = safe(() => obj[k]); if (typeof v === 'string') out.push(v); } return out; };
  C.audioTrackInfo = function (t) {
    if (!t) return { id: '', lang: '', name: '', original: false };
    const info = safe(() => t.getLanguageInfo && t.getLanguageInfo()) || t.languageInfo || null;
    const ids = [t.id, t.audioTrackId, safe(() => t.getId && t.getId()), info && info.id, safe(() => info && info.getId && info.getId()), ...strings(t), ...strings(info)];
    const id = ids.find(v => typeof v === 'string' && ID_RE.test(v)) || '';
    const names = [t.displayName, t.name, info && info.name, safe(() => info && info.getName && info.getName()), ...strings(info), ...strings(t)].filter(v => typeof v === 'string' && v && !ID_RE.test(v) && /\p{L}{2}/u.test(v));
    const name = names.find(n => ORIGINAL_RE.test(n)) || names[0] || '';
    const lang = id ? C.baseLang(id) : C.baseLang(t.languageCode || (info && info.languageCode) || '');
    const original = ORIGINAL_RE.test(name) || t.isOriginal === true || !!(info && info.isOriginal === true);
    return { id, lang, name, original };
  };
  C.pickMixTracks = function (tracks, formatsHint) {
    const infos = (tracks || []).map(t => ({ t, ...C.audioTrackInfo(t) }));
    const dub = infos.find(i => C.isHebrew(i.lang));
    const hint = formatsHint ? C.detectAudioLanguage({ formats: formatsHint }) : null;
    const original = infos.find(i => i.original && !C.isHebrew(i.lang))
      || (hint && hint.lang && !C.isHebrew(hint.lang) ? infos.find(i => i.lang === hint.lang) : null)
      || infos.find(i => !C.isHebrew(i.lang) && i.lang);
    return { dub: dub || null, original: original || null };
  };

  // 3.0.3: הערוץ המקורי של הסרטון (גם אם הוא בעברית) — לפי השם "מקורי/original", ואם אין — לפי ערוץ ברירת המחדל בנתוני הסרטון. לא מנחשים.
  C.pickOriginalTrack = function (tracks, formatsHint) {
    const infos = (tracks || []).map(t => ({ t, ...C.audioTrackInfo(t) }));
    if (infos.length < 2) return null;
    const named = infos.find(i => i.original);
    if (named) return named;
    const seen = new Map();
    for (const f of formatsHint || []) if (f && f.audioTrack && f.audioTrack.id && !seen.has(f.audioTrack.id)) seen.set(f.audioTrack.id, f.audioTrack);
    const fmt = [...seen.values()];
    const byName = fmt.find(a => ORIGINAL_RE.test(a.displayName || ''));
    const def = byName || fmt.find(a => a.audioIsDefault);
    return def ? (infos.find(i => i.id && i.id === def.id) || null) : null;
  };

  /* ---------- סנכרון נגן המקור ---------- */
  C.syncDecision = function (drift, masterRate) {
    const a = Math.abs(drift);
    if (a > 0.45) return { seek: true, rate: masterRate };
    if (a > 0.04) return { seek: false, rate: +(masterRate * (1 - clamp(drift * 0.6, -0.08, 0.08))).toFixed(4) };
    return { seek: false, rate: masterRate };
  };

  /* ---------- כתובת timedtext ---------- */
  C.timedTextInfo = function (url) {
    const u = safe(() => new URL(url, 'https://www.youtube.com'));
    if (!u || !/\/api\/timedtext/.test(u.pathname)) return null;
    const p = u.searchParams;
    return { v: p.get('v') || '', lang: p.get('lang') || '', tlang: p.get('tlang') || '', kind: p.get('kind') || '', effective: p.get('tlang') || p.get('lang') || '' };
  };
  C.retargetTimedText = function (url, sourceLang, target) {
    const u = new URL(url, 'https://www.youtube.com');
    if (C.sameLang(sourceLang || u.searchParams.get('lang'), target)) u.searchParams.delete('tlang'); else u.searchParams.set('tlang', target);
    u.searchParams.set('fmt', 'json3');
    return u.toString();
  };

  root.SmartCaptionsCore = C;
  if (typeof module === 'object' && module.exports) module.exports = C;
})(globalThis);

function startContent() {
/* כתוביות חכמות — סקריפט תוכן: שכבת הכתוביות, גרירה, תפריט בתוך הנגן, CC והקראה */
(() => {
  if (new URL(location.href).searchParams.has('smartcc_companion')) return;
  if (window.__smartCaptionsContent) return;
  window.__smartCaptionsContent = true;

  const S = globalThis.CaptionSettings, C = globalThis.SmartCaptionsCore;
  const ORIGIN = location.origin;
  const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch { return d; } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (k in n && k !== 'style') n[k] = v; else n.setAttribute(k, v); } for (const c of kids) if (c != null) n.append(c); return n; };

  let settings = S.normalize({});
  let loaded = false, alive = true;
  let state = {}, gotState = false;
  let rawCues = [], cues = [], cueMeta = null, cueVideo = '', pages = [], pageKey = '', units = [];
  let player = null, host = null, shadow = null, cap = null, linesEl = null, panel = null;
  let lastLines = [], lastLift = 0, drag = null, saveTimer = 0;
  const errors = [], cuesMsgs = [];
  let ttsIndex = -2, lastAt = 0, speakingCount = 0, actx = null, audioGraph = null, graphVideo = null;

  /* ---------- הסתרת הכתוביות המקוריות של יוטיוב ---------- */
  const globalStyle = document.createElement('style');
  globalStyle.textContent = `
    .smartcc-hide-native .ytp-caption-window-container{opacity:0!important;pointer-events:none!important}
    .smartcc-item .ytp-menuitem-icon svg{fill:#fff}
    .smartcc-plain:hover{background:rgba(255,255,255,.14);border-radius:50%}
    .smartcc-ctl .sl{display:none}
    .smartcc-ctl[data-on="false"] svg{opacity:.55}
    .smartcc-ctl[data-on="false"] .sl{display:inline}
    .smartcc-ctl[data-na="true"]{opacity:.4}
    .smartcc-item .ytp-menuitem-content{white-space:nowrap}
    .smartcc-button{display:inline-flex!important;align-items:center;justify-content:center;vertical-align:top}
    .smartcc-button svg{width:24px;height:24px;fill:#fff}
    .ytp-subtitles-button[data-smartcc="off"] .ytp-svg-fill{opacity:.85}
  `;
  (document.head || document.documentElement).append(globalStyle);

  /* ---------- הגדרות ---------- */
  const send = (type, extra) => window.postMessage({ source: 'smartcc-content', type, ...extra }, ORIGIN);
  // 3.0.10: דיבוב קולי וטראק אודיו עברי — אפשר לכבות/להדליק לכל סרטון בנפרד (כפתורים על הנגן). ברירת מחדל: ההגדרה הכללית.
  let videoOv = {};
  const ovOf = () => (state && state.videoId && videoOv[state.videoId]) || {};
  const ttsOn = () => { const o = ovOf(); return o.tts != null ? !!o.tts : !!settings.tts; };
  const dubOn = () => { const o = ovOf(); return o.dub != null ? !!o.dub : !!settings.hebrewDub; };
  const sendConfig = () => send('config', { cfg: { ...settings, azureKey: '', tts: ttsOn(), hebrewDub: dubOn() } }); // המפתח לא עובר לדף
  function setOv(patch) {
    const id = state && state.videoId; if (!id) return;
    videoOv[id] = { ...(videoOv[id] || {}), ...patch, t: Date.now() };
    const keys = Object.keys(videoOv);
    if (keys.length > 300) { keys.sort((a, b) => (videoOv[a].t || 0) - (videoOv[b].t || 0)); for (const k of keys.slice(0, keys.length - 250)) delete videoOv[k]; }
    safe(() => chrome.storage.local.set({ videoOv }).catch(() => { }));
    sendConfig(); refreshButtons(); refreshPanel();
    if (!ttsOn()) stopSpeech();
  }
  let lastCfgVideo = '';
  function apply(next) {
    const prev = settings;
    settings = S.normalize(next);
    document.documentElement.classList.toggle('smartcc-on', true);
    if (prev.language !== settings.language) { cues = []; cueMeta = null; pages = []; pageKey = ''; units = []; stopSpeech(); }
    if (['font', 'size', 'bold', 'lines', 'width', 'bgStyle', 'outline', 'lineLength'].some(k => prev[k] !== settings[k])) pageKey = '';
    if (prev.skipNoise !== settings.skipNoise && rawCues.length) { cues = settings.skipNoise ? C.stripNoise(rawCues) : rawCues; pageKey = ''; timelineKey = ''; units = C.speechUnits(cues); ttsIndex = -2; }
    sendConfig();
    paint(true);
    refreshPanel();
  }
  function save(patch) {
    apply({ ...settings, ...patch });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => safe(() => chrome.storage.local.set({ settings }).catch(() => {})), 120);
  }
  safe(() => chrome.storage.local.get('settings').then(v => { loaded = true; apply(v.settings); }).catch(() => { loaded = true; apply({}); }));
  safe(() => chrome.storage.local.get('videoOv').then(v => { videoOv = v.videoOv || {}; sendConfig(); refreshButtons(); }).catch(() => { }));
  safe(() => chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.videoOv) { videoOv = c.videoOv.newValue || {}; sendConfig(); refreshButtons(); } }));
  safe(() => chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.settings && JSON.stringify(S.normalize(c.settings.newValue)) !== JSON.stringify(settings)) apply(c.settings.newValue); }));
  setInterval(() => {
    if (loaded && !gotState) sendConfig();
    // משיכה: אם הגשר כבר מחזיק כתוביות ואנחנו עדיין לא — מבקשים שוב
    if (gotState && state.haveCues && !(cues.length && cueVideo === state.videoId)) send('need-cues', {});
    // 3.0.1: דופק לגשר שבדף. כשהתוסף כבוי / הוסר — אומרים לו להיעצר ולהחזיר את הנגן (אחרת הוא ממשיך לרוץ בלשונית)
    if (!safe(() => chrome.runtime.id)) { alive = false; send('shutdown', {}); } else send('ping', {});
  }, 1000);

  /* ---------- הודעות מהגשר ---------- */
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== ORIGIN || !e.data || e.data.source !== 'smartcc-bridge') return;
    const d = e.data;
    if (d.type === 'error') errors.push(d.where + ': ' + d.msg);
    if (d.type === 'state') { gotState = true; state = d.state || {}; if (state.videoId !== lastCfgVideo) { lastCfgVideo = state.videoId; sendConfig(); } if (state.videoId && cueVideo && state.videoId !== cueVideo) resetCues(); paint(); refreshPanel(true); updateMenuItem(); refreshButtons(); }
    if (d.type === 'video') { resetCues(); }
    if (d.type === 'cues') cuesMsgs.push([d.videoId, d.lang, Array.isArray(d.cues) ? d.cues.length : typeof d.cues, settings.language].join('/'));
    if (d.type === 'cues' && Array.isArray(d.cues) && C.sameLang(d.lang, settings.language)) {
      if (!tm.cuesAt) tm.cuesAt = Math.round(performance.now());
      rawCues = d.cues; cues = settings.skipNoise ? C.stripNoise(d.cues) : d.cues; cueVideo = d.videoId; cueMeta = { translated: d.translated, from: d.from }; pageKey = ''; units = C.speechUnits(cues); ttsIndex = -2;
      refreshPanel(true);
    }
  });
  function resetCues() { cues = []; cueMeta = null; cueVideo = ''; pages = []; pageKey = ''; units = []; lastLines = []; stopSpeech(); if (linesEl) linesEl.textContent = ''; }

  /* ---------- שכבת הכתוביות ---------- */
  const CAP_CSS = `
    :host{all:initial}
    #layer{position:absolute;inset:0;pointer-events:none;z-index:60;direction:rtl}
    #cap{position:absolute;box-sizing:border-box;pointer-events:none;overflow:hidden;transition:transform .25s ease}
    #cap.strip{pointer-events:auto;cursor:grab}
    #cap.dragging,#cap.dragging .t{cursor:grabbing!important;transition:none}
    #cap.locked .t,#cap.locked.strip{cursor:default}
    #lines{position:absolute;inset-inline:0;bottom:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
    .line{display:block;width:100%;text-align:center;white-space:pre;unicode-bidi:plaintext}
    .t{pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;box-decoration-break:clone;-webkit-box-decoration-break:clone;display:inline-block}
    .w{transition:color .12s}
    #cap:not(.locked):hover .t{outline:1px dashed rgba(255,255,255,.35);outline-offset:2px}
    #cap.dragging .t{outline:1px dashed rgba(255,255,255,.7)}
  `;
  // 3.0.11: בנגן החדש הכותרת, השעון והכפתורים יושבים בשכבת-על משלהם. השכבה שלנו נכנסת פנימה (אחרונה, z-index מקסימלי) — כך היא תמיד מעל ואפשר ללחוץ ולגרור
  function findOverlay(p) {
    let a = p && p.parentElement;
    for (let k = 0; a && k < 8; k++, a = a.parentElement) {
      const o = a.querySelector('.player-controls-content');
      if (o) return o;
      if (a === document.body) break;
    }
    return null;
  }
  function placeInOverlay(ov) {
    if (!host || host.parentElement === ov) return false;
    if (getComputedStyle(ov).position === 'static') ov.style.position = 'relative';
    host.style.zIndex = '2147483647';
    ov.append(host);
    return true;
  }
  function mount(p) {
    if (host) host.remove();
    player = p;
    host = el('div', { 'data-smartcc-host': '' });
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:1000'; // 3.0.4: מעל פס ההתקדמות — אפשר לתפוס ולגרור גם כשהוא מוצג
    shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('style', { text: CAP_CSS + PANEL_CSS }));
    cap = el('div', { id: 'cap' });
    linesEl = el('div', { id: 'lines' });
    cap.append(linesEl);
    const layer = el('div', { id: 'layer' }, cap);
    panel = el('div', { id: 'panel', hidden: true, role: 'dialog', 'aria-label': 'כתוביות חכמות' });
    layer.append(panel);
    shadow.append(layer);
    bindDrag();
    bindPanelIsolation();
    const ov = findOverlay(p);
    if (ov) { placeInOverlay(ov); }
    else if (newUiControls(p) && p.parentElement) {
      // נגן מוטמע חדש: שכבת הכפתורים יושבת מעל הנגן — שמים את הכתוביות מעליה כדי שהגרירה תעבוד
      const par = p.parentElement;
      if (getComputedStyle(par).position === 'static') par.style.position = 'relative';
      host.style.zIndex = '2147483000';
      par.append(host);
    } else p.append(host);
    lastLines = []; pageKey = '';
    send('need-cues', {});
    paint(true);
  }

  // 3.0.10: זיהוי גופנים מותקנים — ברקע ובמטמון (S.ensureFonts); עד שהוא מוכן מוצגת כל הרשימה
  let fontsAvail = null, fontsAsked = false;
  const fontOk = name => !fontsAvail || fontsAvail[name] !== false;
  function askFonts() { if (fontsAsked) return; fontsAsked = true; S.ensureFonts(f => { fontsAvail = f; refreshPanel(); }); }
  /* מדידת טקסט דטרמיניסטית — אנחנו קובעים את שבירת השורות, ולכן אין קפיצות */
  const canvas = safe(() => document.createElement('canvas').getContext('2d'), null);
  let measureFont = '', measureCache = new Map();
  function measurer(fontPx) {
    const f = `${settings.bold ? 700 : 400} ${fontPx.toFixed(2)}px "${settings.font}", Arial, sans-serif`;
    if (f !== measureFont) { measureFont = f; measureCache = new Map(); }
    return t => { let w = measureCache.get(t); if (w == null) { if (canvas) { canvas.font = f; w = canvas.measureText(t).width; } else w = t.length * fontPx * 0.55; if (measureCache.size > 4000) measureCache.clear(); measureCache.set(t, w); } return w; };
  }
  function geometry() {
    const pw = player.clientWidth, ph = player.clientHeight;
    const scale = clamp(ph / 720, 0.42, 2.6);
    const fontPx = Math.max(10, settings.size * scale);
    const lh = fontPx * 1.32;
    const strip = settings.bgStyle === 'strip', line = settings.bgStyle === 'line';
    const padY = strip ? fontPx * 0.3 : fontPx * 0.12;
    const padX = strip ? fontPx * 0.7 : 0;
    const linePadX = line ? fontPx * 0.4 : 0;
    const boxW = Math.min(pw, pw * settings.width / 100);
    const boxH = Math.min(ph, settings.lines * lh + padY * 2);
    // שורה לא ארוכה מ-lineLength תווים בערך — גם במסך מלא
    const maxText = Math.max(40, Math.min(boxW - padX * 2 - linePadX * 2 - settings.outline * 2 - fontPx * 0.3, fontPx * 0.5 * settings.lineLength));
    return { pw, ph, fontPx, lh, padY, padX, linePadX, boxW, boxH, maxText };
  }
  const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  let styleKey = '';
  function paint(force) {
    if (!cap || !player) return;
    const g = geometry();
    const active = settings.enabled && !state.hideHebrew;
    cap.style.display = active ? 'block' : 'none';
    const key = JSON.stringify([g.pw, g.ph, settings]);
    if (force || key !== styleKey) {
      styleKey = key;
      const center = g.pw * settings.x / 100, bottom = g.ph * settings.y / 100;
      const left = clamp(center - g.boxW / 2, 0, g.pw - g.boxW);
      const top = clamp(bottom - g.boxH, 0, g.ph - g.boxH);
      const strip = settings.bgStyle === 'strip', line = settings.bgStyle === 'line';
      Object.assign(cap.style, {
        left: left + 'px', top: top + 'px', width: g.boxW + 'px', height: g.boxH + 'px',
        padding: `${g.padY}px ${g.padX}px`, borderRadius: settings.radius + 'px',
        background: strip ? rgba(settings.backgroundColor, settings.background) : 'transparent'
      });
      cap.classList.toggle('strip', strip && settings.background > 0.02);
      cap.classList.toggle('locked', settings.lockPosition);
      Object.assign(linesEl.style, { bottom: g.padY + 'px', insetInline: g.padX + 'px', fontFamily: `"${settings.font}", Arial, sans-serif`, fontSize: g.fontPx + 'px', lineHeight: g.lh + 'px', fontWeight: settings.bold ? '700' : '400', color: settings.color });
      const sh = S.textShadow(settings.outline, settings.outlineColor, settings.shadow, clamp(g.fontPx / 34, 0.5, 2.5));
      const hc = settings.wordColor, hs = settings.highlightStyle;
      const hl = hs === 'pill' ? `.w.cur{background:${hc};border-radius:.3em;box-shadow:0 0 0 .12em ${hc};text-shadow:none}`
        : hs === 'text' ? `.w.cur{color:${hc}}`
        : hs === 'underline' ? `.w.cur{text-decoration:underline ${hc} .14em;text-underline-offset:.22em}` : '';
      const lineStyle = hl + '.w.fut,.t.fut{visibility:hidden}' + `.t{text-shadow:${sh};` +
        (line ? `background:${rgba(settings.backgroundColor, settings.background)};padding:0 ${g.linePadX}px;border-radius:${Math.min(settings.radius, g.lh / 2)}px;` : 'background:none;padding:0 2px;') + '}';
      let dyn = shadow.getElementById('dyn');
      if (!dyn) { dyn = el('style', { id: 'dyn' }); shadow.append(dyn); }
      dyn.textContent = lineStyle;
      lastLines = []; // ציור מחדש
      positionPanel();
    }
  }

  function currentLines(g, video) {
    const at = video.currentTime * 1000 - settings.offset * 1000;
    const measure = measurer(g.fontPx);
    const haveCues = cues.length && cueVideo === state.videoId;
    if (haveCues) {
      // 3.0.5: גם במצב חי — "עמוד" של עד N שורות שכבר מסודר במקומו הסופי. מילים מתווספות לשורה, ממשיכות לשורה הבאה,
      // וכשהעמוד מתמלא מתחיל עמוד חדש. שום מילה לא זזה ושום שורה לא קופצת.
      const joinAll = settings.mode !== 'lines';
      const k = [cueVideo, cues.length, g.maxText.toFixed(0), g.fontPx.toFixed(1), settings.font, settings.bold, settings.lines, settings.lineLength, joinAll].join('|');
      if (k !== pageKey) { pageKey = k; pages = C.buildPages(cues, { lines: settings.lines, maxWidth: g.maxText, measure, joinAll }); }
      const pg = C.pageAt(pages, at);
      if (!pg) return [];
      if (settings.mode === 'lines') return pg.lines;
      // מעקב: המילה שנאמרת עכשיו מסומנת בצבע ההדגשה
      if (timelineKey !== k || timelineCues !== cues) { timelineKey = k; timelineCues = cues; timeline = C.wordTimeline(cues); }
      let cur = -1;
      for (let i = pg.wi, n = pg.wi + pg.lines.join(' ').split(/\s+/).filter(Boolean).length; i < n && i < timeline.length; i++) if (timeline[i].t <= at) cur = i - pg.wi; else break;
      const out = pg.lines.slice();
      if (settings.mode === 'live') { out.shown = cur + 1; out.cur = settings.highlightStyle !== 'none' ? cur : -1; }
      else out.cur = cur;
      return out;
    }
    let text;
    {
      // גיבוי (אין עדיין נתוני תזמון): הטקסט שיוטיוב מציג (מוסתר מתחת לשכבה שלנו)
      let nodes = player.querySelectorAll('.ytp-caption-window-container .caption-visual-line');
      if (!nodes.length) nodes = player.querySelectorAll('.ytp-caption-window-container .ytp-caption-segment');
      text = Array.from(nodes, n => n.textContent.trim()).filter(Boolean).join(' ');
    }
    const wrapped = C.wrap(text, g.maxText, measure);
    return wrapped.slice(-settings.lines);
  }

  let timeline = [], timelineKey = '', timelineCues = null;
  function renderLines(lines, g) {
    const same = lines.length === lastLines.length && lines.every((l, i) => l === lastLines[i]) && lines.cur === lastLines.cur && lines.shown === lastLines.shown;
    if (same) return;
    if (lines.cur != null) { // מצב מעקב: כל מילה בתג משלה
      let wi = 0;
      const shown = lines.shown == null ? Infinity : lines.shown;
      const nodes = lines.map(l => { const first = wi; const t = el('span', { class: 't' + (first >= shown ? ' fut' : '') }, ...l.split(' ').flatMap((w, i) => { const s = el('span', { class: 'w' + (wi === lines.cur ? ' cur' : '') + (wi >= shown ? ' fut' : ''), text: w }); wi++; return i ? [document.createTextNode(' '), s] : [s]; })); return el('div', { class: 'line', dir: 'auto' }, t); });
      linesEl.replaceChildren(...nodes);
      lastLines = lines;
      return;
    }
    const rolled = settings.mode === 'live' && lastLines.length && lines.length === settings.lines && lastLines.length === settings.lines && settings.lines > 1 && lines[0] === lastLines[1];
    const nodes = lines.map(l => el('div', { class: 'line', dir: 'auto' }, el('span', { class: 't', text: l })));
    linesEl.replaceChildren(...nodes);
    if (rolled && linesEl.animate) linesEl.animate([{ transform: `translateY(${g.lh}px)` }, { transform: 'none' }], { duration: 170, easing: 'ease-out' });
    lastLines = lines;
  }

  function liftForControls(g) {
    if (!settings.avoidControls || drag || !lastLines.length) return 0;
    const hidden = player.classList.contains('ytp-autohide') || player.classList.contains('ytp-hide-controls');
    if (hidden) return 0;
    const bar = player.querySelector('.ytp-chrome-bottom');
    if (!bar) return 0;
    const pr = player.getBoundingClientRect(), br = bar.getBoundingClientRect();
    if (!br.height) return 0;
    const barTop = br.top - pr.top - 6;
    const capBottom = parseFloat(cap.style.top) + g.boxH;
    return Math.max(0, capBottom - barTop);
  }

  function frame() {
    if (!player || !cap) return;
    const video = player.querySelector('video');
    const active = settings.enabled && !state.hideHebrew;
    if (!video) return;
    if (!active) { player.classList.toggle('smartcc-hide-native', settings.enabled === false || !!state.hideHebrew); if (lastLines.length) renderLines([], {}); ttsTick(video); return; }
    const g = geometry();
    renderLines(currentLines(g, video), g);
    // מסתירים את הכתוביות של יוטיוב רק כשיש לנו מקור טקסט אמיתי — אחרת הן נשארות גלויות
    const haveSource = (cues.length && cueVideo === state.videoId) || !!player.querySelector('.ytp-caption-window-container .ytp-caption-segment');
    player.classList.toggle('smartcc-hide-native', !!haveSource);
    const lift = liftForControls(g);
    if (Math.abs(lift - lastLift) > 1) { lastLift = lift; cap.style.transform = lift ? `translateY(${-lift}px)` : ''; }
    ttsTick(video);
  }

  /* ---------- גרירה ישירה ---------- */
  function bindDrag() {
    const stop = e => e.stopPropagation();
    for (const t of ['mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'pointerup']) cap.addEventListener(t, stop);
    cap.addEventListener('pointerdown', e => {
      e.stopPropagation();
      if (settings.lockPosition || e.button !== 0) return;
      e.preventDefault();
      const g = geometry();
      // מתחילים מהמיקום המוצג בפועל (כולל הרמה מעל פס הנגן) ושומרים את נקודת האחיזה — בלי קפיצה
      cap.classList.add('dragging');
      const left = parseFloat(cap.style.left), top = parseFloat(cap.style.top) - lastLift;
      lastLift = 0; cap.style.transform = ''; cap.style.top = top + 'px';
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: left + g.boxW / 2, by: top + g.boxH, g, moved: false };
      cap.setPointerCapture(e.pointerId);
    });
    cap.addEventListener('pointermove', e => {
      if (!drag || drag.id !== e.pointerId) return;
      e.stopPropagation();
      const g = drag.g, dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      const cx = clamp(drag.cx + dx, g.boxW / 2, g.pw - g.boxW / 2);
      const by = clamp(drag.by + dy, g.boxH, g.ph);
      settings.x = cx / g.pw * 100; settings.y = by / g.ph * 100;
      cap.style.left = (cx - g.boxW / 2) + 'px'; cap.style.top = (by - g.boxH) + 'px';
    });
    const end = e => {
      if (!drag || (e.pointerId != null && drag.id !== e.pointerId)) return;
      const moved = drag.moved; drag = null;
      cap.classList.remove('dragging');
      if (moved) save({ x: +settings.x.toFixed(2), y: +settings.y.toFixed(2) });
    };
    cap.addEventListener('pointerup', end); cap.addEventListener('pointercancel', end); cap.addEventListener('lostpointercapture', end);
  }

  /* ======================= תפריט בתוך הנגן (בסגנון יוטיוב) ======================= */
  const PANEL_CSS = `
    #panel{position:absolute;right:12px;bottom:60px;width:310px;max-width:calc(100% - 24px);max-height:calc(100% - 72px);overflow:hidden auto;pointer-events:auto;
      background:rgba(28,28,28,.94);color:#eee;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.5);font:400 14px/1.4 "YouTube Sans",Roboto,Arial,sans-serif;
      direction:rtl;text-align:right;scrollbar-width:thin;scrollbar-color:#666 transparent;z-index:80;backdrop-filter:blur(6px)}
    #panel[hidden]{display:none}
    .hd{display:flex;align-items:center;gap:6px;height:48px;padding:0 6px 0 12px;border-bottom:1px solid rgba(255,255,255,.2);position:sticky;top:0;background:rgba(28,28,28,.98);z-index:2;font-weight:500;font-size:15px}
    .hd .ttl{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ib{all:unset;cursor:pointer;width:36px;height:36px;display:grid;place-items:center;border-radius:50%;color:#fff;font-size:20px}
    .ib:hover,.ib:focus-visible{background:rgba(255,255,255,.12)}
    .list{padding:8px 0}
    .row{display:flex;align-items:center;gap:12px;min-height:40px;padding:0 16px;cursor:pointer;outline:none}
    .row:hover,.row:focus-visible{background:rgba(255,255,255,.1)}
    .row .lb{flex:1;min-width:0}
    .row .lb small{display:block;color:#aaa;font-size:12px;line-height:1.35;margin-top:1px}
    .row .val{color:#aaa;font-size:13px;white-space:nowrap;max-width:45%;overflow:hidden;text-overflow:ellipsis}
    .row .chev{color:#aaa;font-size:18px;line-height:1}
    .row.static{cursor:default}.row.static:hover{background:none}
    .sw{position:relative;width:36px;height:14px;border-radius:7px;background:rgba(255,255,255,.3);flex:none;transition:background .15s}
    .sw::after{content:"";position:absolute;top:-3px;right:-2px;width:20px;height:20px;border-radius:50%;background:#bdbdbd;box-shadow:0 1px 3px rgba(0,0,0,.4);transition:right .15s,background .15s}
    .sw.on{background:rgba(255,0,51,.55)}.sw.on::after{right:18px;background:#ff0033}
    .rng{padding:6px 16px 10px}
    .rng .top{display:flex;justify-content:space-between;color:#eee}
    .rng .top span:last-child{color:#aaa}
    input[type=range]{width:100%;margin:8px 0 0;accent-color:#ff0033;height:4px;cursor:pointer}
    .sws{display:flex;flex-wrap:wrap;gap:8px;padding:4px 16px 12px}
    .sws button{all:unset;cursor:pointer;width:24px;height:24px;border-radius:50%;box-shadow:inset 0 0 0 2px rgba(255,255,255,.35)}
    .sws button.sel{box-shadow:0 0 0 2px #fff, inset 0 0 0 2px rgba(0,0,0,.4)}
    .sws input[type=color]{width:28px;height:26px;border:0;padding:0;background:none;cursor:pointer}
    .opt{display:flex;align-items:center;gap:12px;min-height:40px;padding:0 16px;cursor:pointer}
    .opt:hover,.opt:focus-visible{background:rgba(255,255,255,.1);outline:none}
    .opt .ck{width:20px;text-align:center}
    .note{margin:4px 16px 10px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.07);color:#ccc;font-size:12.5px;line-height:1.45}
    .note.err{background:rgba(255,80,80,.14);color:#ffb4ab}
    .chips{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px 16px 12px}
    .chip{all:unset;cursor:pointer;border-radius:10px;padding:10px 8px;text-align:center;background:rgba(255,255,255,.08);font-size:13px}
    .chip:hover,.chip:focus-visible{background:rgba(255,255,255,.16)}
    .chip b{display:block;font-size:16px;margin-bottom:2px;paint-order:stroke fill}
    .sep{height:1px;background:rgba(255,255,255,.12);margin:6px 0}
    .btn{all:unset;cursor:pointer;display:block;margin:6px 16px 10px;padding:9px 14px;border-radius:18px;background:rgba(255,255,255,.1);text-align:center;font-size:13.5px}
    .btn:hover,.btn:focus-visible{background:rgba(255,255,255,.18)}
  `;
  let panelPage = 'main';
  function bindPanelIsolation() {
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown', 'keyup', 'keypress', 'touchstart', 'touchend', 'contextmenu'])
      panel.addEventListener(t, e => { e.stopPropagation(); if (t === 'keydown' && e.key === 'Escape') { e.preventDefault(); closePanel(); } });
  }
  // 3.0.14: גלילה של החלונית בגלגל העכבר ובמגע. שכבת הבקרים של יוטיוב בולעת את הגלילה, ולכן השורות התחתונות (ובהן אודיו ודיבוב) לא היו נגישות
  window.addEventListener('wheel', e => {
    if (!panel || panel.hidden || !e.composedPath().includes(panel)) return;
    panel.scrollTop += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    e.preventDefault(); e.stopPropagation();
  }, { capture: true, passive: false });
  let touchY = null;
  window.addEventListener('touchstart', e => { const p0 = e.composedPath(); touchY = panel && !panel.hidden && p0.includes(panel) && !(p0[0] && p0[0].matches && p0[0].matches('input')) && e.touches[0] ? e.touches[0].clientY : null; }, { capture: true, passive: true });
  window.addEventListener('touchmove', e => { if (touchY == null || !e.touches[0]) return; const y = e.touches[0].clientY; panel.scrollTop -= (y - touchY); touchY = y; e.preventDefault(); e.stopPropagation(); }, { capture: true, passive: false });
  window.addEventListener('touchend', () => { touchY = null; }, true);
  function openPanel(page = 'main') {
    if (!panel) return;
    panelPage = page; panel.hidden = false;
    renderPanel();
    positionPanel();
    requestAnimationFrame(() => { const f = panel.querySelector('.row,.opt,.ib'); f && f.focus({ preventScroll: true }); });
  }
  function closePanel() { if (panel) panel.hidden = true; }
  function positionPanel() {
    if (!panel || panel.hidden || !player) return;
    const bar = player.querySelector('.ytp-chrome-bottom');
    const barH = bar && bar.offsetHeight ? bar.offsetHeight : 48;
    const ph = player.clientHeight;
    const bottom = ph < 260 ? 6 : barH + 12;
    // 3.0.12: בנגן החדש — החלונית מתחילה מתחת לבר העליון (כותרת / אייקון הערוץ), כך שאף שכבה של יוטיוב לא מכסה אותה
    let top = 10;
    const ovp = host && host.parentElement;
    if (ovp && ovp.classList && ovp.classList.contains('player-controls-content')) {
      const tc = ovp.querySelector('.player-controls-top');
      if (tc) { const hr = host.getBoundingClientRect(), tr = tc.getBoundingClientRect(); if (tr.height) top = Math.max(10, Math.ceil(tr.bottom - hr.top) + 6); }
    }
    panel.style.bottom = bottom + 'px';
    panel.style.maxHeight = Math.max(120, ph - bottom - top) + 'px';
  }
  document.addEventListener('pointerdown', e => {
    if (!panel || panel.hidden) return;
    const path = e.composedPath();
    if (path.includes(panel) || path.some(n => n.classList && (n.classList.contains('smartcc-button') || n.classList.contains('smartcc-item')))) return;
    closePanel();
  }, true);

  const ICONS = {
    language: 'M12 2a10 10 0 100 20 10 10 0 000-20zm6.9 6h-3a15.7 15.7 0 00-1.4-3.6A8 8 0 0118.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8.2 8.2 0 010-4h3.4a16.5 16.5 0 000 4H4.3zm.8 2h3a15.7 15.7 0 001.4 3.6A8 8 0 015.1 16zm3-8h-3a8 8 0 014.3-3.6C8.9 5.5 8.4 6.7 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 010-4h4.6a14.7 14.7 0 010 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 01-4.4 3.6zM16.3 14a16.5 16.5 0 000-4h3.4a8.2 8.2 0 010 4h-3.4z',
    text: 'M5 4v3h5.5v12h3V7H19V4z',
    box: 'M3 5h18v14H3zm2 2v10h14V7zm2 6h6v2H7zm8 0h2v2h-2zm-8-3h2v2H7zm4 0h6v2h-6z',
    move: 'M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z',
    audio: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8v8a4.5 4.5 0 002.5-4zM14 3.2v2.1a7 7 0 010 13.4v2.1a9 9 0 000-17.6z',
    style: 'M12 3a9 9 0 000 18c.8 0 1.5-.7 1.5-1.5 0-.4-.1-.7-.4-1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16a5 5 0 005-5c0-4.4-4-8-9-8zm-5.5 9a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3 4a1.5 1.5 0 110-3 1.5 1.5 0 010 3z',
    cc: 'M19 4H5a2 2 0 00-2 2v12a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-4a1 1 0 011-1h3a1 1 0 011 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 01-1 1h-3a1 1 0 01-1-1v-4a1 1 0 011-1h3a1 1 0 011 1v1z'
  };
  const svgIcon = name => { const ns = 'http://www.w3.org/2000/svg'; const s = document.createElementNS(ns, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '24'); s.setAttribute('height', '24'); s.style.fill = '#fff'; s.style.flex = 'none'; const p = document.createElementNS(ns, 'path'); p.setAttribute('d', ICONS[name] || ICONS.cc); s.append(p); return s; };

  function header(title, back) {
    return el('div', { class: 'hd' },
      back ? el('button', { class: 'ib', title: 'חזרה', 'aria-label': 'חזרה', text: '›', onclick: () => openPanel(back) }) : svgIcon('cc'),
      el('div', { class: 'ttl', text: title }),
      el('button', { class: 'ib', title: 'סגירה', 'aria-label': 'סגירה', text: '✕', onclick: closePanel }));
  }
  const activate = fn => ({ tabindex: '0', onclick: fn, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } } });
  function toggleRow(f) {
    return el('div', { class: 'row', role: 'menuitemcheckbox', 'aria-checked': String(settings[f.key]), 'data-key': f.key, ...activate(() => save({ [f.key]: !settings[f.key] })) },
      el('div', { class: 'lb', text: f.label }, f.hint ? el('small', { text: f.hint }) : null), el('div', { class: 'sw' + (settings[f.key] ? ' on' : '') }));
  }
  function selectRow(f, page) {
    return el('div', { class: 'row', role: 'menuitem', 'aria-haspopup': 'true', 'data-key': f.key, ...activate(() => openPanel('opt:' + f.key + ':' + page)) },
      el('div', { class: 'lb', text: f.label }), el('div', { class: 'val', 'data-val': f.key, text: valueText(f.key) }), el('div', { class: 'chev', text: '‹' }));
  }
  function rangeRow(f) {
    const [min, max, step] = f.range;
    const input = el('input', { type: 'range', min, max, step, value: settings[f.key], 'aria-label': f.label, 'data-input': f.key });
    input.addEventListener('input', () => save({ [f.key]: Number(input.value) }));
    return el('div', { class: 'rng' }, el('div', { class: 'top' }, el('span', { text: f.label }), el('span', { 'data-val': f.key, text: S.formatValue(f.key, settings[f.key]) })), input);
  }
  function colorRow(f) {
    const wrap = el('div', { class: 'sws', 'data-colors': f.key });
    for (const c of f.swatches) wrap.append(el('button', { title: c, 'aria-label': c, style: `background:${c}`, class: settings[f.key].toLowerCase() === c ? 'sel' : '', 'data-color': c, onclick: () => save({ [f.key]: c }) }));
    const custom = el('input', { type: 'color', value: settings[f.key], title: 'צבע אחר', 'aria-label': f.label + ' — צבע אחר' });
    custom.addEventListener('input', () => save({ [f.key]: custom.value }));
    wrap.append(custom);
    return el('div', {}, el('div', { class: 'row static' }, el('div', { class: 'lb', text: f.label })), wrap);
  }
  function voices() {
    const all = safe(() => speechSynthesis.getVoices(), []) || [];
    return all.filter(v => C.sameLang(v.lang, settings.language));
  }
  function valueText(key) {
    if (key === 'ttsVoice') return settings.ttsVoice || 'אוטומטי';
    return S.formatValue(key, settings[key]);
  }
  // 3.0.14: שדה המפתח גם בתוך הנגן: הדבקה, עין (הצגה/הסתרה), בדיקת קול והוראות
  function secretRow(f) {
    return el('div', { class: 'row static' }, el('div', { class: 'lb', text: f.label },
      el('small', { text: 'להזנה או למחיקה של המפתח, פתחו את תפריט Tampermonkey בדף YouTube.' }),
      el('button', { class: 'btn', type: 'button', text: 'הוראות Azure Speech',
        onclick: () => chrome.runtime.sendMessage({ type: 'smartcc-open-help' }) })));
  }
  function fieldRow(f, page) {
    if (f.type === 'toggle') return toggleRow(f);
    if (f.type === 'select' || f.type === 'voice') return selectRow(f, page);
    if (f.type === 'range') return rangeRow(f);
    if (f.type === 'color') return colorRow(f);
    if (f.type === 'secret') return secretRow(f);
    return null;
  }
  function statusNotes() {
    const out = [];
    if (!state.videoId) return out;
    let src = '';
    if (state.haveCues) src = settings.mode === 'lines' ? 'נתוני תזמון מלאים · שורות שלמות יציבות' : 'נתוני תזמון מלאים';
    else if (state.want) src = settings.mode === 'lines' ? 'אין עדיין נתוני תזמון — מוצג במצב חי מתוך תצוגת יוטיוב' : 'מוצג מתוך תצוגת יוטיוב';
    out.push(el('div', { class: 'note' + (!state.hasCaptions || !state.canTranslate ? ' err' : '') }, el('div', { text: state.status || '' }), src ? el('div', { text: src, style: 'color:#999;margin-top:2px' }) : null));
    return out;
  }
  function mixNotes() {
    const m = state.mix || {};
    const out = [];
    if (dubOn()) {
      if (m.error) out.push(el('div', { class: 'note err', text: m.error }));
      else if (m.state === 'active') out.push(el('div', { class: 'note', text: 'השילוב פעיל: הדיבוב בעברית מעל, והקול המקורי של הסרטון ברקע.' }));
      else if (m.status) out.push(el('div', { class: 'note', text: m.status }));
    } else if (state.videoId) {
      out.push(el('div', { class: 'note', text: m.hasDub ? 'בסרטון הזה יש ערוץ דיבוב בעברית — אפשר לשלב אותו עם הקול המקורי.' : 'בסרטון הזה לא נמצא ערוץ דיבוב בעברית. "הקראת הכתוביות בקול" זמינה בכל סרטון עם כתוביות.' }));
    }
    if (ttsOn() && hebrewSource()) out.push(el('div', { class: 'note', text: 'הסרטון בעברית — אין הקראה.' }));
    else if (ttsOn() && settings.ttsEngine === 'azure' && !settings.azureKey) out.push(el('div', { class: 'note err', text: 'כדי לשמוע את אברי צריך להכניס מפתח בחלון ההגדרות המלא. בינתיים מקריא קול הדפדפן.' }));
    else if (ttsOn() && settings.ttsEngine === 'azure' && azureError) out.push(el('div', { class: 'note err', text: 'הקול הטבעי: ' + azureError + '. בינתיים מקריא קול הדפדפן.' }));
    else if (ttsOn() && settings.ttsEngine === 'azure') { if (!cues.length) out.push(el('div', { class: 'note', text: 'הדיבוב ממתין לנתוני כתוביות מתוזמנים.' })); }
    else if (ttsOn()) {
      const vs = voices();
      if (!vs.length) out.push(el('div', { class: 'note err', text: 'לא נמצא במחשב קול הקראה בשפה שנבחרה. ב-Windows: הגדרות ← זמן ושפה ← דיבור ← הוספת קולות ← עברית. בדפדפן Edge יש קולות עבריים טבעיים מובנים.' }));
      else if (!cues.length) out.push(el('div', { class: 'note', text: 'ההקראה ממתינה לנתוני כתוביות מתוזמנים.' }));

    }
    return out;
  }
  function renderPanel() {
    if (!panel || panel.hidden) return;
    const scroll = panel.scrollTop;
    const kids = [];
    const [kind, key, back] = panelPage.split(':');
    if (panelPage === 'main') {
      kids.push(header('כתוביות חכמות'));
      const list = el('div', { class: 'list', role: 'menu' });
      list.append(toggleRow(S.field('enabled')));
      for (const k of ['language', 'mode', 'highlightStyle', 'lines']) list.append(selectRow(S.field(k), 'main'));
      list.append(toggleRow(S.field('skipNoise')));
      list.append(el('div', { class: 'sep' }));
      const ovRow = (label, hint, on, fn) => el('div', { class: 'row', role: 'menuitemcheckbox', 'aria-checked': String(on), ...activate(fn) }, el('div', { class: 'lb', text: label }, hint ? el('small', { text: hint }) : null), el('div', { class: 'sw' + (on ? ' on' : '') }));
      list.append(ovRow('דיבוב קולי בעברית — בסרטון הזה', 'אפשר לכבות רק לסרטון הזה (גם מהכפתור על הנגן)', ttsOn(), () => setOv({ tts: !ttsOn() })));
      list.append(ovRow('טראק אודיו עברי — בסרטון הזה', 'הדיבוב של יוטיוב בעברית, והקול המקורי חלש מאחוריו', dubOn(), () => setOv({ dub: !dubOn() })));
      list.append(selectRow(S.field('ttsMode'), 'main'));
      list.append(toggleRow(S.field('tts')), toggleRow(S.field('hebrewDub')));
      list.append(toggleRow(S.field('showHebrew')));
      list.append(el('div', { class: 'sep' }));
      list.append(el('div', { class: 'row', role: 'menuitem', ...activate(() => openPanel('presets')) }, svgIcon('style'), el('div', { class: 'lb', text: 'סגנונות מוכנים' }), el('div', { class: 'chev', text: '‹' })));
      for (const s of S.SECTIONS.slice(1)) list.append(el('div', { class: 'row', role: 'menuitem', ...activate(() => openPanel('sec:' + s.id)) }, svgIcon(s.icon), el('div', { class: 'lb', text: s.title }), el('div', { class: 'chev', text: '‹' })));
      list.append(el('div', { class: 'row', role: 'menuitem', ...activate(() => openPanel('sec:watch')) }, svgIcon('language'), el('div', { class: 'lb', text: 'תזמון ועוד' }), el('div', { class: 'chev', text: '‹' })));
      kids.push(list, ...statusNotes());
    } else if (panelPage === 'presets') {
      kids.push(header('סגנונות מוכנים', 'main'));
      const chips = el('div', { class: 'chips' });
      for (const [id, p] of Object.entries(S.PRESETS)) {
        const sample = el('b', { text: 'אבג' });
        const pp = { ...settings, ...p.patch };
        Object.assign(sample.style, { color: pp.color, fontFamily: `"${pp.font}",Arial`, fontWeight: pp.bold ? '700' : '400', textShadow: S.textShadow(pp.outline, pp.outlineColor, pp.shadow, 0.5), background: pp.bgStyle === 'none' ? 'none' : rgba(pp.backgroundColor, pp.background), padding: '0 6px', borderRadius: '4px', display: 'inline-block' });
        chips.append(el('button', { class: 'chip', onclick: () => save(p.patch) }, sample, el('div', { text: p.label })));
      }
      kids.push(chips, el('button', { class: 'btn', text: 'החזרת כל העיצוב לברירת המחדל המקורית', onclick: () => save(S.PRESETS.default.patch) }));
    } else if (kind === 'sec') {
      const sec = S.SECTIONS.find(s => s.id === key);
      kids.push(header(sec.title, 'main'));
      const list = el('div', { class: 'list' });
      for (const f of sec.fields) {
        const r = fieldRow(f, panelPage); if (r) list.append(r);
        if (f.key === 'originalVolume') list.append(...mixNotes().slice(0, 1));
      }
      for (const [act, label] of sec.actions || []) list.append(el('button', { class: 'btn', text: label, onclick: () => { if (act === 'resetPosition') save({ x: S.defaults.x, y: S.defaults.y }); else if (act === 'resetBalance') save(S.balanceDefaults()); } }));
      if (sec.id === 'audio') list.append(...mixNotes().slice(1));
      if (sec.id === 'place') list.append(el('div', { class: 'note', text: 'גוררים את הכתוביות ישירות — מכל מקום בטקסט. הכתוביות תמיד נשארות בתוך גבולות הנגן.' }));
      kids.push(list);
    } else if (kind === 'opt') {
      const f = S.field(key);
      kids.push(header(f.label, back === 'main' ? 'main' : back + ':' + (panelPage.split(':')[3] || '')));
      const list = el('div', { class: 'list', role: 'menu' });
      let opts = f.type === 'voice' ? [['', 'אוטומטי (הקול הטוב ביותר)'], ...voices().map(v => [v.name, v.name])] : f.options;
      if (key === 'font') { askFonts(); opts = opts.filter(([v]) => v === settings.font || fontOk(v)); }
      for (const [value, label] of opts) {
        const sel = String(settings[key]) === String(value);
        list.append(el('div', { class: 'opt', role: 'menuitemradio', 'aria-checked': String(sel), ...activate(() => { save({ [key]: typeof S.defaults[key] === 'number' ? Number(value) : value }); openPanel(back === 'main' ? 'main' : back + ':' + panelPage.split(':')[3]); }) },
          el('span', { class: 'ck', text: sel ? '✓' : '' }), el('span', { text: label, style: key === 'font' ? `font-family:"${value}",Arial` : '' })));
      }
      if (f.type === 'voice' && !voices().length) list.append(el('div', { class: 'note err', text: 'לא נמצאו קולות בשפה זו במחשב.' }));
      kids.push(list);
    }
    panel.replaceChildren(...kids);
    panel.scrollTop = scroll;
  }
  let lastPanelState = '';
  function refreshPanel(fromState) {
    if (!panel || panel.hidden) return;
    if (fromState) { const k = JSON.stringify([state.status, state.haveCues, state.mix, state.want, cues.length > 0]); if (k === lastPanelState) return; lastPanelState = k; }
    const active = shadow.activeElement;
    if (active && active.matches && active.matches('input[type=password],input[type=text]')) return;   // 3.0.14: לא בונים מחדש בזמן הקלדה / הדבקה של מפתח
    if (active && active.matches && active.matches('input[type=range],input[type=color]')) {
      // עדכון במקום בזמן גרירת מחוון — בלי לבנות מחדש
      for (const n of panel.querySelectorAll('[data-val]')) n.textContent = valueText(n.dataset.val);
      for (const w of panel.querySelectorAll('[data-colors]')) for (const b of w.querySelectorAll('[data-color]')) b.classList.toggle('sel', settings[w.dataset.colors].toLowerCase() === b.dataset.color);
      return;
    }
    renderPanel();
  }

  /* ---------- שילוב בתפריט ההגדרות ובפס של יוטיוב ---------- */
  function updateMenuItem() {
    if (!player) return;
    const item = player.querySelector('.smartcc-item .ytp-menuitem-content');
    if (item) item.textContent = !settings.enabled ? 'כבוי' : S.formatValue('language', settings.language);
  }
  const CC_SEL = '.ytp-subtitles-button, .ytmClosedCaptioningButtonButton';
  function newUiControls(p) { return p && p.parentElement ? p.parentElement.querySelector('#player-controls, ytm-custom-control, player-top-controls') : null; }
  // 3.0.6: בנגן החדש (גם בהטמעה) כפתור הכתוביות יושב כמה רמות מעל הנגן — מחפשים אב משותף קרוב
  const inPlayerArea = n => { if (!player || !n) return false; if (player.contains(n)) return true; let a = player.parentElement; for (let k = 0; a && k < 8; k++, a = a.parentElement) { if (a.contains(n)) return true; if (a === document.body) break; } return false; };
  const SLASH = '<path class="sl" d="M3.5 3.5l17 17" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"/>';
  const ICON_VOICE = '<circle cx="8.5" cy="8" r="3.6"/><path d="M1.5 20.5c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6V22h-14z"/><path d="M15.8 5.2a5.6 5.6 0 010 7.6M18.6 2.6a9.4 9.4 0 010 12.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>';
  const ICON_DUB = '<rect x="2.6" y="9" width="2.6" height="6" rx="1.3"/><rect x="6.9" y="5" width="2.6" height="14" rx="1.3"/><rect x="11.2" y="2.5" width="2.6" height="19" rx="1.3"/><rect x="15.5" y="7" width="2.6" height="10" rx="1.3"/><rect x="19.8" y="10" width="2.2" height="4" rx="1.1"/>';
  const ICON_TUNE = '<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/>';
  function svgRaw(inner) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '24'); s.setAttribute('height', '24'); s.setAttribute('aria-hidden', 'true'); s.style.cssText = 'fill:currentColor;display:block;pointer-events:none'; s.innerHTML = inner; return s; }
  // הבר העליון של הנגן החדש יושב מחוץ ל-parent של הנגן — מחפשים כמה רמות למעלה
  function findControlsHost() {
    let a = player && player.parentElement;
    for (let k = 0; a && k < 8; k++, a = a.parentElement) {
      const top = a.querySelector('.player-controls-top-right');
      if (top) return { kind: 'new', el: top };
      if (a === document.body) break;
    }
    const bar = player && player.querySelector('.ytp-right-controls');
    return bar ? { kind: 'classic', el: bar } : null;
  }
  function refreshButtons() {
    const area = (player && player.parentElement) || document;
    const root = document;
    for (const b of root.querySelectorAll('.smartcc-ctl')) {
      const k = b.dataset.ctl; if (k === 'settings') continue;
      const on = k === 'voice' ? ttsOn() : dubOn();
      const na = k === 'voice' ? hebrewSource() : (state.mix ? !state.mix.hasDub : false);
      const o = ovOf(), mine = (k === 'voice' ? o.tts : o.dub) != null;
      b.dataset.on = String(on); b.dataset.na = String(na);
      b.setAttribute('aria-pressed', String(on));
      const name = k === 'voice' ? 'דיבוב קולי בעברית' : 'טראק אודיו עברי (הדיבוב של יוטיוב + המקור ברקע)';
      b.title = name + ' — ' + (on ? 'פועל' : 'כבוי') + (mine ? ' (לסרטון הזה בלבד)' : '') + (na ? (k === 'voice' ? ' · הסרטון בעברית, אין הקראה' : ' · אין בסרטון ערוץ אודיו בעברית') : '') + ' · לחיצה מחליפה';
    }
  }
  // 3.0.10: שורה "כתוביות חכמות" בגיליון ההגדרות של הנגן החדש (איכות / מהירות / כתוביות / טראק אודיו) — באותו סגנון
  function closeSheet() {
    const scrim = document.querySelector('ytw-scrim, .ytWebScrimHost');
    if (scrim) safe(() => scrim.click());
    safe(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })));
  }
  function sheetValue() { return !settings.enabled ? 'כבוי' : S.formatValue('language', settings.language) + (settings.mode === 'live' ? ' · מילה אחרי מילה' : settings.mode === 'follow' ? ' · עם הדגשה' : ''); }
  function integrateSheet() {
    const rows = Array.from(document.querySelectorAll('bottom-sheet-container yt-list-item-view-model, yt-list-item-view-model[role="menuitem"]'));
    if (!rows.length) return;
    const existing = document.querySelector('.smartcc-sheet-row');
    if (existing && existing.isConnected && existing._valEl) { if (existing._valEl.textContent !== sheetValue()) existing._valEl.textContent = sheetValue(); return; }
    const tpl = rows.find(r => /כתוביות|Subtitles|Captions|CC/i.test(r.textContent || '')) || rows[0];
    if (!tpl || !tpl.parentElement || tpl.classList.contains('smartcc-sheet-row')) return;
    const clone = tpl.cloneNode(true);
    clone.classList.add('smartcc-sheet-row');
    clone.removeAttribute('id');
    clone.setAttribute('data-smartcc', 'row');
    const leaves = Array.from(clone.querySelectorAll('*')).filter(n => !n.children.length && n.tagName.toLowerCase() !== 'svg' && n.tagName.toLowerCase() !== 'path' && (n.textContent || '').trim());
    if (leaves[0]) leaves[0].textContent = 'כתוביות חכמות';
    if (leaves[1]) { leaves[1].textContent = sheetValue(); clone._valEl = leaves[1]; for (let k = 2; k < leaves.length; k++) leaves[k].textContent = ''; }
    else clone._valEl = leaves[0] || clone;
    const svgs = clone.querySelectorAll('svg');
    if (svgs.length) { const ic = svgs[0]; ic.setAttribute('viewBox', '0 0 24 24'); ic.innerHTML = ICON_TUNE; ic.style.fill = 'currentColor'; }
    const go = e => { e.stopPropagation(); e.preventDefault(); closeSheet(); setTimeout(() => openPanel('main'), 120); };
    clone.addEventListener('click', go, true);
    clone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') go(e); }, true);
    tpl.after(clone);
  }
  function integrate() {
    if (!player) return;
    refreshButtons();
    integrateSheet();
    // 3.0.11: השכבה שלנו מעל כל שכבות יוטיוב
    { const ov = findOverlay(player); if (ov && host && placeInOverlay(ov)) { paint(true); positionPanel(); } }
    // שלושה כפתורים על הנגן: דיבוב קולי · טראק אודיו עברי · הגדרות כתוביות חכמות
    const ctlHost = findControlsHost();
    if (ctlHost && !ctlHost.el.querySelector('.smartcc-ctl')) {
      const gear = ctlHost.kind === 'new' ? ctlHost.el.querySelector('.player-settings-icon') : null;
      const slot = gear ? (gear.parentElement && gear.parentElement.parentElement === ctlHost.el ? gear.parentElement : gear) : null;
      const mkBtn = (kind, label, inner) => {
        let wrap, btn;
        if (slot) {
          // 3.0.11: משכפלים את כפתור גלגל-השיניים של יוטיוב עצמו — אותו גודל, אותו עיצוב, אותו ריחוף
          wrap = slot.cloneNode(true);
          btn = wrap.tagName === 'BUTTON' ? wrap : wrap.querySelector('button');
          if (btn) {
            btn.classList.remove('player-settings-icon'); btn.removeAttribute('id');
            for (const n of [btn, ...btn.querySelectorAll('[aria-label],[title]')]) { if (n.hasAttribute('aria-label')) n.setAttribute('aria-label', label); if (n.hasAttribute('title')) n.setAttribute('title', label); }
            const sv = btn.querySelector('svg');
            if (sv) { sv.setAttribute('viewBox', '0 0 24 24'); sv.innerHTML = inner; } else { btn.replaceChildren(svgRaw(inner)); }
          }
        }
        if (!btn) {
          btn = el('button', { class: (ctlHost.kind === 'classic' ? 'ytp-button ' : 'icon-button ') + 'smartcc-plain', type: 'button', 'aria-label': label });
          btn.append(svgRaw(inner)); wrap = btn;
          if (ctlHost.kind === 'new') btn.style.cssText = 'width:40px;height:40px;background:transparent;border:0;color:#fff;cursor:pointer;display:inline-grid;place-items:center;padding:0';
        }
        btn.classList.add('smartcc-button', 'smartcc-ctl'); btn.dataset.ctl = kind; btn.title = label;
        return { wrap, btn };
      };
      const voiceB = mkBtn('voice', 'דיבוב קולי בעברית', ICON_VOICE + SLASH);
      const dubB = mkBtn('dub', 'טראק אודיו עברי', ICON_DUB + SLASH);
      const setB = mkBtn('settings', 'כתוביות חכמות — הגדרות', ICON_TUNE);
      voiceB.btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); setOv({ tts: !ttsOn() }); });
      dubB.btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); setOv({ dub: !dubOn() }); });
      setB.btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); panel && !panel.hidden ? closePanel() : openPanel('main'); });
      const all = [voiceB.wrap, dubB.wrap, setB.wrap];
      if (ctlHost.kind === 'new') { for (const w of all) { if (slot) ctlHost.el.insertBefore(w, slot); else ctlHost.el.prepend(w); } }
      else ctlHost.el.prepend(...all);
      refreshButtons();
    }
    // כניסה בתפריט ההגדרות (גלגל השיניים)
    const menu = player.querySelector('.ytp-settings-menu');
    if (menu && menu.style.display !== 'none' && menu.offsetParent !== null) {
      const pnl = menu.querySelector('.ytp-panel');
      if (pnl && !pnl.querySelector('.ytp-panel-header')) {
        const list = pnl.querySelector('.ytp-panel-menu');
        if (list && list.children.length && !list.querySelector('.smartcc-item')) {
          const icon = el('div', { class: 'ytp-menuitem-icon' }, svgIcon('cc'));
          const item = el('div', { class: 'ytp-menuitem smartcc-item', role: 'menuitem', tabindex: '0', 'aria-haspopup': 'true' },
            icon, el('div', { class: 'ytp-menuitem-label', text: 'כתוביות חכמות' }), el('div', { class: 'ytp-menuitem-content', text: '' }));
          const go = e => { e.stopPropagation(); e.preventDefault(); const sb = player.querySelector('.ytp-settings-button'); if (sb) sb.click(); setTimeout(() => openPanel('main'), 0); };
          item.addEventListener('click', go);
          item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') go(e); });
          list.prepend(item);
          updateMenuItem();
        }
        if (list) {
          // יוטיוב קובע גובה קבוע לתפריט — מגדילים כדי שהפריט החדש לא ייחתך
          const need = list.scrollHeight;
          const ph = parseFloat(pnl.style.height);
          if (ph && ph < need) {
            const delta = need - ph;
            pnl.style.height = need + 'px';
            const mh = parseFloat(menu.style.height); if (mh) menu.style.height = (mh + delta) + 'px';
          }
        }
      }
    }
    // סנכרון מצב כפתור CC
    const area = player.parentElement || player;
    for (const cc of area.querySelectorAll(CC_SEL)) {
      const on = String(settings.enabled && !state.hideHebrew);
      if (cc.getAttribute('aria-pressed') !== on) cc.setAttribute('aria-pressed', on);
      cc.dataset.smartcc = on === 'true' ? 'on' : 'off';
    }
  }
  // כפתור CC והמקש C שולטים בכתוביות החכמות (ולא מחזירים את יוטיוב לאנגלית)
  window.addEventListener('click', e => {
    const t = e.target instanceof Element ? e.target.closest(CC_SEL) : null;
    if (!t || !inPlayerArea(t)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    toggleEnabled();
  }, true);
  window.addEventListener('keydown', e => {
    if (e.code !== 'KeyC' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !player) return;
    const t = e.composedPath()[0];
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    toggleEnabled();
  }, true);
  function toggleEnabled() {
    if (state.hideHebrew && settings.enabled) { save({ showHebrew: true }); return; }
    save({ enabled: !settings.enabled });
  }

  /* ======================= דיבוב קולי בעברית (TTS) — 3.0.6 =======================
     שני מנועים: אברי/הילה של מיקרוסופט (Azure, דרך הרקע עם מפתח) או קול הדפדפן.
     משולב: הקול העברי מעל והמקור יורד לרקע בזמן הדיבור. "רק דיבוב": המקור מושתק.
     עובד גם כשהכתוביות מוסתרות. בסרטון שהמקור שלו בעברית — אין הקראה. */
  let ttsAudio = null, waitUnit = -1, origLevel = 1, savedVol = null, azureError = '', azureErrorAt = 0;
  const voiceCps = new Map(); // קצב דיבור נמדד לכל קול
  const azureCache = new Map(); // unit index -> {st, audio, dur, url}
  let azureUnits = null, azureSig = '';
  // 3.0.14: חתימה של הטקסט — אם הכתוביות נשלחו שוב באותו תוכן, לא זורקים את הקולות שכבר הוכנו (חוסך זמן ומכסה)
  const sigOf = us => us.length + '|' + us.reduce((n, u) => n + u.text.length, 0) + '|' + (us[0] ? us[0].text : '') + '|' + (us.length ? us[us.length - 1].text : '');
  function ensureGraph(video) {
    if (!actx || actx.state !== 'running') return;
    if (graphVideo === video && audioGraph) return;
    try {
      const src = actx.createMediaElementSource(video);
      audioGraph = actx.createGain();
      src.connect(audioGraph).connect(actx.destination);
      graphVideo = video;
      if (savedVol != null) { video.volume = savedVol; savedVol = null; }
      origLevel = -1; // ייקבע מחדש דרך הגרף
    } catch { audioGraph = null; }
  }
  window.addEventListener('pointerdown', () => {
    if (!ttsOn()) return;
    try { if (!actx) actx = new AudioContext(); if (actx.state === 'suspended') actx.resume(); } catch { }
  }, true);
  // עוצמת הקול המקורי (0..1): דרך גרף האודיו, ואם הדפדפן עוד לא אישר — דרך עוצמת הווידאו
  // 3.0.10: הקול המקורי חוזר בהדרגה כשאין דיבור (~1.2 שנ׳) ונעלם בעדינות אך מהר כשהקול העברי מתחיל (~0.1 שנ׳)
  let origCur = 1, origT = 0, lastSpeakAt = 0, warmedFor = '';
  const tm = {};   // זמני התחלה לאבחון: מתי הגיעו כתוביות / מתי התחיל הסרטון / מתי התחילה ההקראה הראשונה
  function applyOriginal(level, video) {
    if (audioGraph && actx && actx.state === 'running') { safe(() => audioGraph.gain.setValueAtTime(level, actx.currentTime)); if (savedVol != null) { video.volume = savedVol; savedVol = null; } return; }
    if (level >= 0.999) { if (savedVol != null) { video.volume = savedVol; savedVol = null; } return; }
    if (savedVol == null) savedVol = video.volume;
    video.volume = clamp(savedVol * level, 0, 1);
  }
  function setOriginal(target, video) {
    const now = performance.now(), dt = Math.min(200, now - (origT || now)); origT = now;
    if (Math.abs(target - origCur) < 0.004) { if (origCur !== target) { origCur = target; applyOriginal(origCur, video); } return; }
    origCur += (target - origCur) * (1 - Math.exp(-dt / (target < origCur ? 110 : 1100)));
    applyOriginal(origCur, video);
  }
  function stopSpeech() {
    if (speakingCount || safe(() => speechSynthesis.speaking)) safe(() => speechSynthesis.cancel());
    speakingCount = 0;
    if (ttsAudio) { safe(() => ttsAudio.pause()); ttsAudio = null; }
    waitUnit = -1;
  }
  function pickVoice() {
    const vs = voices();
    return vs.find(v => v.name === settings.ttsVoice) || vs.find(v => /natural|online|neural/i.test(v.name)) || vs[0] || null;
  }
  const hebrewSource = () => C.isHebrew(state.audioLang) && (state.audioConfidence === 'high' || state.audioConfidence === 'medium');
  const useAzure = () => settings.ttsEngine === 'azure' && !!settings.azureKey && !(azureError && Date.now() - azureErrorAt < 60000);
  const speaking = () => !!(ttsAudio && !ttsAudio.paused && !ttsAudio.ended) || speakingCount > 0;
  function resetAzure() { for (const e of azureCache.values()) if (e.url) safe(() => URL.revokeObjectURL(e.url)); azureCache.clear(); azureUnits = units; azureSig = sigOf(units); }
  function requestAzure(j) {
    if (azureCache.has(j)) return;
    const e = { st: 'loading', audio: null, dur: 0, url: '' };
    azureCache.set(j, e);
    const forSig = azureSig;
    const p = safe(() => chrome.runtime.sendMessage({ type: 'smartcc-tts', text: units[j].text, voice: settings.azureVoice }), null);
    if (!p || !p.then) { e.st = 'error'; return; }
    p.then(r => {
      if (forSig !== azureSig) return;
      if (!r || !r.ok) {
        e.st = 'error';
        if (r && (r.status === 401 || r.status === 403 || r.status === 0)) { azureError = r.msg || 'שגיאת מפתח'; azureErrorAt = Date.now(); }
        else if (r && r.status === 429) setTimeout(() => { if (azureCache.get(j) === e) azureCache.delete(j); }, 3000);
        return;
      }
      azureError = '';
      const bin = atob(r.b64); const bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      e.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      e.audio = new Audio(e.url); e.audio.preload = 'auto'; safe(() => { e.audio.preservesPitch = true; });
      e.audio.addEventListener('loadedmetadata', () => { if (isFinite(e.audio.duration)) e.dur = e.audio.duration; });
      e.st = 'ready';
    }).catch(() => { e.st = 'error'; });
  }
  function playAzure(j, at, video) {
    const e = azureCache.get(j), u = units[j];
    const vr = video.playbackRate || 1;
    const nextStart = units[j + 1] ? units[j + 1].start : u.end + 1500;
    const avail = Math.max(0.5, (nextStart - at) / 1000 / vr);
    const dur = e.dur || u.text.length / 14;
    const a = e.audio;
    if (ttsAudio && ttsAudio !== a) safe(() => ttsAudio.pause());
    safe(() => { a.currentTime = 0; });
    // מהירות לפי הטקסט בפועל: אם המשפט ארוך מהזמן שיש לו — מאיצים, כדי לא לפגר אחרי הסרטון
    a.playbackRate = clamp(Math.max(settings.ttsRate, dur / avail) * vr, 0.7, 2.2);
    a.volume = clamp(settings.ttsVolume / 100, 0, 1);
    ttsAudio = a;
    if (!tm.firstSpeakAt) tm.firstSpeakAt = Math.round(performance.now());
    safe(() => { const r = a.play(); if (r && r.catch) r.catch(() => { }); });
  }
  function speakBrowser(u, at, video) {
    const voice = pickVoice();
    if (!voice) return;
    // 3.0.7: סנכרון אמיתי — משפט חדש מתחיל בזמנו (הקודם נעצר, לא מצטבר פיגור),
    // והמהירות מחושבת לפי הזמן עד המשפט הבא ולפי קצב הדיבור שנמדד בפועל לקול הזה
    if (safe(() => speechSynthesis.speaking || speechSynthesis.pending)) { speechSynthesis.cancel(); speakingCount = 0; }
    const vr = video.playbackRate || 1;
    const k = units.indexOf(u);
    const nextStart = units[k + 1] ? units[k + 1].start : u.end + 800;
    const secs = Math.max(0.6, (Math.min(nextStart, u.end + 1500) - at) / 1000 / vr);
    const cps = voiceCps.get(voice.name) || 11; // תווים לשנייה במהירות 1 (מתעדכן מהמדידה)
    const needed = u.text.length / cps / secs;
    const ut = new SpeechSynthesisUtterance(u.text);
    ut.voice = voice; ut.lang = voice.lang;
    const rate = clamp(Math.max(settings.ttsRate * vr, needed * 1.05), 0.6, 3);
    ut.rate = rate;
    ut.volume = clamp(settings.ttsVolume / 100, 0, 1);
    let t0 = 0, cancelled = false;
    ut.onstart = () => { speakingCount++; t0 = performance.now(); if (!tm.firstSpeakAt) tm.firstSpeakAt = Math.round(t0); };
    ut.onend = () => {
      speakingCount = Math.max(0, speakingCount - 1);
      const el = (performance.now() - t0) / 1000;
      if (t0 && el > 0.8 && !cancelled) { const measured = u.text.length / (el * rate); voiceCps.set(voice.name, clamp((voiceCps.get(voice.name) || 11) * 0.6 + measured * 0.4, 5, 30)); }
    };
    ut.onerror = () => { cancelled = true; speakingCount = Math.max(0, speakingCount - 1); };
    speechSynthesis.speak(ut);
  }
  function ttsTick(video) {
    const on = ttsOn() && cues.length && cueVideo === state.videoId && !hebrewSource();
    if (!on) { if (speakingCount || ttsAudio) stopSpeech(); ttsIndex = -2; setOriginal(1, video); return; }
    if (azureUnits !== units) { if (sigOf(units) !== azureSig) resetAzure(); else azureUnits = units; }
    ensureGraph(video);
    const at = video.currentTime * 1000 - settings.offset * 1000;
    const jumped = Math.abs(at - lastAt) > 1500; lastAt = at;
    if (!video.paused && !tm.playAt) tm.playAt = Math.round(performance.now());
    // 3.0.14: מכינים את הקול של המשפטים הראשונים מיד כשהכתוביות מגיעות — עוד לפני שלוחצים על הפעלה — ומחממים את החיבור
    const i = C.lastStarted(units, at);
    const azure = useAzure();
    if (azure && warmedFor !== cueVideo) { warmedFor = cueVideo; safe(() => chrome.runtime.sendMessage({ type: 'smartcc-tts-warm' })); }
    if (azure) for (let j = Math.max(0, i); j < units.length && j <= i + 5 && units[j].start - at < 30000; j++) {
      if ([...azureCache.values()].filter(e => e.st === 'loading').length >= 3) break;
      requestAzure(j);
    }
    // עוצמת המקור: "רק דיבוב" = מושתק; משולב = יורד לרקע בזמן שהקול העברי מדבר
    const sp = speaking(); if (sp) lastSpeakAt = performance.now();
    const nx = units[i + 1];
    const soon = !!nx && nx.start - at < 350 && nx.start - at > -50 && (useAzure() || !!pickVoice());
    // 3.0.13: איזון — הקול של הדפדפן חלש, ולכן (באיזון אוטומטי) המקור יורד אליו עוד יותר. עוצמת הקריינות עצמה נקבעת ב-ttsVolume
    const duck = settings.ttsDuck / 100 * (settings.ttsAuto && !useAzure() ? 0.5 : 1);
    setOriginal(settings.ttsMode === 'only' ? 0 : ((sp || soon || performance.now() - lastSpeakAt < 450) ? duck : settings.ttsIdle / 100), video);
    if (ttsAudio && !ttsAudio.paused) ttsAudio.volume = clamp(settings.ttsVolume / 100, 0, 1);
    if (video.paused) {
      if (safe(() => speechSynthesis.speaking && !speechSynthesis.paused)) speechSynthesis.pause();
      if (ttsAudio && !ttsAudio.paused) safe(() => ttsAudio.pause());
      return;
    }
    if (safe(() => speechSynthesis.paused)) speechSynthesis.resume();
    if (ttsAudio && ttsAudio.paused && !ttsAudio.ended && ttsAudio.currentTime > 0) safe(() => { const r = ttsAudio.play(); if (r && r.catch) r.catch(() => { }); });
    if (jumped || ttsIndex === -2) {
      if (jumped) stopSpeech();
      // בתחילת סרטון / כשהכתוביות מגיעות באיחור: אם המשפט הנוכחי התחיל לפני רגע ויש עוד זמן — מקריאים אותו מיד (לא מחכים למשפט הבא)
      const cu = units[i];
      ttsIndex = (!jumped && i >= 0 && cu && at - cu.start < 5000 && cu.end - at > 1200) ? i - 1 : i;
      if (ttsIndex === i) return;   // אחרי דילוג ממתינים למשפט הבא
    }
    // משפט שהקול שלו עוד בהכנה — מנגנים ברגע שמוכן, אם עוד יש זמן
    if (waitUnit >= 0) {
      const e = azureCache.get(waitUnit), u = units[waitUnit];
      if (!u || at > u.end - 300 || !e) waitUnit = -1;
      else if (e.st === 'error') { speakBrowser(u, at, video); waitUnit = -1; }
      else if (e.st === 'ready') { playAzure(waitUnit, at, video); waitUnit = -1; }
    }
    if (i === ttsIndex || i < 0) return;
    ttsIndex = i;
    const u = units[i];
    if (at > u.end - 200) return;
    if (azure) {
      const e = azureCache.get(i);
      if (e && e.st === 'ready') playAzure(i, at, video);
      else if (e && e.st === 'error') speakBrowser(u, at, video);
      else waitUnit = i;
      return;
    }
    speakBrowser(u, at, video);
  }
  safe(() => speechSynthesis.addEventListener('voiceschanged', () => refreshPanel()));
  window.addEventListener('pagehide', stopSpeech);

  /* ---------- לולאות ---------- */
  let resizeObs = null;
  setInterval(() => {
    if (!alive) return;
    const p = document.querySelector('#movie_player');
    if (!p) return;
    if (p !== player || !host || !host.isConnected || (host.parentElement === p && newUiControls(p))) {
      mount(p);
      if (resizeObs) resizeObs.disconnect();
      resizeObs = new ResizeObserver(() => { paint(); positionPanel(); });
      resizeObs.observe(p);
    }
    integrate();
  }, 300);
  let last = 0;
  const loop = t => { if (t - last > 45) { last = t; try { frame(); } catch (err) { const m = 'frame: ' + String(err && err.stack || err).slice(0, 300); if (errors[errors.length - 1] !== m) errors.push(m); } } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
})();

}
if (document.documentElement) startContent();
else document.addEventListener("DOMContentLoaded", startContent, { once: true });
})();
