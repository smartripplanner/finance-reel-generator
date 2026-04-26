"use strict";

/**
 * services/devanagariConverter.js
 *
 * Stage 2 of the permanent Hinglish reel architecture.
 *
 * ROOT CAUSE THIS SOLVES:
 *   Roman Hindi (e.g. "galti") is ambiguous for TTS engines — they guess
 *   the pronunciation using English phoneme rules and get it wrong.
 *   Devanagari (e.g. "गलती") is unambiguous — every Hindi TTS engine on
 *   earth pronounces it perfectly with zero configuration.
 *
 * HOW IT WORKS:
 *   1. Script is generated in Roman Hinglish (for slide readability).
 *   2. This converter replaces ONLY known Hindi words with their Devanagari
 *      equivalents before the text goes to ElevenLabs.
 *   3. ElevenLabs multilingual_v2 reads English words in English and
 *      Devanagari words in Hindi — seamlessly, with no phonetic hacks.
 *
 * WHAT IS NOT TOUCHED:
 *   - English words (SIP, FD, EMI, invest, returns, inflation…)
 *   - Numbers (500, 10,000…)
 *   - Punctuation and pause markers (. ! ? … ,)
 *   - Already-converted Devanagari
 *
 * SLIDE TEXT:
 *   The scene.text field (used by the renderer for on-screen text) is NEVER
 *   modified. Only the TTS narration string gets Devanagari conversion.
 *   Roman Hindi reads faster on screen — viewers don't need Devanagari.
 *
 * LEARNING SYSTEM:
 *   If a word still sounds wrong after conversion, log it with logFailedWord().
 *   It's saved to data/tts_failed_words.json for review. Fix it by either:
 *   a) Adding the Devanagari mapping here, OR
 *   b) Adding the word to the "never write" list in the Gemini prompt.
 */

const fs   = require("fs");
const path = require("path");

const FAILED_WORDS_PATH = path.join(__dirname, "..", "data", "tts_failed_words.json");

// ─────────────────────────────────────────────────────────────────────────────
// DEVANAGARI DICTIONARY
// Hindi/Hinglish Roman words → Devanagari equivalent.
// Sorted by word length descending so longer entries are tried first
// (prevents partial matches when a phrase contains a shorter word).
//
// RULES for this dictionary:
//   • Only include words that regularly appear in Hindi speech
//   • Never include English finance terms (SIP, FD, EMI, fund, returns…)
//   • Never include pure English words that happen to look like Hindi
//   • Add new words at the bottom — they'll be auto-sorted at startup
// ─────────────────────────────────────────────────────────────────────────────
const RAW_DICTIONARY = {
  // ── Connectors & grammar ────────────────────────────────────────────────
  "kyunki":    "क्योंकि",
  "zaroorat":  "ज़रूरत",
  "crorepati": "करोड़पति",
  "milenge":   "मिलेंगे",
  "chahiye":   "चाहिए",
  "samajhna":  "समझना",
  "isliye":    "इसलिए",
  "isiliye":   "इसलिए",
  "lekin":     "लेकिन",
  "shayad":    "शायद",
  "zaroor":    "ज़रूर",
  "rupaye":    "रुपये",
  "hazaar":    "हज़ार",
  "milega":    "मिलेगा",
  "milegi":    "मिलेगी",
  "bachao":    "बचाओ",
  "batao":     "बताओ",
  "samjho":    "समझो",
  "rakhna":    "रखना",
  "seedha":    "सीधा",
  "banana":    "बनाना",
  "seekho":    "सीखो",
  "chalna":    "चलना",
  "badhna":    "बढ़ना",
  "hamesha":   "हमेशा",
  "zyada":     "ज़्यादा",
  "kaafi":     "काफ़ी",
  "accha":     "अच्छा",
  "achha":     "अच्छा",
  "jaldi":     "जल्दी",
  "kharch":    "खर्च",
  "bachat":    "बचत",
  "nivesh":    "निवेश",
  "mahina":    "महीना",
  "mahine":    "महीने",
  "tarika":    "तरीक़ा",
  "galti":     "गलती",
  "shuruaat":  "शुरुआत",
  "shuru":     "शुरू",
  "dekho":     "देखो",
  "sunno":     "सुनो",
  "socho":     "सोचो",
  "likhо":     "लिखो",
  "bhejo":     "भेजो",
  "karna":     "करना",
  "karte":     "करते",
  "karta":     "करता",
  "karti":     "करती",
  "karein":    "करें",
  "ameer":     "अमीर",
  "garib":     "ग़रीब",
  "paisa":     "पैसा",
  "paise":     "पैसे",
  "dost":      "दोस्त",
  "aapka":     "आपका",
  "apna":      "अपना",
  "apni":      "अपनी",
  "apne":      "अपने",
  "tumhara":   "तुम्हारा",
  "tumhari":   "तुम्हारी",
  "tumhare":   "तुम्हारे",
  "hamara":    "हमारा",
  "humara":    "हमारा",
  "fayda":     "फ़ायदा",
  "nuksan":    "नुकसान",
  "nuksaan":   "नुकसान",
  "byaj":      "ब्याज",
  "sood":      "सूद",
  "crore":     "करोड़",
  "lakh":      "लाख",
  "hoga":      "होगा",
  "hogi":      "होगी",
  "honge":     "होंगे",
  "hota":      "होता",
  "hoti":      "होती",
  "hote":      "होते",
  "sakta":     "सकता",
  "sakti":     "सकती",
  "sakte":     "सकते",
  "rehta":     "रहता",
  "rehti":     "रहती",
  "rehte":     "रहते",
  "raho":      "रहो",
  "karo":      "करो",
  "kar":       "कर",
  "likho":     "लिखो",
  "suno":      "सुनो",
  "aao":       "आओ",
  "jao":       "जाओ",
  "bano":      "बनो",
  "nahi":      "नहीं",
  "nahin":     "नहीं",
  "sirf":      "सिर्फ़",
  "abhi":      "अभी",
  "phir":      "फिर",
  "kyun":      "क्यों",
  "kyon":      "क्यों",
  "kuch":      "कुछ",
  "kaash":     "काश",
  "pehle":     "पहले",
  "baad":      "बाद",
  "haan":      "हाँ",
  "bilkul":    "बिल्कुल",
  "pakka":     "पक्का",
  "sach":      "सच",
  "jhooth":    "झूठ",
  "aaj":       "आज",
  "kal":       "कल",
  "roz":       "रोज़",
  "din":       "दिन",
  "saal":      "साल",
  "kaam":      "काम",
  "ameer":     "अमीर",
  "yaad":      "याद",
  "sahi":      "सही",
  "galat":     "ग़लत",
  "bura":      "बुरा",
  "thoda":     "थोड़ा",
  "bahut":     "बहुत",
  "kafi":      "काफ़ी",
  "poora":     "पूरा",
  "pura":      "पूरा",
  "toh":       "तो",
  "aur":       "और",
  "lekin":     "लेकिन",
  "magar":     "मगर",
  "agar":      "अगर",
  "yadi":      "यदि",
  "kya":       "क्या",
  "kaun":      "कौन",
  "kahan":     "कहाँ",
  "kaise":     "कैसे",
  "kitna":     "कितना",
  "kitni":     "कितनी",
  "kitne":     "कितने",
  "jab":       "जब",
  "tab":       "तब",
  "yahan":     "यहाँ",
  "wahan":     "वहाँ",
  "aisa":      "ऐसा",
  "waisa":     "वैसा",
  "kaisa":     "कैसा",
  "log":       "लोग",
  "logo":      "लोगों",
  "sab":       "सब",
  "sabhi":     "सभी",
  "koi":       "कोई",
  "har":       "हर",
  "dono":      "दोनों",
  "sabse":     "सबसे",
  "sirf":      "सिर्फ़",
  "bas":       "बस",
  "mat":       "मत",
  "hi":        "ही",
  "bhi":       "भी",
  "ya":        "या",
  "hai":       "है",
  "hain":      "हैं",
  "tha":       "था",
  "thi":       "थी",
  "the":       "थे",
  "ho":        "हो",
  "se":        "से",
  "mein":      "में",
  "ko":        "को",
  "ka":        "का",
  "ki":        "की",
  "ke":        "के",
  "ne":        "ने",
  "par":       "पर",

  // ── Demonstratives & common determiners ─────────────────────────────────
  "yeh":       "यह",
  "yeh":       "यह",
  "woh":       "वह",
  "iska":      "इसका",
  "iski":      "इसकी",
  "iske":      "इसके",
  "uska":      "उसका",
  "uski":      "उसकी",
  "uske":      "उसके",
  "inhe":      "इन्हें",
  "unhe":      "उन्हें",
  "ek":        "एक",
  "do":        "दो",

  // ── Postpositions / particles ────────────────────────────────────────────
  "liye":      "लिए",
  "saath":     "साथ",
  "baare":     "बारे",
  "baat":      "बात",
  "baad":      "बाद",
  "pehle":     "पहले",
  "zariye":    "ज़रिए",
  "taraf":     "तरफ़",

  // ── Verbs (present stem / infinitive forms) ───────────────────────────────
  "sochte":    "सोचते",
  "sochna":    "सोचना",
  "kholo":     "खोलो",
  "kholo":     "खोलो",
  "dikhao":    "दिखाओ",
  "dekhna":    "देखना",
  "khelna":    "खेलना",
  "likhna":    "लिखना",
  "padhna":    "पढ़ना",
  "badho":     "बढ़ो",
  "chalte":    "चलते",
  "sochke":    "सोचकर",
  "karke":     "करके",
  "lekar":     "लेकर",
  "dekar":     "देकर",
  "karoge":    "करोगे",
  "karogi":    "करोगी",
  "karenge":   "करेंगे",
  "karengi":   "करेंगी",
  "rahega":    "रहेगा",
  "rahegi":    "रहेगी",
  "rahenge":   "रहेंगे",

  // ── Common nouns ─────────────────────────────────────────────────────────
  "zindagi":   "ज़िंदगी",
  "duniya":    "दुनिया",
  "sapna":     "सपना",
  "sapne":     "सपने",
  "samay":     "समय",
  "waqt":      "वक़्त",
  "jagah":     "जगह",
  "cheez":     "चीज़",
  "cheezen":   "चीज़ें",
  "insaan":    "इंसान",
  "baccha":    "बच्चा",
  "ghar":      "घर",
  "rishta":    "रिश्ता",
  "desh":      "देश",
  "bharat":    "भारत",
  "bank":      "बैंक",

  // ── Intensifiers / adverbs ────────────────────────────────────────────────
  "bilkul":    "बिल्कुल",
  "zyada":     "ज़्यादा",
  "thodi":     "थोड़ी",
  "thode":     "थोड़े",
  "bohot":     "बहुत",
  "ekdum":     "एकदम",
  "seedhe":    "सीधे",
  "sidha":     "सीधा",
  "jab":       "जब",
  "tab":       "तब",
  "kabhi":     "कभी",
  "shayad":    "शायद",
};

// ── Build sorted entries: longest words first (prevents partial matches) ──────
const SORTED_ENTRIES = Object.entries(RAW_DICTIONARY)
  .sort((a, b) => b[0].length - a[0].length);

// Pre-compile one regex per entry for performance
const COMPILED_PATTERNS = SORTED_ENTRIES.map(([roman, devanagari]) => ({
  regex:      new RegExp(`\\b${escapeRegex(roman)}\\b`, "gi"),
  devanagari,
  roman,
}));

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * hasDevanagari(text) — quick check if text already contains Devanagari.
 */
function hasDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

/**
 * convertLine(text) → string
 *
 * Converts Roman Hindi words in one line to Devanagari.
 * English, numbers, and punctuation are preserved.
 * Words already in Devanagari are skipped.
 */
function convertLine(text) {
  if (!text || typeof text !== "string") return text;

  let result = text;
  let wordsConverted = 0;

  for (const { regex, devanagari } of COMPILED_PATTERNS) {
    // Reset lastIndex for global regex on each line
    regex.lastIndex = 0;
    if (regex.test(result)) {
      regex.lastIndex = 0;
      result = result.replace(regex, devanagari);
      wordsConverted++;
    }
    regex.lastIndex = 0;
  }

  return result;
}

/**
 * convertNarration(narrationText) → string
 *
 * Converts a full narration string (with pause markers) to Devanagari.
 * This is the string that goes to ElevenLabs — NOT the slide text.
 *
 * Preserves:
 *   - Pause markers (. ... .. , — !)
 *   - English words (SIP, FD, EMI, returns, inflation, etc.)
 *   - Numbers (500, 10,000, 7%, etc.)
 *   - Existing Devanagari
 */
function convertNarration(narrationText) {
  if (!narrationText || typeof narrationText !== "string") return narrationText;

  // Convert line by line to preserve pause structure
  // The narration has natural sentence breaks via ". " and "... "
  const lines = narrationText.split(/(?<=[.!?…]{1,3})\s+/);
  const converted = lines.map(line => convertLine(line)).join(" ");

  // Count words converted for debug
  const originalWords  = narrationText.match(/\b[a-zA-Z]+\b/g)?.length || 0;
  const remainingEnglish = converted.match(/\b[a-zA-Z]+\b/g)?.length || 0;
  const wordsConverted = originalWords - remainingEnglish;

  console.log(
    `[DevanagariConverter] ${originalWords} English words → ${wordsConverted} converted to Devanagari` +
    ` | ${remainingEnglish} English preserved`
  );

  return converted;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEARNING SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * logFailedWord(word, context, note)
 *
 * Call this when a word still sounds wrong after Devanagari conversion.
 * Saves to data/tts_failed_words.json for review.
 *
 * Fix options after reviewing:
 *   a) Add the word to RAW_DICTIONARY above (will convert to Devanagari)
 *   b) Add the word to the "never write" list in the Gemini prompt
 *      (prevents the AI from generating the problem word at all)
 */
function logFailedWord(word, context = "", note = "") {
  try {
    let data = { failed_words: [] };
    if (fs.existsSync(FAILED_WORDS_PATH)) {
      data = JSON.parse(fs.readFileSync(FAILED_WORDS_PATH, "utf8"));
      if (!Array.isArray(data.failed_words)) data.failed_words = [];
    }

    // Don't add duplicates
    const exists = data.failed_words.some(e => e.word === word);
    if (!exists) {
      data.failed_words.push({
        word,
        context,
        note,
        reported_date: new Date().toISOString().slice(0, 10),
        status: "pending_fix",
      });
      fs.writeFileSync(FAILED_WORDS_PATH, JSON.stringify(data, null, 2), "utf8");
      console.log(`[DevanagariConverter] Failed word logged: "${word}"`);
    }
  } catch (e) {
    console.warn(`[DevanagariConverter] Could not log failed word: ${e.message}`);
  }
}

/**
 * getFailedWords() → array
 * Returns all logged failed words for the admin panel.
 */
function getFailedWords() {
  try {
    if (!fs.existsSync(FAILED_WORDS_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(FAILED_WORDS_PATH, "utf8"));
    return Array.isArray(data.failed_words) ? data.failed_words : [];
  } catch {
    return [];
  }
}

/**
 * getDictionary() → object
 * Returns the full dictionary for inspection/admin UI.
 */
function getDictionary() {
  return { ...RAW_DICTIONARY };
}

/**
 * getDictionarySize() → number
 */
function getDictionarySize() {
  return Object.keys(RAW_DICTIONARY).length;
}

module.exports = {
  convertLine,
  convertNarration,
  hasDevanagari,
  logFailedWord,
  getFailedWords,
  getDictionary,
  getDictionarySize,
};
