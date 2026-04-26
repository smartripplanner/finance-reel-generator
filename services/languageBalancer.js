"use strict";

/**
 * services/languageBalancer.js
 *
 * Enforces 70% English / 30% Hindi language ratio in generated scripts.
 * Replaces TTS-dangerous Hindi constructs while keeping emotional Hinglish words.
 *
 * Public API:
 *   analyzeLanguageRatio(text)          → { englishWords, hindiWords, total, englishPct, hindiPct, ratio }
 *   replaceRiskyHindi(text)             → string
 *   rebalanceTo7030(text, options)      → { text, changes }
 *   scoreNaturalness(text)              → 0-100
 *   optimizeScene(sceneText, purpose)  → { text, report }
 *   optimizeScript(scenes)             → { scenes, report }
 */

// ── Emotional Hindi — always keep these, never replace ───────────────────────
// These are natural Hinglish words with low TTS risk that sound authentic
const EMOTIONAL_HINDI_KEEP = new Set([
  "paisa","paise","paisay",
  "galti","galthi",
  "abhi","aaj","kal","phir","sirf","bas","toh","bhi","aur","ya","nahi","nahin",
  "haan","ha","na","mat",
  "log","logo","logon",
  "fayda","faydaa","nuksan",
  "sach","sachchi","sachch",
  "time","kaam","din","raat","saal","mahina","ghanta",
  "pura","poora","thoda","thodi","zyada","kam",
  "seedha","sidha","asaan","mushkil",
  "smart","simple",   // these are English anyway
  "dost","yaar",
  "jaldi","dhire",
  "bilkul","ekdum","zaroor","zaruri",
  "sahi","galat",
  "mast","zabardast","kamaal",
]);

// ── Clearly Hindi words (TTS-risky or structurally Hindi) ────────────────────
// Word → suggested English replacement (or null = just flag, use context)
const HINDI_WORD_MAP = new Map([
  // Pronouns
  ["mera",     "my"],
  ["meri",     "my"],
  ["mere",     "my"],
  ["tumhara",  "your"],
  ["tumhari",  "your"],
  ["tumhare",  "your"],
  ["aapka",    "your"],
  ["aapki",    "your"],
  ["aapke",    "your"],
  ["hamara",   "our"],
  ["hamari",   "our"],
  ["hamare",   "our"],
  ["unka",     "their"],
  ["unki",     "their"],
  ["unke",     "their"],
  ["iska",     "its"],
  ["iski",     "its"],
  ["iske",     "its"],
  ["woh",      "they"],
  ["wo",       "they"],
  ["yeh",      "this"],
  ["ye",       "this"],
  ["wahan",    "there"],
  ["yahan",    "here"],

  // Common verbs / imperatives with HIGH TTS risk
  ["karo",     "do it"],
  ["karna",    "do"],
  ["karein",   "do"],
  ["karte",    "do"],
  ["karta",    "does"],
  ["karti",    "does"],
  ["kar",      "do"],
  ["lena",     "take"],
  ["lo",       "take"],
  ["loge",     "will take"],
  ["dena",     "give"],
  ["do",       null],          // ambiguous, skip auto-replace
  ["doge",     "will give"],
  ["rakhna",   "keep"],
  ["rakho",    "keep"],
  ["banana",   null],          // ambiguous (food word in English too)
  ["banao",    "build"],
  ["bano",     "become"],
  ["banta",    "makes sense"],
  ["banti",    "makes sense"],
  ["chahiye",  "need"],
  ["chahie",   "need"],
  ["milega",   "will get"],
  ["milegi",   "will get"],
  ["mile",     "will get"],
  ["milta",    "gets"],
  ["milti",    "gets"],
  ["hoga",     "will be"],
  ["hogi",     "will be"],
  ["honge",    "will be"],
  ["hota",     "is"],
  ["hoti",     "is"],
  ["hote",     "are"],
  ["rehta",    "stays"],
  ["rehti",    "stays"],
  ["rehte",    "stay"],
  ["raho",     "stay"],
  ["reh",      "stay"],
  ["jaana",    "go"],
  ["jao",      "go"],
  ["jata",     "goes"],
  ["aana",     "come"],
  ["aao",      "come"],
  ["aata",     "comes"],

  // Nouns — structural Hindi (replace with English equivalent)
  ["ghar",     "home"],
  ["parivaar", "family"],
  ["parivar",  "family"],
  ["bacche",   "kids"],
  ["bachche",  "kids"],
  ["bachcha",  "kid"],
  ["beti",     "daughter"],
  ["beta",     "son"],
  ["maa",      "mother"],
  ["baap",     "father"],
  ["bhai",     "brother"],
  ["behan",    "sister"],
  ["naukri",   "job"],
  ["rozgaar",  "income"],
  ["karobaar", "business"],
  ["vyapar",   "business"],
  ["bhavishya","future"],
  ["sapna",    "dream"],
  ["sapne",    "dreams"],
  ["zindagi",  "life"],
  ["jindagi",  "life"],
  ["duniya",   "world"],
  ["desh",     "country"],
  ["sheher",   "city"],
  ["gaon",     "village"],
  ["shaadi",   "marriage"],
  ["retirement","retirement"], // keep as-is
  ["shiksha",  "education"],
  ["padhai",   "education"],
  ["sehat",    "health"],
  ["doctor",   null],          // English word
  ["hospital", null],          // English word
  ["pehchaan", "identity"],
  ["azaadi",   "freedom"],
  ["taakat",   "power"],
  ["himmat",   "courage"],
  ["hausla",   "confidence"],

  // TTS-risky question starters
  ["kya",      null],          // context-dependent
  ["kyun",     "why"],
  ["kyunki",   "because"],
  ["kaise",    "how"],
  ["kaisa",    "how"],
  ["kaisi",    "how"],
  ["kab",      "when"],
  ["kahan",    "where"],
  ["kitna",    "how much"],
  ["kitni",    "how much"],
  ["kitne",    "how many"],
  ["kaun",     "who"],
  ["kauns",    "which"],
  ["konsa",    "which"],
  ["konsi",    "which"],

  // Connectors / structural
  ["isliye",   "so"],
  ["isiliye",  "so"],
  ["lekin",    "but"],
  ["magar",    "but"],
  ["par",      null],          // ambiguous (but/on)
  ["alag",     "different"],
  ["sath",     "with"],
  ["saath",    "with"],
  ["bina",     "without"],
  ["baad",     "after"],
  ["pehle",    "before"],
  ["pahle",    "before"],
  ["baad mein","later"],
  ["pehle se", "already"],
  ["sab",      "all"],
  ["sabhi",    "everyone"],
  ["kuch",     "some"],
  ["koi",      "someone"],
  ["har",      "every"],
  ["dono",     "both"],
  ["teeno",    "all three"],

  // Finance-specific Hindi that causes TTS issues
  ["mutthi",   "control"],
  ["haath",    "hands"],
  ["andar",    "inside"],
  ["bahar",    "outside"],
  ["upar",     "above"],
  ["niche",    "below"],
  ["zyada",    "more"],        // keep or replace — often fine
  ["behtar",   "better"],
  ["sabse",    "most"],
  ["aise",     "like this"],
  ["waisa",    "like that"],
  ["tarah",    "like"],
  ["tarike",   "ways"],
  ["tarika",   "way"],
  ["matlab",   "meaning"],
  ["fark",     "difference"],
  ["faraq",    "difference"],
  ["sochna",   "think"],
  ["socho",    "think"],
  ["samajhna", "understand"],
  ["seekhna",  "learn"],
  ["dekhna",   "see"],
  ["sunna",    "listen"],
  ["padna",    "read"],
  ["likhna",   "write"],
  ["bolna",    "speak"],
]);

// ── Risky PHRASES to replace wholesale ───────────────────────────────────────
// Ordered longest first (matched before individual words)
const RISKY_PHRASE_REPLACEMENTS = [
  // Pronouns + context
  [/\btumhare\s+ghar\s+mein\b/gi,      "in your home"],
  [/\btumhari\s+zindagi\s+mein\b/gi,   "in your life"],
  [/\baapke\s+ghar\s+mein\b/gi,        "in your home"],
  [/\baapki\s+life\s+mein\b/gi,        "in your life"],
  [/\bhamare\s+desh\s+mein\b/gi,       "in our country"],
  [/\bmere\s+sath\b/gi,                "with me"],
  [/\bapne\s+sath\b/gi,                "with yourself"],
  // *liye combinations — must come before standalone pronoun rewrites
  [/\btumhare\s+liye\b/gi,             "for you"],
  [/\btumhari\s+liye\b/gi,             "for you"],
  [/\baapke\s+liye\b/gi,               "for you"],
  [/\baapki\s+liye\b/gi,               "for you"],
  [/\bhamare\s+liye\b/gi,              "for us"],
  [/\bhamare\s+liye\b/gi,              "for us"],
  [/\bmere\s+liye\b/gi,                "for me"],
  [/\bunke\s+liye\b/gi,                "for them"],

  // Finance phrases
  [/\bmutthi\s+mein\b/gi,              "in control"],
  [/\bhaath\s+mein\b/gi,               "in hand"],
  [/\bpaisa\s+kaam\s+kare\b/gi,        "money works"],
  [/\bpaisa\s+kamaao\b/gi,             "earn money"],
  [/\bpaisa\s+bachao\b/gi,             "save money"],
  [/\bpaisa\s+lagao\b/gi,              "invest money"],
  [/\bpaisa\s+badhao\b/gi,             "grow money"],
  [/\bpaisa\s+barhao\b/gi,             "grow money"],
  [/\bnuksan\s+se\s+bachao\b/gi,       "avoid losses"],
  [/\bsabse\s+bada\s+galti\b/gi,       "the biggest mistake"],
  [/\bsabse\s+badi\s+galti\b/gi,       "the biggest mistake"],

  // Question starters (hooks) — make English
  [/^kya\s+aap\b/gi,                   "Do you"],
  [/^kya\s+aapko\b/gi,                 "Do you"],
  [/^kya\s+aapne\b/gi,                 "Have you"],
  [/^kya\s+tumhe\b/gi,                 "Do you"],
  [/^kya\s+tumhare\b/gi,               "Does your"],
  [/\bkya\s+aap\s+jaante\s+hain\b/gi, "do you know"],
  [/\bkya\s+aapko\s+pata\s+hai\b/gi,  "do you know"],
  [/\bkya\s+aap\s+sochte\s+hain\b/gi, "do you think"],

  // Structural Hindi
  [/\bkyunki\s+yeh\b/gi,               "because this"],
  [/\bisliye\s+aap\b/gi,               "so you"],
  [/\bisliye\s+hum\b/gi,               "so we"],
  [/\baaj\s+se\s+hi\b/gi,              "starting today"],
  [/\babhi\s+se\b/gi,                  "from now"],
  [/\bpehle\s+se\s+hi\b/gi,            "already"],
  [/\bbaad\s+mein\b/gi,                "later"],
  [/\bpehle\s+se\b/gi,                 "before"],

  // CTA risky patterns
  [/\bfollow\s+karo\b/gi,              "follow us"],
  [/\bshare\s+karo\b/gi,               "share this"],
  [/\bsave\s+karo\b/gi,                "save this"],
  [/\blike\s+karo\b/gi,                "like this"],
  [/\bcomment\s+karo\b/gi,             "comment below"],
  [/\bsubscribe\s+karo\b/gi,           "subscribe"],
  [/\bnotification\s+on\s+karo\b/gi,  "turn on notifications"],
  [/\bbell\s+icon\s+dabao\b/gi,        "hit the bell icon"],
];

// ── PRONOUN rewrite table (standalone word, case-insensitive) ─────────────────
const PRONOUN_REWRITES = [
  [/\btumhara\b/gi, "your"],
  [/\btumhari\b/gi, "your"],
  [/\btumhare\b/gi, "your"],
  [/\baapka\b/gi,   "your"],
  [/\baapki\b/gi,   "your"],
  [/\baapke\b/gi,   "your"],
  [/\bmera\b/gi,    "my"],
  [/\bmeri\b/gi,    "my"],
  [/\bmere\b/gi,    "my"],
  [/\bhamara\b/gi,  "our"],
  [/\bhamari\b/gi,  "our"],
  [/\bhamare\b/gi,  "our"],
  [/\bunka\b/gi,    "their"],
  [/\bunki\b/gi,    "their"],
  [/\bunke\b/gi,    "their"],
];

// ── Structural connector rewrites ─────────────────────────────────────────────
const CONNECTOR_REWRITES = [
  [/\bkyunki\b/gi,  "because"],
  [/\bkyunkee\b/gi, "because"],
  [/\bisliye\b/gi,  "so"],
  [/\bisiliye\b/gi, "so"],
  [/\blekin\b/gi,   "but"],
  [/\bmagar\b/gi,   "but"],
  [/\baur\s+bhi\b/gi, "and also"],
  [/\bwarna\b/gi,   "otherwise"],
  [/\bnahi\s+toh\b/gi, "otherwise"],
  [/\bnahin\s+toh\b/gi, "otherwise"],
  [/\bjab\s+bhi\b/gi, "whenever"],
  [/\bjab\s+tak\b/gi, "until"],
  [/\bjab\b/gi,     "when"],
  [/\bbehtar\b/gi,  "better"],
  [/\bsabse\b/gi,   "the most"],
];

// ── TTS-risky imperative rewrites ─────────────────────────────────────────────
const IMPERATIVE_REWRITES = [
  [/\bsuno\b/gi,    "listen"],
  [/\bdekho\b/gi,   "look"],
  [/\bsocho\b/gi,   "think about it"],
  [/\bsamjho\b/gi,  "understand this"],
  [/\bsikho\b/gi,   "learn"],
  [/\bbatao\b/gi,   "tell us"],
  [/\bbachao\b/gi,  "save"],
  [/\bbano\b/gi,    "become"],
  [/\bbanao\b/gi,   "build"],
  [/\bkaro\b/gi,    "do it"],
  [/\braho\b/gi,    "stay"],
  [/\bchalo\b/gi,   "let's go"],
  [/\bsochna\b/gi,  "think"],
  [/\bdekhna\b/gi,  "look at"],
  [/\bsunna\b/gi,   "listen to"],
  [/\bsekhna\b/gi,  "learn"],
  [/\bpadhna\b/gi,  "read"],
];

// ── Noun rewrites ─────────────────────────────────────────────────────────────
const NOUN_REWRITES = [
  [/\bghar\b/gi,     "home"],
  [/\bzindagi\b/gi,  "life"],
  [/\bjindagi\b/gi,  "life"],
  [/\bduniya\b/gi,   "world"],
  [/\bnaukri\b/gi,   "job"],
  [/\bkarobaar\b/gi, "business"],
  [/\bvyapar\b/gi,   "business"],
  [/\bshiksha\b/gi,  "education"],
  [/\bpadhai\b/gi,   "education"],
  [/\bsehat\b/gi,    "health"],
  [/\bsapna\b/gi,    "dream"],
  [/\bsapne\b/gi,    "dreams"],
  [/\bbhavishya\b/gi,"future"],
  [/\bparivar\b/gi,  "family"],
  [/\bparivaar\b/gi, "family"],
  [/\bmutthi\b/gi,   "control"],
  [/\btarika\b/gi,   "way"],
  [/\btarike\b/gi,   "ways"],
  [/\bfark\b/gi,     "difference"],
  [/\bfaraq\b/gi,    "difference"],
  [/\bmatlab\b/gi,   "meaning"],
  [/\bmazboot\b/gi,  "strong"],
];

// ── Hindi word detection (for ratio analysis) ─────────────────────────────────
// All known Hindi/Hinglish Roman words that are NOT English
const ALL_HINDI_WORDS = new Set([
  ...EMOTIONAL_HINDI_KEEP,
  ...[...HINDI_WORD_MAP.keys()],
  // Additional detection-only words (not auto-replaced)
  "hai","hain","ho","hun","hoon","tha","thi","the","tha",
  "se","mein","par","ko","ka","ki","ke","ne","pe","tak","bhi",
  "aur","ya","toh","phir","jo","jis","jab","jaise","jahan",
  "ek","do","teen","char","paanch","chhe","saat","aath","nau","das",
  "pehla","pehli","pehle","doosra","doosri","teesra",
  "naya","nayi","naye","purana","purani",
  "bada","badi","bade","chota","choti","chhota","chhoti",
  "accha","achcha","achchi","acchi","bura","buri",
  "theek","bilkul","zaroor","zaruri","pakka","pakki",
  "wala","wali","wale","waala","waali","waale",
  "walein","walein",
  "suno","dekho","socho","samjho","sikho","batao","bachao","chalo",
  "karo","lena","dena","rakhna","banana","chalana","dekhna","sunna",
  "hoga","hogi","honge","hua","hui","hue",
  "mila","mili","mile","milega","milegi",
  "kar","kiya","kiye","kari","karein","karte","karta","karti",
  "aaya","aayi","aaye","aana","jana","gaya","gayi","gaye",
  "liya","liye","legi","lega","loge","diya","diye","degi","dega",
  "raha","rahi","rahe","rehna","rehta","rehti","rehte",
  "sochna","samajhna","seekhna","dekhna","bolna","sunna",
  "chhod","chod","chhodna","chodna",
  "poora","puri","poori","adha","aadha","aadhi",
  "sath","saath","bina","agar","yadi","phir","kyun","kyu",
  "warna","waise","tarah","tarike","taraf","jagah",
  "dono","sab","sabhi","kuch","koi","har","sirf","bas",
  "hi","bhi","toh","na","mat","haan","nahin","nahi",
]);

// ─────────────────────────────────────────────────────────────────────────────
// CORE FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokenize text into words (preserves punctuation attached to words).
 */
function tokenize(text) {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Clean a token to its bare word (remove punctuation) for lookup.
 */
function bareWord(token) {
  return token.replace(/[^a-zA-Z0-9\u0900-\u097F'-]/g, "").toLowerCase();
}

/**
 * analyzeLanguageRatio(text)
 * Returns detailed stats about the English/Hindi ratio in a text.
 */
function analyzeLanguageRatio(text) {
  if (!text || !text.trim()) {
    return { englishWords: 0, hindiWords: 0, total: 0, englishPct: 100, hindiPct: 0, ratio: "100/0" };
  }

  const tokens  = tokenize(text);
  const total   = tokens.length;
  if (total === 0) return { englishWords: 0, hindiWords: 0, total: 0, englishPct: 100, hindiPct: 0, ratio: "100/0" };

  let hindiCount   = 0;
  let englishCount = 0;

  for (const token of tokens) {
    const w = bareWord(token);
    if (!w) continue;

    // Numbers are neutral
    if (/^\d/.test(w)) { englishCount++; continue; }

    if (ALL_HINDI_WORDS.has(w)) {
      hindiCount++;
    } else {
      englishCount++;
    }
  }

  const englishPct = Math.round((englishCount / total) * 100);
  const hindiPct   = Math.round((hindiCount   / total) * 100);

  return {
    englishWords: englishCount,
    hindiWords:   hindiCount,
    total,
    englishPct,
    hindiPct,
    ratio: `${englishPct}/${hindiPct}`,
  };
}

/**
 * replaceRiskyHindi(text)
 * Applies pronoun, connector, imperative, and noun rewrites.
 * Preserves EMOTIONAL_HINDI_KEEP words.
 * Returns { text, changes } where changes is array of { from, to }.
 */
function replaceRiskyHindi(text) {
  if (!text) return { text: "", changes: [] };

  const changes = [];
  let result = text;

  // Helper to apply a list of pattern pairs, recording changes
  function applyRewrites(pairs, label) {
    for (const [pattern, replacement] of pairs) {
      result = result.replace(pattern, (match) => {
        // Don't replace if the bare word is in EMOTIONAL_HINDI_KEEP
        const w = bareWord(match);
        if (EMOTIONAL_HINDI_KEEP.has(w)) return match;
        changes.push({ from: match, to: replacement, type: label });
        return replacement;
      });
    }
  }

  // Order matters: phrases first, then words
  applyRewrites(RISKY_PHRASE_REPLACEMENTS, "phrase");
  applyRewrites(PRONOUN_REWRITES,         "pronoun");
  applyRewrites(CONNECTOR_REWRITES,       "connector");
  applyRewrites(IMPERATIVE_REWRITES,      "imperative");
  applyRewrites(NOUN_REWRITES,            "noun");

  return { text: result, changes };
}

/**
 * rebalanceTo7030(text, options)
 * If Hindi% > 35, aggressively replaces more Hindi.
 * options.targetHindi: float 0-1, default 0.30
 * Returns { text, changes, before, after }
 */
function rebalanceTo7030(text, options = {}) {
  const targetHindiPct = Math.round((options.targetHindi ?? 0.30) * 100);

  const before = analyzeLanguageRatio(text);

  // Already within acceptable range (±5%)
  if (before.hindiPct <= targetHindiPct + 5) {
    return { text, changes: [], before, after: before };
  }

  // Apply risky Hindi replacement first
  const { text: cleaned, changes } = replaceRiskyHindi(text);

  const after = analyzeLanguageRatio(cleaned);

  // If still too much Hindi, do a second pass: replace remaining HINDI_WORD_MAP words
  let result = cleaned;
  if (after.hindiPct > targetHindiPct + 5) {
    result = cleaned.replace(/\b\w+\b/g, (match) => {
      const w = match.toLowerCase();
      // Skip emotional Hindi
      if (EMOTIONAL_HINDI_KEEP.has(w)) return match;
      // Skip words not in Hindi map
      if (!HINDI_WORD_MAP.has(w)) return match;
      const replacement = HINDI_WORD_MAP.get(w);
      // Skip ambiguous words (null replacement)
      if (!replacement) return match;
      changes.push({ from: match, to: replacement, type: "word-map" });
      return replacement;
    });
  }

  const finalStats = analyzeLanguageRatio(result);

  return { text: result, changes, before, after: finalStats };
}

/**
 * scoreNaturalness(text)
 * Returns 0-100 naturalness score for Hinglish text.
 * Penalizes: pure Hindi sentences, TTS-risky words, weird mixing.
 * Rewards: natural Hinglish, financial terms, good flow.
 */
function scoreNaturalness(text) {
  if (!text || !text.trim()) return 0;

  let score = 100;
  const { hindiPct } = analyzeLanguageRatio(text);

  // Penalize extreme ratios
  if (hindiPct > 60) score -= 30;
  else if (hindiPct > 45) score -= 15;
  else if (hindiPct > 35) score -= 5;
  else if (hindiPct < 5)  score -= 10;  // too English, not Hinglish enough

  // Penalize consecutive Hindi words (3+ in a row = structural Hindi sentence)
  const tokens = tokenize(text);
  let consecutive = 0;
  let maxConsecutive = 0;
  for (const token of tokens) {
    const w = bareWord(token);
    if (ALL_HINDI_WORDS.has(w) && !EMOTIONAL_HINDI_KEEP.has(w)) {
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else {
      consecutive = 0;
    }
  }
  if (maxConsecutive >= 5) score -= 20;
  else if (maxConsecutive >= 3) score -= 10;

  // Penalize high-risk Hindi words
  const RISKY_PATTERNS = [
    /\btumhare?\b/gi, /\btumhari\b/gi, /\baapka\b/gi, /\baapki\b/gi,
    /\bkyunki\b/gi, /\bisliye\b/gi, /\bmutthi\b/gi,
  ];
  for (const p of RISKY_PATTERNS) {
    if (p.test(text)) score -= 5;
  }

  // Reward good financial terms
  const GOOD_TERMS = ["SIP", "EMI", "FD", "mutual fund", "invest", "returns", "portfolio"];
  for (const term of GOOD_TERMS) {
    if (text.toLowerCase().includes(term.toLowerCase())) score += 2;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * optimizeScene(sceneText, scenePurpose)
 * Optimizes a single scene for 70/30 ratio.
 * scenePurpose: "hook" | "content" | "cta" (hooks get stricter English enforcement)
 */
function optimizeScene(sceneText, scenePurpose = "content") {
  if (!sceneText || !sceneText.trim()) {
    return { text: sceneText, report: { hindiPct: 0, changed: false, changes: 0 } };
  }

  const hookMaxHindi = 20;   // hooks must be mostly English
  const contentMaxHindi = 35;
  const ctaMaxHindi = 15;    // CTAs must be very English

  const maxHindi =
    scenePurpose === "hook" ? hookMaxHindi :
    scenePurpose === "cta"  ? ctaMaxHindi  :
    contentMaxHindi;

  const before = analyzeLanguageRatio(sceneText);

  let result = sceneText;
  let totalChanges = [];

  // Always replace known risky patterns regardless of ratio
  const { text: afterRisky, changes: riskyChanges } = replaceRiskyHindi(sceneText);
  result = afterRisky;
  totalChanges.push(...riskyChanges);

  // If still over limit, do full rebalance
  const afterRiskyStats = analyzeLanguageRatio(result);
  if (afterRiskyStats.hindiPct > maxHindi) {
    const { text: rebalanced, changes: rebalChanges } = rebalanceTo7030(result, {
      targetHindi: maxHindi / 100,
    });
    result = rebalanced;
    totalChanges.push(...rebalChanges);
  }

  const after = analyzeLanguageRatio(result);
  const naturalness = scoreNaturalness(result);

  return {
    text: result,
    report: {
      purpose:    scenePurpose,
      before:     before.ratio,
      after:      after.ratio,
      changed:    totalChanges.length > 0,
      changes:    totalChanges.length,
      naturalness,
    },
  };
}

/**
 * optimizeScript(scenes)
 * Runs language optimization on all scenes.
 * scenes: array of scene objects with { hook, content, cta } or plain strings.
 * Returns { scenes: optimizedScenes, report }
 */
function optimizeScript(scenes) {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return { scenes, report: { summary: "no scenes to optimize", totalChanges: 0 } };
  }

  const optimized = [];
  let totalChanges = 0;
  let totalHindiBefore = 0;
  let totalHindiAfter  = 0;
  const sceneReports = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];

    // Handle both string scenes and object scenes with sub-fields
    if (typeof scene === "string") {
      const purpose = i === 0 ? "hook" : i === scenes.length - 1 ? "cta" : "content";
      const { text, report } = optimizeScene(scene, purpose);
      optimized.push(text);
      totalChanges += report.changes;
      sceneReports.push({ scene: i + 1, ...report });

      const before = analyzeLanguageRatio(scene);
      const after  = analyzeLanguageRatio(text);
      totalHindiBefore += before.hindiPct;
      totalHindiAfter  += after.hindiPct;

    } else if (scene && typeof scene === "object") {
      // Object scene — optimize each text field
      const optimizedScene = { ...scene };

      const fields = [
        { key: "hook",    purpose: "hook"    },
        { key: "content", purpose: "content" },
        { key: "cta",     purpose: "cta"     },
        { key: "text",    purpose: i === 0 ? "hook" : "content" },
      ];

      let sceneChanges = 0;
      for (const { key, purpose } of fields) {
        if (typeof scene[key] === "string" && scene[key].trim()) {
          const { text, report } = optimizeScene(scene[key], purpose);
          optimizedScene[key] = text;
          sceneChanges += report.changes;

          const before = analyzeLanguageRatio(scene[key]);
          const after  = analyzeLanguageRatio(text);
          totalHindiBefore += before.hindiPct;
          totalHindiAfter  += after.hindiPct;
        }
      }

      optimized.push(optimizedScene);
      totalChanges += sceneChanges;
      sceneReports.push({ scene: i + 1, changes: sceneChanges });
    } else {
      optimized.push(scene);
    }
  }

  const avgHindiBefore = Math.round(totalHindiBefore / Math.max(1, sceneReports.length));
  const avgHindiAfter  = Math.round(totalHindiAfter  / Math.max(1, sceneReports.length));

  const report = {
    summary:        `English% ≈ ${100 - avgHindiAfter}, Hindi% ≈ ${avgHindiAfter}, Words rewritten = ${totalChanges}`,
    totalChanges,
    avgHindiBefore,
    avgHindiAfter,
    avgEnglishAfter: 100 - avgHindiAfter,
    scenes:         sceneReports,
  };

  // Console debug output
  console.log(
    `[LanguageBalancer] Before avg Hindi=${avgHindiBefore}% → After=${avgHindiAfter}% | ` +
    `Rewrites=${totalChanges} | Scenes=${scenes.length}`
  );

  return { scenes: optimized, report };
}

module.exports = {
  analyzeLanguageRatio,
  replaceRiskyHindi,
  rebalanceTo7030,
  scoreNaturalness,
  optimizeScene,
  optimizeScript,
};
