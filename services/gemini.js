"use strict";

const axios = require("axios");

// ── API endpoints ──────────────────────────────────────────────────────────────
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

// ── Scene constraints ──────────────────────────────────────────────────────────
const MIN_SCENES         = 7;
const MAX_SCENES         = 9;
const MIN_TOTAL_DURATION = 20;   // aligns with renderer MIN_DURATION
const MAX_TOTAL_DURATION = 32;   // hard cap — keeps video ≤ 30 s after FFmpeg trim

// ── Vocabulary whitelists ──────────────────────────────────────────────────────
const ALLOWED_ELEMENT_TYPES = ["text","icon","arrow","chart","calendar","highlight","person"];
const ALLOWED_ICON_NAMES    = [
  "rupee","wallet","coin-stack","chart","trend-up","trend-down",
  "target","house","bank","lightbulb","brain","person","calendar",
];
const ALLOWED_ANIMATIONS    = ["draw","grow","pop","slide","pulse"];

// ── Schema enums (used for normalisation) ─────────────────────────────────────
const SCENE_PURPOSES  = ["hook","pain","reveal","action","payoff","cta"];
const SCENE_EMOTIONS  = ["shock","pain","insight","urgency","empathy","triumph","motivation","neutral"];
const SCENE_LAYOUTS   = ["center","split-left","split-right","stat-zoom","comparison","minimal","cta"];
const VISUAL_METAPHORS = [
  "leaking-wallet","treadmill","chain-rupee","money-tree",
  "sleeping-money","shrinking-coin","lightbulb-rupee","bullseye-coin",
  "calendar-growth","split-comparison","red-stamp","arrow-launch","default",
];

// ── Language ratio mode ────────────────────────────────────────────────────────
// Controls English/Hindi vocabulary mix in generated scripts.
// Set via env: LANGUAGE_MODE=default|aggressive|desi  (default = strict 70/30)
const LANG_MODE = (process.env.LANGUAGE_MODE || "default").toLowerCase();
const LANG_CONFIG = {
  default: {
    ratio:   "70% English / 30% Hindi",
    rule:    "English for ALL nouns, verbs, finance terms, and sentence structure. Hindi ONLY for emotional punches, connectives (toh, phir, nahi, aaj, abhi, galti, paisa, log) and colloquial flavour. Max 30% Hindi words per scene.",
    example: "'Your savings value inflation quietly reduce kar raha hai — phir bhi action nahi? Aaj hi fix karo.'",
    avoid:   "BANNED: tumhare/tumhara/tumhari (use 'your'), mera/meri/mere (use 'my'), hamara/hamare (use 'our'), kyunki (use 'because'), isliye (use 'so'), ghar (use 'home'), zindagi (use 'life'), naukri (use 'job'), mutthi (use 'control'), duniya (use 'world'). NEVER start a hook with a Hindi pronoun. NEVER use full Hindi sentences.",
  },
  aggressive: {
    ratio:   "85% English / 15% Hindi",
    rule:    "Maximum English. Hindi only for: paisa, galti, abhi, aaj, nahi, phir, toh. No other Hindi.",
    example: "'Inflation silently eats your savings every year — phir bhi koi action nahi hoti.'",
    avoid:   "Avoid all Hindi nouns and verbs. Use English equivalents everywhere.",
  },
  desi: {
    ratio:   "55% English / 45% Hindi",
    rule:    "Natural conversational Hinglish. Mix freely but no formal/literary Hindi — colloquial only.",
    example: "'Paisa aata hai, kharcha hota hai, savings zero rehti hai — kyun?'",
    avoid:   "Avoid: vyarth, laabh, nuksaan, dhan — use simpler spoken alternatives.",
  },
};
const CURRENT_LANG = LANG_CONFIG[LANG_MODE] || LANG_CONFIG.default;

// ── Hook engine — 5 categories × 7 templates = 35 unique hooks ────────────────
//
// ROTATION: selectHook() cycles through HOOK_CAT_ORDER (number appears once
// every 16 slots ≈ 6%). Hook text fingerprints (last 15) prevent exact repeats.
//
const HOOK_CATEGORIES = {
  // Curiosity — create an information gap the viewer must close (max 20% Hindi)
  curiosity: [
    t => `Why does your ${t} money silently disappear?`,
    t => `${t} ka ye ek secret — koi nahi batata.`,
    t => `Is your ${t} really working for you?`,
    t => `Why do most people never get ahead with ${t}?`,
    t => `This ${t} gap — koi explain nahi karta.`,
    t => `This one ${t} thing nobody ever explains clearly.`,
    t => `Simple question — what are you doing wrong in ${t}?`,
  ],
  // Fear — trigger loss-aversion (strongest scroll-stopper)
  fear: [
    t => `${t} is silently eating your money — every single day.`,
    t => `The biggest ${t} mistake most people make — aur pachtaate hain.`,
    t => `Fix this ${t} mistake now — nahi toh future toot jaayega.`,
    t => `Your ${t} plan is actually working against you.`,
    t => `The most dangerous ${t} trap — jo dikhta bhi nahi.`,
    t => `One ${t} slip and everything goes to zero.`,
    t => `The real ${t} loss — koi calculate nahi karta, tab tak.`,
  ],
  // Contrarian — challenge a belief, create instant curiosity
  contrarian: [
    t => `${t} alone does NOT make you rich — ye shocking truth hai.`,
    t => `Everything you heard about ${t} is wrong.`,
    t => `Hard work alone does not work in ${t}.`,
    t => `Popular ${t} advice is actually dangerous.`,
    t => `Rich people do NOT do what you do in ${t}.`,
    t => `The most accepted ${t} rule is actually backward.`,
    t => `Saving money alone is not enough in ${t} — ye myth hai.`,
  ],
  // Relatable — mirror the viewer's exact daily frustration
  relatable: [
    t => `Salary aayi… ${t} mein gayab ho gayi?`,
    t => `Month end mein ${t} mein zero — phir se?`,
    t => `Invested in ${t}… phir kya hua?`,
    t => `Wish you knew this ${t} tip 5 years ago?`,
    t => `Why does ${t} feel so complicated?`,
    t => `Money goes into ${t} — why does it never stay?`,
    t => `Are you making this common ${t} mistake too?`,
  ],
  // Number — specific numbers create credibility (USE SPARINGLY ~6%)
  number: [
    t => `3 mistakes that waste your money in ${t}.`,
    t => `1 habit that changes everything in ${t}.`,
    t => `5 signs your ${t} money is leaking.`,
    t => `2 types of people in ${t} — which one are you?`,
  ],
};

// Category rotation order — "number" appears 1/16 ≈ 6% of slots
const HOOK_CAT_ORDER = [
  "curiosity","fear","contrarian","relatable",
  "curiosity","fear","contrarian","relatable",
  "curiosity","fear","contrarian","relatable",
  "relatable","contrarian","fear",
  "number",
];
let _hookCatIdx = -1;
const _hookTextFP = [];   // fingerprints of last 15 hook texts (exact-repeat guard)

function selectHook(topic) {
  _hookCatIdx = (_hookCatIdx + 1) % HOOK_CAT_ORDER.length;
  const category  = HOOK_CAT_ORDER[_hookCatIdx];
  const templates = HOOK_CATEGORIES[category];
  const topicHash = Math.abs(hashStr(String(topic || "").toLowerCase()));

  for (let i = 0; i < templates.length; i++) {
    const idx  = (topicHash + i) % templates.length;
    const text = templates[idx](topic);
    const fp   = text.slice(0, 22).toLowerCase().replace(/\s+/g, " ").trim();
    if (!_hookTextFP.includes(fp)) {
      _hookTextFP.push(fp);
      if (_hookTextFP.length > 15) _hookTextFP.shift();
      return text;
    }
  }
  // Fallback: return base template without fingerprint tracking
  return templates[topicHash % templates.length](topic);
}

// ── Content library ────────────────────────────────────────────────────────────
const TRUTH_BOMBS = [
  "Salary se rich koi nahi banta. System se banta hai.",
  "Earning money and building wealth — ye do bilkul alag cheezein hain.",
  "Your money is losing value in the bank — inflation ki wajah se.",
  "Jo aaj save nahi karta, wo kal loan mein jeeta hai.",
  "Rich people make money work for them — baaki log sirf kaam karte hain.",
  "Income kitni bhi ho, bina system ke savings zero rahegi.",
  "Invisible expenses quietly eat your salary — tab tak pata nahi.",
  "Most people manage expenses. Rich people build assets.",
  "Financial freedom is not a one-time decision — ye daily habit hai.",
];

const TENSION_PHRASES = [
  "But here is the real problem...",
  "But the dangerous part comes now...",
  "Aur sabse badi galti?",
  "But here's what nobody tells you...",
  "That was just the beginning...",
  "Reality check — listen carefully...",
  "Aur ye jaanke takleef hogi...",
  "Now listen — ye shocking hai...",
];

const PAYOFF_LINES = [
  "Starting today, your money will work for you.",
  "Getting rich is not about income — it is about smart habits.",
  "Start today and your future will be different.",
  "This knowledge is your first real investment.",
  "One right decision today — massive difference in 10 years.",
  "Small steps daily, big results eventually.",
  "Your money game can change with just one smart move.",
];

const SHARE_TRIGGERS = [
  "This middle class trap happens in every home.",
  "Tag a friend who makes this galti.",
  "This problem is in your home too — share this.",
  "Send this to someone who needs to hear it.",
  "Everyone knows this financial truth — par koi act nahi karta.",
];

// ── CTA pool — 50 rotating variations ────────────────────────────────────────
// Groups: Follow (12) · Save/Share (10) · Action (10) · Engagement (8) · Knowledge (10)
// Rotation uses index cycling + fingerprint history (last 20) to guarantee no
// near-repeat within at least 20 consecutive reels.
const CTA_POOL = [
  // ── Follow-focused (12) ──────────────────────────────────────────────────
  "Aise aur finance tips ke liye abhi follow karo!",
  "Paisa samajhna hai? Toh abhi follow karo — free hai!",
  "Roz ek naya money tip chahiye? Follow karo abhi!",
  "Smart investors sab follow karte hain — tum bhi karo!",
  "Financial freedom ka pehla kadam — abhi follow karo!",
  "Aur bhi aise tips ke liye zaroor follow karo!",
  "Follow karo aur apni money journey shuru karo!",
  "Paisa badhana hai? Sirf follow karo — bass!",
  "Ek click mein — follow karo aur tips paate raho!",
  "Smart loag follow karte hain — unke saath judo!",
  "Daily money tips miss mat karna — follow karo!",
  "Follow karo aur kabhi ye tips miss mat karna!",
  // ── Save / Share (10) ────────────────────────────────────────────────────
  "Ye reel save karo — baad mein zaroor kaam aayegi!",
  "Ek dost ko bhejo jinhe paisa samajhna hai!",
  "Ghar walon ko share karo — unhe bhi chahiye ye tips!",
  "Save karke rakho is reel ko — kal kaam aayega!",
  "Apne dost ko tag karo jo paisa waste karta hai!",
  "Reel share karo — ek dost ki life badal sakti hai!",
  "Save zaroor karo — pura series aa raha hai!",
  "Story pe share karo aaj hi — koi faida uthaye!",
  "Comment mein batao — kitna helpful tha ye?",
  "Reel save kar lo — permanently tumhare paas rahegi!",
  // ── Action-oriented (10) ─────────────────────────────────────────────────
  "Aaj se hi shuru karo — kal ka wait mat karo!",
  "Abhi action lo — future tum par shukrguzaar hoga!",
  "Ek chhota step aaj lelo — 10 saal mein bada fark padega!",
  "Abhi save karo thoda — future secure hai phir!",
  "Aaj hi SIP shuru karo — der bahut ho chuki hai!",
  "Ek kaam karo aaj — paisa invest karna shuru karo!",
  "Late mat karo — pehla kadam abhi lo, abhi!",
  "Time waste mat karo — abhi start karo!",
  "Aaj ka decision kal ki zindagee banata hai — act karo!",
  "Chhota amount bhi kaafi hai — bas shuru karo aaj!",
  // ── Engagement / Comment (8) ─────────────────────────────────────────────
  "Comment mein likho — ye tip helpful thi ya nahi?",
  "Neeche comment karo — tumhara biggest money mistake kya hai?",
  "Batao comment mein — paisa save karte ho ya nahi?",
  "Ek number likho — is tip ko 10 mein se kitna doge?",
  "Comment karo — aur kaunsa finance topic chahiye?",
  "Neeche likho — tumhara financial goal kya hai 2025 mein?",
  "Batao — aaj se kya change karoge? Comment mein likho!",
  "Ek word mein batao — paisa save karna easy hai ya mushkil?",
  // ── Knowledge / Next content (10) ────────────────────────────────────────
  "Aisa aur content chahiye? Follow karo — daily aata hai!",
  "Part 2 bhi aa raha hai — follow karo miss mat karna!",
  "Next reel mein aur bhi powerful tip hai — follow karo!",
  "Ye sirf shuruat hai — aur bhi seekhna hai? Follow!",
  "Series poori dekhni hai? Profile pe jao!",
  "Aur tips aayenge daily — bas follow karo abhi!",
  "Financial education yahan free hai — follow karo!",
  "Paisa seekhna chahte ho? Ye account zaroor follow karo!",
  "Ye Tip No. 1 thi — aur bhi hain — follow karo!",
  "Seekhte raho, badhte raho — follow karo abhi!",
];

// Rotation state — index cycles forward; fingerprints (last 20) block exact repeats
let _ctaIdx = -1;
const _ctaFP = [];  // fingerprints of last 20 CTAs used

function selectCTA(topic) {
  const topicOffset = Math.abs(hashStr(String(topic || "").toLowerCase())) % CTA_POOL.length;

  for (let attempt = 0; attempt < CTA_POOL.length; attempt++) {
    _ctaIdx = (_ctaIdx + 1) % CTA_POOL.length;
    const candidate = CTA_POOL[(_ctaIdx + topicOffset) % CTA_POOL.length];
    const fp = candidate.slice(0, 18).toLowerCase().replace(/\s+/g, " ").trim();
    if (!_ctaFP.includes(fp)) {
      _ctaFP.push(fp);
      if (_ctaFP.length > 20) _ctaFP.shift();
      return candidate;
    }
  }
  // Safety fallback (would only trigger if pool is exhausted = impossible at 50)
  return CTA_POOL[topicOffset % CTA_POOL.length];
}

// Detect if a scene text is essentially a CTA (AI sometimes generates its own)
function isCTALike(text) {
  const l = String(text || "").toLowerCase();
  return /follow\s*karo|subscribe|notification|bell\s*icon|channel\s*pe|hamara\s*channel|share\s*karo\s+aur\s+follow|like\s+karo\s+aur/.test(l);
}

// ── Prompt builder ─────────────────────────────────────────────────────────────
function buildPrompt(topic) {
  return [
    // ── ROLE ──────────────────────────────────────────────────────────────────
    `You are a top Indian personal-finance Instagram creator — think Ankur Warikoo or Akshat Shrivastava style.`,
    `Write a short-form whiteboard reel script about: "${topic}"`,
    ``,
    `Return ONLY a valid JSON array. No markdown. No code fences. No explanation.`,
    ``,
    // ── VOICE & STYLE BRIEF ────────────────────────────────────────────────────
    `VOICE: Smart, direct, conversational. How an educated 28-year-old Indian explains money to a friend.`,
    `LANGUAGE: Natural Hinglish. ~75% English, ~25% Hindi — but never forced. Write how you actually speak.`,
    `  • English for: numbers, finance terms, facts, analysis`,
    `  • Hindi for: emotion, relatability, punchlines (paisa, galti, abhi, aaj, nahi, phir, toh, log, sach, sirf)`,
    `  • Finance terms always English: SIP, FD, EMI, mutual fund, returns, inflation, equity, portfolio, XIRR`,
    `  • Never translate the same idea twice ("every day aaj" / "silently chupke" = banned)`,
    ``,
    // ── NATURAL HINGLISH EXAMPLES (the standard to match) ─────────────────────
    `NATURAL HINGLISH — write like this:`,
    `  ✓ "FD mein 6% return. Inflation is 7%. You're losing money."`,
    `  ✓ "Salary aayi. Kharcha hua. Savings — zero again."`,
    `  ✓ "500 rupees monthly in SIP = 1 lakh in 7 years. Start karo."`,
    `  ✓ "Market girega. Sab girega. Smart investor adds more."`,
    `  ✓ "Risk nahi liya toh return nahi milega — simple hai."`,
    `  ✓ "SIP ka magic compounding hai. Time is the real investment."`,
    `  ✓ "This mistake sab karte hain. Aaj fix karo."`,
    ``,
    // ── GRAMMAR RULES (positive form) ─────────────────────────────────────────
    `GRAMMAR — use these exact patterns:`,
    `  Hindi verb forms: "ho jaata hai" | "kar sakte hain" | "milta hai" | "hota hai" | "rehta hai"`,
    `  Plural: "log karte hain" | "sab karte hain" | "people karte hain" (NEVER "karta hai" for plural)`,
    `  Past: "invest kiya" | "galti ki" | "start kiya" (single language per tense — no "did kiya")`,
    `  Present: "grow hota hai" | "kaam karta hai" (NEVER "grows hai" / "works hai")`,
    `  Imperative: "invest karo" | "save karo" | "start karo" (natural Hinglish — clean and short)`,
    ``,
    // ── STORY ARC ─────────────────────────────────────────────────────────────
    `STORY ARC — exactly ${MIN_SCENES}–${MAX_SCENES} scenes, total duration ${MIN_TOTAL_DURATION}–${MAX_TOTAL_DURATION}s:`,
    `  Scene 1  [hook]   : Scroll-stopper. Max 10 words. Curiosity, fear, or relatability. Start with English.`,
    `  Scene 2  [pain]   : The specific daily problem. Viewer thinks "this is me."`,
    `  Scene 3  [reveal] : Surprising truth that reframes the problem. NOT generic advice.`,
    `  Scenes 4+ [action]: One clear actionable step per scene. Specific. Direct.`,
    `  Scene -2 [payoff] : Short empowering close. Creates hope, not just information.`,
    `  Scene -1 [cta]    : "Follow karo" style CTA. Fresh — never repeat the payoff line.`,
    ``,
    // ── SCHEMA ────────────────────────────────────────────────────────────────
    `SCENE SCHEMA (7 required keys per scene):`,
    `{`,
    `  "text": "complete natural sentence, max 12 words",`,
    `  "duration": 3,`,
    `  "emotion": "shock|pain|insight|urgency|empathy|triumph|motivation|neutral",`,
    `  "layout": "center|split-left|split-right|stat-zoom|comparison|minimal|cta",`,
    `  "visualMetaphor": "leaking-wallet|treadmill|chain-rupee|money-tree|sleeping-money|shrinking-coin|lightbulb-rupee|bullseye-coin|calendar-growth|split-comparison|red-stamp|arrow-launch|default",`,
    `  "emphasisWord": "the single strongest word",`,
    `  "scenePurpose": "hook|pain|reveal|action|payoff|cta",`,
    `  "elements": [ 2–4 visual objects ]`,
    `}`,
    ``,
    `Layout rules: no two adjacent scenes same layout. hook→center or minimal | reveal→stat-zoom | action→split-left or split-right | payoff→minimal | cta→cta`,
    `Visual metaphors: leaking-wallet=spending | shrinking-coin=inflation | money-tree=growth | lightbulb-rupee=insight | arrow-launch=action | treadmill=salary-trap | calendar-growth=long-term`,
    `Elements: type from [${ALLOWED_ELEMENT_TYPES.join(", ")}] | icon name from [${ALLOWED_ICON_NAMES.join(", ")}] | animation from [${ALLOWED_ANIMATIONS.join(", ")}]`,
    ``,
    // ── CONCRETE FULL EXAMPLE ──────────────────────────────────────────────────
    `EXAMPLE OUTPUT (for topic "FD returns" — adapt the style, do NOT copy):`,
    `[`,
    `  {"text":"FD mein paisa rakh rahe ho? Check this first.","duration":3,"emotion":"shock","layout":"center","visualMetaphor":"shrinking-coin","emphasisWord":"check","scenePurpose":"hook","elements":[{"type":"icon","name":"bank","animation":"pop","keyword":"FD"},{"type":"arrow","direction":"down","animation":"grow","keyword":"losing"}]},`,
    `  {"text":"FD gives 6.5%. Inflation runs at 6-7%. Net gain — nearly zero.","duration":4,"emotion":"pain","layout":"stat-zoom","visualMetaphor":"shrinking-coin","emphasisWord":"zero","scenePurpose":"pain","elements":[{"type":"icon","name":"chart","animation":"grow","keyword":"inflation"},{"type":"icon","name":"coin-stack","animation":"pop","keyword":"savings"}]},`,
    `  {"text":"Real return = FD rate minus inflation. Often it's negative.","duration":3,"emotion":"insight","layout":"split-left","visualMetaphor":"lightbulb-rupee","emphasisWord":"negative","scenePurpose":"reveal","elements":[{"type":"icon","name":"lightbulb","animation":"pop","keyword":"real"},{"type":"icon","name":"trend-down","animation":"grow","keyword":"negative"}]},`,
    `  {"text":"Debt mutual funds can give 7–8% post-tax. Better option hai.","duration":3,"emotion":"urgency","layout":"split-right","visualMetaphor":"money-tree","emphasisWord":"better","scenePurpose":"action","elements":[{"type":"icon","name":"chart","animation":"grow","keyword":"returns"},{"type":"icon","name":"trend-up","animation":"pop","keyword":"mutual"}]},`,
    `  {"text":"Emergency fund mein FD — theek hai. Long-term wealth ke liye — nahi.","duration":4,"emotion":"insight","layout":"comparison","visualMetaphor":"split-comparison","emphasisWord":"long-term","scenePurpose":"action","elements":[{"type":"icon","name":"target","animation":"pop","keyword":"emergency"},{"type":"icon","name":"wallet","animation":"grow","keyword":"wealth"}]},`,
    `  {"text":"Paisa smarter jagah lagao. Returns follow karte hain.","duration":3,"emotion":"triumph","layout":"minimal","visualMetaphor":"arrow-launch","emphasisWord":"smarter","scenePurpose":"payoff","elements":[{"type":"icon","name":"trend-up","animation":"grow","keyword":"returns"},{"type":"icon","name":"brain","animation":"pop","keyword":"smart"}]},`,
    `  {"text":"Follow karo — daily money tips, simple language mein.","duration":3,"emotion":"motivation","layout":"cta","visualMetaphor":"default","emphasisWord":"follow","scenePurpose":"cta","elements":[{"type":"icon","name":"target","animation":"pop","keyword":"follow"},{"type":"icon","name":"rupee","animation":"pulse","keyword":"tips"}]}`,
    `]`,
    ``,
    `Now write the full JSON array for: "${topic}"`,
    `Remember: natural creator voice, no robotic translation, short punchy lines, correct Hinglish grammar.`,
  ].join("\n");
}

// ── Repair prompt ──────────────────────────────────────────────────────────────
function buildRepairPrompt(topic, previousOutput, errorMessage) {
  return [
    buildPrompt(topic),
    "",
    "Your previous output failed validation.",
    `Validation error: ${errorMessage}`,
    "Fix the JSON and return ONLY the corrected JSON array.",
    "",
    "Previous (broken) output:",
    previousOutput || "(empty response)",
  ].join("\n");
}

// ── JSON repair helpers ────────────────────────────────────────────────────────
function fixMalformedJSON(raw) {
  return raw
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/'([^'\\]*)'/g, '"$1"')
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"([^"\\]*)(\n)([^"\\]*)"/g, '"$1 $3"');
}

function repairPartialJSON(raw) {
  const str = raw.trim();
  if (!str.startsWith("[")) return null;

  let depth = 0, lastRootObjEnd = -1, inString = false, escaped = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escaped)               { escaped = false; continue; }
    if (c === "\\" && inString){ escaped = true;  continue; }
    if (c === '"')             { inString = !inString; continue; }
    if (inString)                continue;
    if (c === "{" || c === "[")  depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 1 && c === "}") lastRootObjEnd = i;
    }
  }
  return lastRootObjEnd > 0 ? str.slice(0, lastRootObjEnd + 1) + "]" : null;
}

function extractJSONArray(rawText) {
  const stripped = String(rawText || "")
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  const repaired = repairPartialJSON(stripped);
  if (repaired) {
    const fixed = fixMalformedJSON(repaired);
    try { JSON.parse(fixed); return fixed; } catch (_) {}
  }

  const match = stripped.match(/\[[\s\S]*\]/);
  if (match) return fixMalformedJSON(match[0]);

  throw new Error(`No JSON array found in response: ${stripped.slice(0, 300)}`);
}

// ── Grammar QA layer — corrects common Hinglish errors from AI output ─────────
//
// Applied to every scene text before any downstream processing.
// Rules are ordered: spelling fixes → verb agreement → vocabulary cleanup.
//
function fixHinglishGrammar(text) {
  return String(text || "")

    // ── Phonetic spelling corrections (common AI typos) ───────────────────
    .replace(/\bbhe\b/gi,    "bhi")       // bhe → bhi
    .replace(/\bkyu\b/gi,   "kyun")      // kyu → kyun
    .replace(/\bmai\b/gi,   "main")      // mai → main
    .replace(/\bnhi\b/gi,   "nahi")      // nhi → nahi
    .replace(/\bnah\b/gi,   "nahi")      // nah → nahi
    .replace(/\bkoi\s+nhi\b/gi, "koi nahi")
    .replace(/\bkuch\s+nhi\b/gi, "kuch nahi")

    // ── Plural verb agreement ("hain" not "hai" with plural subjects) ────
    // Pattern: verb + "hai" at end of clause → "hain" when plural subject implied
    .replace(/\bkarte\s+hai\b/gi,     "karte hain")
    .replace(/\brehte\s+hai\b/gi,     "rehte hain")
    .replace(/\bhote\s+hai\b/gi,      "hote hain")
    .replace(/\bjaate\s+hai\b/gi,     "jaate hain")
    .replace(/\bchahte\s+hai\b/gi,    "chahte hain")
    .replace(/\bsochte\s+hai\b/gi,    "sochte hain")
    .replace(/\bbachte\s+hai\b/gi,    "bachte hain")
    .replace(/\blagte\s+hai\b/gi,     "lagte hain")
    .replace(/\bsamjhte\s+hai\b/gi,   "samjhte hain")
    .replace(/\bkam\s+karte\s+hai\b/gi, "kam karte hain")
    .replace(/\bnahi\s+karte\s+hai\b/gi,"nahi karte hain")
    .replace(/\brok\s+te\s+hai\b/gi,  "rokte hain")

    // ── Singular verb agreement ("hai" not "hain" with singular subject) ─
    .replace(/\bkarta\s+hain\b/gi,  "karta hai")
    .replace(/\bkarti\s+hain\b/gi,  "karti hai")
    .replace(/\bhota\s+hain\b/gi,   "hota hai")
    .replace(/\bhoti\s+hain\b/gi,   "hoti hai")
    .replace(/\blagta\s+hain\b/gi,  "lagta hai")
    .replace(/\blagti\s+hain\b/gi,  "lagti hai")

    // ── Vocabulary simplification (Perso-Arabic → common Hinglish) ────────
    .replace(/\bnuksaan\b/gi,  "loss")
    .replace(/\blaabh\b/gi,   "profit")
    .replace(/\bsuvidha\b/gi, "benefit")
    .replace(/\bvyarth\b/gi,  "waste")
    .replace(/\bprakar\b/gi,  "tarah")

    // ── Fix "phir bhi" (still) — common split into wrong words ───────────
    .replace(/\bphir\s+bhe\b/gi, "phir bhi")
    .replace(/\bphir\s+bi\b/gi,  "phir bhi")

    // ── Gender agreement — adjective must agree with noun ─────────────────
    // In Hinglish, English nouns like amount/income/saving/salary carry
    // feminine gender (matching their Hindi equivalents rashi/aamdani/bachat).
    // Adjectives before them must use feminine forms: chotti, badi, etc.
    .replace(/\bchotta\s+(amount|saving|savings|income|salary|rashi)\b/gi,  "chotti $1")
    .replace(/\bchota\s+(amount|saving|savings|income|salary|rashi)\b/gi,   "chotti $1")
    .replace(/\bbada\s+(amount|saving|savings|income|salary|rashi)\b/gi,    "badi $1")
    .replace(/\bbara\s+(amount|saving|savings|income|salary|rashi)\b/gi,    "badi $1")

    // ── Verb form — intransitive "becomes" vs causative "makes" ──────────
    // "amount badi banti hai" (intransitive: amount grows by itself) is correct.
    // "badi banati hai" (causative) is wrong when amount is the subject.
    .replace(/\b(bada|badi|bara|bari)\s+banata\s+hai\b/gi, "$1 banta hai")
    .replace(/\b(bada|badi|bara|bari)\s+banati\s+hai\b/gi, "$1 banti hai")
    .replace(/\b(bada|badi|bara|bari)\s+banata\s+hain\b/gi,"$1 bante hain")
    .replace(/\b(bada|badi|bara|bari)\s+banati\s+hain\b/gi,"$1 banti hain")

    // ── "nikaal" vs "nikal" — transitive vs intransitive ─────────────────
    // "nikaal" = to take something out (transitive imperative)
    // "nikal" = goes out / gets depleted (intransitive — correct for money)
    // When paisa/savings is the subject (depleting context), force intransitive.
    .replace(/\bpaisa\s+nikaal\b/gi,    "paisa nikal")
    .replace(/\bpaise\s+nikaal\b/gi,    "paise nikal")
    .replace(/\bsalary\s+nikaal\b/gi,   "salary nikal")
    .replace(/\bincome\s+nikaal\b/gi,   "income nikal")

    // ── Middle-class plural verb correction ───────────────────────────────
    // "middle class" is plural in Hindi context — verbs must be plural too
    .replace(/\bmiddle\s+class\s+(\w+)\s+nahi\s+karta\b/gi,  "middle class $1 nahi karte")
    .replace(/\bmiddle\s+class\s+(\w+)\s+nhi\s+krta\b/gi,    "middle class $1 nahi karte")
    .replace(/\bmiddle\s+class\s+ye\s+nahi\s+karta\b/gi,     "middle class ye nahi karte")
    .replace(/\bmiddle\s+class\s+aisa\s+nahi\s+karta\b/gi,   "middle class aisa nahi karte")

    .replace(/\s+/g, " ")
    .trim();
}

// ── Text helpers ───────────────────────────────────────────────────────────────
function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/["""]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function normalizeDuration(value, fallback = 3) {
  return Math.max(2, Math.min(5, Math.round(Number(value) || fallback)));
}

// ── Field normalisers ──────────────────────────────────────────────────────────
function normalizeLayout(layout, fallback = "center") {
  const l = String(layout || "").toLowerCase().trim();
  return SCENE_LAYOUTS.includes(l) ? l : fallback;
}

function normalizeEmotion(emotion) {
  const e = String(emotion || "").toLowerCase().trim();
  return SCENE_EMOTIONS.includes(e) ? e : "neutral";
}

function normalizePurpose(purpose) {
  const p = String(purpose || "").toLowerCase().trim();
  return SCENE_PURPOSES.includes(p) ? p : "action";
}

function normalizeMetaphor(metaphor) {
  const m = String(metaphor || "").toLowerCase().trim();
  return VISUAL_METAPHORS.includes(m) ? m : "default";
}

// ── Element normalisation ──────────────────────────────────────────────────────
function normalizeElement(element, sceneText) {
  const normalized = {
    type:      String(element?.type      || "icon").trim().toLowerCase(),
    content:   normalizeText(element?.content   || ""),
    style:     String(element?.style     || "normal").trim().toLowerCase(),
    name:      String(element?.name      || "").trim().toLowerCase(),
    direction: String(element?.direction || "").trim().toLowerCase(),
    animation: String(element?.animation || "draw").trim().toLowerCase(),
    keyword:   normalizeText(element?.keyword   || ""),
  };

  if (!ALLOWED_ELEMENT_TYPES.includes(normalized.type))
    normalized.type = normalized.name || normalized.direction ? "icon" : "text";

  if (!ALLOWED_ANIMATIONS.includes(normalized.animation))
    normalized.animation = normalized.type === "arrow" ? "grow" : "draw";

  if (normalized.type === "icon" && !ALLOWED_ICON_NAMES.includes(normalized.name))
    normalized.name = inferIconName(sceneText);

  if (normalized.type === "arrow" && !["up","down","left","right"].includes(normalized.direction))
    normalized.direction = inferArrowDirection(sceneText);

  if (normalized.type === "text" && !normalized.content)
    normalized.content = sceneText;

  if (!normalized.keyword)
    normalized.keyword = inferKeyword(sceneText, normalized);

  return normalized;
}

// ── Inference helpers ──────────────────────────────────────────────────────────
function inferIconName(text) {
  const l = String(text || "").toLowerCase();
  if (/wallet|kharcha|spend|paise|kharch/.test(l))       return "wallet";
  if (/idea|soch|smart|clever|insight|samajh/.test(l))   return "lightbulb";
  if (/dimag|brain|samjh/.test(l))                       return "brain";
  if (/goal|lakshya|target|aim/.test(l))                 return "target";
  if (/ghar|home|house|future|safe/.test(l))             return "house";
  if (/badh|grow|upar|increase|rise|zyada/.test(l))      return "trend-up";
  if (/ghat|kam|down|decrease|loss|fall|ghata/.test(l))  return "trend-down";
  if (/salary|paisa|rupee|income|cash|paise/.test(l))    return "rupee";
  if (/calendar|mahine|month|saal|year/.test(l))         return "calendar";
  if (/bank|account|khaata/.test(l))                     return "bank";
  if (/chart|growth|return|compound|profit/.test(l))     return "chart";
  if (/person|log|tum|aap|follow/.test(l))               return "person";
  return "coin-stack";
}

function inferArrowDirection(text) {
  const l = String(text || "").toLowerCase();
  return /badh|grow|upar|increase|rich|profit/.test(l) ? "up" : "down";
}

function inferKeyword(text, element) {
  const l = String(text || "").toLowerCase();
  if (element.type === "arrow") {
    return element.direction === "up"
      ? (/badh|grow|upar/.test(l) ? "badhta" : "grow")
      : (/ghat|kam|down|leak/.test(l) ? "ghat" : "kam");
  }
  if (element.type === "icon") {
    if (element.name === "rupee")    return /salary/.test(l) ? "salary" : "paisa";
    if (element.name === "calendar") return /mahine/.test(l) ? "mahine" : "month";
  }
  return String(text || "").split(/\s+/)[0] || "";
}

function looksWeakHook(text) {
  const l = String(text || "").toLowerCase().trim();
  // A hook is "strong" if it has at least 4 words OR contains a strong signal word/punctuation.
  // Only override with template if the hook is genuinely missing/trivial.
  const wordCount = l.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 5) return false;   // 5+ words = keep AI hook as-is
  return !(/[?!]|kyun|galti|broke|rich|trap|mistake|losing|wrong|secret|truth/.test(l));
}

// ── Content factories ──────────────────────────────────────────────────────────
function selectHookText(existingText, topic) {
  // Always run through the hook engine for rotation + fingerprint tracking.
  // Only keep the AI's hook text if it looks strong AND hasn't appeared recently.
  if (!looksWeakHook(existingText)) {
    const fp = existingText.slice(0, 22).toLowerCase().replace(/\s+/g, " ").trim();
    if (!_hookTextFP.includes(fp)) {
      _hookTextFP.push(fp);
      if (_hookTextFP.length > 15) _hookTextFP.shift();
      return existingText;
    }
  }
  return selectHook(normalizeText(topic || "paisa"));
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return h;
}

function extractHookEmphasis(hookText) {
  const impactWords = ["broke","galti","nahi","kyun","zero","trap","mistake","wrong","rich"];
  const words = hookText.split(/\s+/);
  for (const w of words)
    if (impactWords.some(iw => w.toLowerCase().includes(iw))) return w;
  return words[Math.floor(words.length * 0.6)] || words[0] || "";
}

function hasTensionPhrase(scenes) {
  return scenes.some(s =>
    TENSION_PHRASES.some(t => s.text.toLowerCase().includes(t.slice(0, 12).toLowerCase()))
  );
}

function hasShareabilityTrigger(scenes) {
  return scenes.some(s =>
    /tag karo|middle class trap|send this|har ghar|tumhare ghar/.test(s.text.toLowerCase())
  );
}

function createCtaScene(topic) {
  const ctaText = selectCTA(topic);
  return {
    text:          ctaText,
    duration:      3,
    emotion:       "motivation",
    layout:        "cta",
    visualMetaphor:"arrow-launch",
    emphasisWord:  "follow",
    scenePurpose:  "cta",
    elements: [
      { type:"text",  content:"Follow karo!", style:"highlight", animation:"slide", keyword:"follow" },
      { type:"icon",  name:"person",          animation:"pop",   keyword:"follow"  },
      { type:"arrow", direction:"up",          animation:"grow",  keyword:"smart"   },
    ].map(el => normalizeElement(el, ctaText)),
  };
}

function createPayoffScene(topic) {
  const idx  = Math.abs(hashStr(topic)) % PAYOFF_LINES.length;
  const text = PAYOFF_LINES[idx];
  return {
    text,
    duration:      3,
    emotion:       "triumph",
    layout:        "minimal",
    visualMetaphor:"arrow-launch",
    emphasisWord:  "aaj",
    scenePurpose:  "payoff",
    elements: [
      { type:"icon", name:"trend-up", animation:"grow", keyword:"aaj"    },
      { type:"icon", name:"target",   animation:"pop",  keyword:"future" },
    ].map(el => normalizeElement(el, text)),
  };
}

function createBridgeScene(topic, index) {
  const lines = [
    "Paisa kama rahe ho, par system nahi toh sab vyarth hai.",
    "Invisible kharche salary ko quietly kha jaate hain.",
    "Jo pehle save karte hain, unka stress sabse kam hota hai.",
    "Ek smart decision aaj, 10 saal ka fark kal.",
    "Money flow nahi dikhega toh progress feel bhi nahi hogi.",
  ];
  const text = lines[index % lines.length];
  const metaphors = ["leaking-wallet","sleeping-money","calendar-growth","arrow-launch","lightbulb-rupee"];
  return {
    text,
    duration:      3,
    emotion:       "insight",
    layout:        SCENE_LAYOUTS[index % (SCENE_LAYOUTS.length - 2)],
    visualMetaphor: metaphors[index % metaphors.length],
    emphasisWord:  text.split(/\s+/)[3] || "",
    scenePurpose:  "action",
    elements: [
      { type:"icon",  name: inferIconName(text),  animation:"draw",
        keyword: inferKeyword(text, { type:"icon", name: inferIconName(text) }) },
      { type:"arrow", direction: inferArrowDirection(text), animation:"grow",
        keyword: inferKeyword(text, { type:"arrow", direction: inferArrowDirection(text) }) },
    ].map(el => normalizeElement(el, text)),
  };
}

// ── Script Quality Guard ──────────────────────────────────────────────────────
//
// Applied to contentScenes after the AI output is normalised but before the
// arc enforcement pass.  Removes:
//   • Incomplete lines (fewer than 4 words — fragments the AI sometimes generates)
//   • Near-duplicate sentences (>70% word overlap with any earlier scene)
//   • Trailing ellipsis-only / punctuation-only lines
// Logs what was removed so the console confirms the guard ran.
//
function runScriptQualityGuard(scenes) {
  const MIN_WORDS    = 4;
  const DEDUP_THRESH = 0.70;  // Jaccard similarity above this = near-duplicate

  function tokenize(text) {
    return String(text || "").toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function jaccardSim(a, b) {
    const sa = new Set(a), sb = new Set(b);
    let inter = 0;
    for (const w of sa) if (sb.has(w)) inter++;
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  const seen    = [];
  const kept    = [];
  let removed   = 0;

  for (const scene of scenes) {
    const words = tokenize(scene.text);

    // Remove too-short / punctuation-only / pure-ellipsis lines
    if (words.length < MIN_WORDS) {
      console.log(`[ScriptQA] Removed incomplete (${words.length}w): "${scene.text.slice(0, 60)}"`);
      removed++;
      continue;
    }

    // Detect near-duplicate with any previous scene
    let isDuplicate = false;
    for (const prevWords of seen) {
      if (jaccardSim(words, prevWords) >= DEDUP_THRESH) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      console.log(`[ScriptQA] Removed near-duplicate: "${scene.text.slice(0, 60)}"`);
      removed++;
      continue;
    }

    seen.push(words);
    kept.push(scene);
  }

  if (removed > 0)
    console.log(`[ScriptQA] Removed ${removed} low-quality scene(s). Kept ${kept.length}.`);
  else
    console.log(`[ScriptQA] All ${kept.length} scenes passed quality check.`);

  return kept;
}

// ── Layout rotation — no two adjacent scenes same layout ───────────────────────
function enforceLayoutRotation(scenes) {
  const fallbacks = ["center","split-left","split-right","stat-zoom","comparison","minimal"];
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i].layout !== scenes[i - 1].layout) continue;
    const prevL = scenes[i - 1].layout;
    const nextL = scenes[i + 1]?.layout || "";
    const alt   = fallbacks.find(l => l !== prevL && l !== nextL);
    if (alt) scenes[i].layout = alt;
  }
}

// ── Post-processing: normalise, enforce arc, inject content ───────────────────
function postProcessScenes(rawScenes, topic) {
  // ① Clean raw output — grammar QA applied first, then normalisation
  const cleaned = Array.isArray(rawScenes)
    ? rawScenes
        .filter(s => s && typeof s === "object")
        .map(s => ({
          text:          normalizeText(fixHinglishGrammar(s.text || "")),
          duration:      normalizeDuration(s.duration, 3),
          emotion:       normalizeEmotion(s.emotion),
          layout:        normalizeLayout(s.layout, "center"),
          visualMetaphor:normalizeMetaphor(s.visualMetaphor),
          emphasisWord:  normalizeText(s.emphasisWord || ""),
          scenePurpose:  normalizePurpose(s.scenePurpose),
          elements:      Array.isArray(s.elements) ? s.elements : [],
        }))
        .filter(s => s.text)
    : [];

  if (!cleaned.length) throw new Error("No valid scenes were produced.");

  // ② Pad short output before trim
  while (cleaned.length < MIN_SCENES - 2)
    cleaned.push(createBridgeScene(topic, cleaned.length));

  // ③ Trim to content max (leave room for payoff + cta)
  //    Also strip any AI-generated CTA scenes from the content body — we always
  //    append our own CTA at the end via createCtaScene(), so AI CTAs create dupes.
  const contentScenes = cleaned
    .filter(sc => sc.scenePurpose !== "cta" && !isCTALike(sc.text))
    .slice(0, MAX_SCENES - 2)
    .map((scene, i) => ({
      ...scene,
      elements: (scene.elements.length ? scene.elements : createBridgeScene(topic, i).elements)
        .slice(0, 4)
        .map(el => normalizeElement(el, scene.text)),
    }));

  // ③b Script quality guard — remove fragments + near-duplicates
  const qualityFiltered = runScriptQualityGuard(contentScenes);
  const finalContent    = qualityFiltered.length >= 3 ? qualityFiltered : contentScenes;

  // ④ Enforce hook at scene 1
  const hookText = selectHookText(finalContent[0]?.text || "", topic);
  finalContent[0] = {
    ...finalContent[0],
    text:          hookText,
    duration:      3,
    emotion:       "shock",
    layout:        normalizeLayout(finalContent[0]?.layout, "center"),
    visualMetaphor:"treadmill",
    emphasisWord:  extractHookEmphasis(hookText),
    scenePurpose:  "hook",
    elements: [
      { type:"text",  content:"kyun?",       style:"highlight", animation:"slide", keyword:"kyun"   },
      { type:"icon",  name:"wallet",          animation:"pop",   keyword:"broke"  },
      { type:"arrow", direction:"down",        animation:"grow",  keyword:"result" },
    ].map(el => normalizeElement(el, hookText)),
  };

  // ⑤ Tension phrase injection — DISABLED.
  //    The master prompt now generates natural tension in context.
  //    Prepending a hardcoded phrase created robotic output like:
  //    "But here is the real problem... FD mein 6% return." ← unnatural
  //    Kept as dead code for reference only.
  //
  // if (!hasTensionPhrase(finalContent) && finalContent.length >= 3) { ... }

  // ⑥ Shareability trigger injection — DISABLED.
  //    Wholesale replacing scene 2 with a hardcoded template destroyed
  //    AI-generated content that was often better than the template.
  //    Kept as dead code for reference only.
  //
  // if (!hasShareabilityTrigger(finalContent) && finalContent.length >= 2) { ... }

  // ⑦ Deduplicate content scenes — remove any scene whose opening text matches
  //    another scene already in the list (catches AI repeating payoff lines, etc.)
  const deduped = [];
  const seenFingerprints = new Set();
  for (const sc of finalContent) {
    // Fingerprint = first 28 lowercased characters (enough to detect near-dupes)
    const fp = sc.text.slice(0, 28).toLowerCase().replace(/\s+/g, " ").trim();
    if (!seenFingerprints.has(fp)) {
      seenFingerprints.add(fp);
      deduped.push(sc);
    }
  }

  // ⑧ Add payoff scene only if no content scene already serves that purpose
  //    or already contains nearly the same text.
  const generated_payoff = createPayoffScene(topic);
  const alreadyHasPayoff = deduped.some(sc =>
    sc.scenePurpose === "payoff" ||
    sc.text.slice(0, 20).toLowerCase() === generated_payoff.text.slice(0, 20).toLowerCase()
  );
  const finalScenes = alreadyHasPayoff
    ? [...deduped, createCtaScene(topic)]
    : [...deduped, generated_payoff, createCtaScene(topic)];

  // ⑨ Enforce layout rotation
  enforceLayoutRotation(finalScenes);

  // ⑩ Duration balancing
  let total = finalScenes.reduce((s, sc) => s + sc.duration, 0);

  if (total > MAX_TOTAL_DURATION) {
    let overflow = total - MAX_TOTAL_DURATION;
    for (const sc of finalScenes) {
      if (overflow <= 0) break;
      if (sc.duration > 2 && sc.scenePurpose !== "cta") { sc.duration -= 1; overflow -= 1; }
    }
  }

  while (total < MIN_TOTAL_DURATION && finalScenes.length < MAX_SCENES + 2) {
    const bridge = createBridgeScene(topic, finalScenes.length);
    const pos    = Math.max(2, finalScenes.length - 2);
    finalScenes.splice(pos, 0, {
      ...bridge,
      elements: bridge.elements.map(el => normalizeElement(el, bridge.text)),
    });
    total = finalScenes.reduce((s, sc) => s + sc.duration, 0);
  }

  // ⑪ Final normalisation pass
  return finalScenes.map(scene => ({
    text:          scene.text,
    duration:      normalizeDuration(scene.duration, 3),
    emotion:       scene.emotion       || "neutral",
    layout:        scene.layout        || "center",
    visualMetaphor:scene.visualMetaphor|| "default",
    emphasisWord:  scene.emphasisWord  || "",
    scenePurpose:  scene.scenePurpose  || "action",
    elements:      (scene.elements || []).map(el => normalizeElement(el, scene.text)),
  }));
}

// ── Scene parser ───────────────────────────────────────────────────────────────
function parseScenes(rawText, topic) {
  let parsed;
  try {
    parsed = JSON.parse(extractJSONArray(rawText));
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${error.message}`);
  }

  const scenes = postProcessScenes(parsed, topic);
  const total  = scenes.reduce((s, sc) => s + sc.duration, 0);
  if (total < MIN_TOTAL_DURATION || total > MAX_TOTAL_DURATION + 5) {
    throw new Error(`Total duration ${total}s outside acceptable range.`);
  }
  return scenes;
}

// ── Gemini API call ────────────────────────────────────────────────────────────
async function requestGemini(prompt, apiKey) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature:      0.88,
      topP:             0.92,
      maxOutputTokens:  8192,
      responseMimeType: "text/plain",
    },
  };
  const response = await axios.post(`${GEMINI_URL}?key=${apiKey}`, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 45_000,
  });
  return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function callGemini(topic) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing from .env");

  let prompt = buildPrompt(topic);
  let lastError = null, lastOutput = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      lastOutput = await requestGemini(prompt, apiKey);
      return parseScenes(lastOutput, topic);
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (status && [429, 500, 503].includes(status) && attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 2500));
        continue;
      }
      if (attempt < 3) {
        prompt = buildRepairPrompt(topic, lastOutput,
          error.response?.data?.error?.message || error.message);
      }
    }
  }
  throw new Error(lastError?.message || "Gemini failed after 3 retries.");
}

async function callGroq(topic) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is missing from .env");

  const response = await axios.post(
    GROQ_URL,
    {
      model:    GROQ_MODEL,
      messages: [{ role:"user", content: buildPrompt(topic) }],
      temperature:  0.92,
      max_tokens:   3000,
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: 45_000,
    }
  );

  const rawText = response.data?.choices?.[0]?.message?.content || "";
  return parseScenes(rawText, topic);
}

// ── Public: script generation ─────────────────────────────────────────────────
async function generateScript(topic) {
  try {
    console.log("      Using Gemini 2.5 Flash...");
    return await callGemini(topic);
  } catch (error) {
    console.warn(`      Gemini failed: ${error.message}`);
    console.log("      Falling back to Groq (llama-3.3-70b)...");
    return await callGroq(topic);
  }
}

// ── LLM Humanization Pass ─────────────────────────────────────────────────────
// Called when quality score < 8. Rewrites only the "text" fields of scenes
// using Groq (fast) with a strict humanization prompt.
// Returns the original scene objects with text fields replaced.

function buildHumanizePrompt(scenes) {
  const numbered = scenes
    .map((s, i) => {
      const text    = typeof s === "string" ? s : (s.text || "");
      const purpose = typeof s === "object" ? (s.scenePurpose || "content") : "content";
      return `${i + 1}. [${purpose}] ${text}`;
    })
    .join("\n");

  return [
    `You are an expert Indian Instagram finance creator. Rewrite the following reel script lines in clean, natural Hinglish.`,
    ``,
    `RULES (non-negotiable):`,
    `1. Keep the SAME meaning and finance concept.`,
    `2. Language: 70% English / 30% Hindi. English for facts, numbers, finance terms. Hindi only for emotion and flow.`,
    `3. Grammar must be 100% correct Hinglish — no "goes hai", no "did kiya", no "grow hua", no "every day aaj".`,
    `4. Each line max 12 words. Short. Punchy. Creator-style.`,
    `5. Hook line [hook]: must start with an English question or statement. No "Kya" or "Agar" at start.`,
    `6. NEVER mix same meaning in 2 languages in the same line (e.g. "silently chupke", "today aaj").`,
    `7. Finance terms always in English: SIP, FD, EMI, mutual fund, returns, inflation, portfolio, wealth.`,
    `8. Allowed Hindi words: paisa, galti, abhi, aaj, nahi, phir, toh, log, fayda, sach, sirf, aur, ya.`,
    `9. CTA line [cta]: must be an imperative. Example: "Follow karo — daily money tips milenge!"`,
    ``,
    `FORBIDDEN PATTERNS:`,
    `✗ goes hai | grows hai | works hai | hota is | hain are | tha was`,
    `✗ did kiya | grew hua | huaed | kar raha was`,
    `✗ every day aaj | today aaj | silently chupke | sabse best`,
    `✗ people karta hai | sab karta hai | log karta hai`,
    ``,
    `GOOD EXAMPLES:`,
    `✓ "Is your FD losing value daily?" (hook — clean English question)`,
    `✓ "Inflation beats low FD returns." (reveal — clean English fact)`,
    `✓ "SIP mein invest karo — returns grow hote hain." (action — natural Hinglish)`,
    `✓ "Aaj se paisa work karna shuru karo." (payoff — Hinglish imperative)`,
    ``,
    `ORIGINAL LINES:`,
    numbered,
    ``,
    `Return ONLY a JSON array of strings — one rewritten line per original line, same order.`,
    `Example format: ["line 1 rewritten", "line 2 rewritten", ...]`,
    `No markdown. No explanation. Just the JSON array.`,
  ].join("\n");
}

async function humanizeScript(scenes, topic = "") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.warn("[humanizeScript] No GROQ_API_KEY — skipping humanization pass.");
    return scenes;
  }

  const prompt = buildHumanizePrompt(scenes);

  try {
    const response = await axios.post(
      GROQ_URL,
      {
        model:       GROQ_MODEL,
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.6,     // lower temp for correction task (not creative)
        max_tokens:  1500,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 30_000,
      }
    );

    const raw = response.data?.choices?.[0]?.message?.content || "";

    // Extract JSON array from response
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("LLM humanization: no JSON array in response");

    const rewritten = JSON.parse(match[0]);
    if (!Array.isArray(rewritten) || rewritten.length !== scenes.length) {
      throw new Error(`LLM humanization: expected ${scenes.length} lines, got ${rewritten.length}`);
    }

    // Merge rewritten texts back into original scene objects
    return scenes.map((scene, i) => {
      const newText = (rewritten[i] || "").trim();
      if (!newText) return scene;
      return typeof scene === "string" ? newText : { ...scene, text: newText };
    });

  } catch (err) {
    console.warn(`[humanizeScript] LLM pass failed: ${err.message} — returning original scenes`);
    return scenes;   // graceful fallback: don't break the pipeline
  }
}

// ── Caption + Hashtag generation ──────────────────────────────────────────────
const DEFAULT_HASHTAGS = [
  "#finance","#money","#investing","#personalfinance","#wealth",
  "#IndianFinance","#moneymanagement","#financetips","#paisa","#richhabits",
];

function buildCaptionPrompt(topic, sceneTexts) {
  return [
    `You are an Instagram content creator for Indian personal-finance reels.`,
    ``,
    `Reel topic: "${topic}"`,
    `Script highlights:`,
    sceneTexts,
    ``,
    `Return ONLY a valid JSON object (no markdown, no explanation) with exactly:`,
    `{`,
    `  "caption": "2-3 line Hinglish caption with 2-3 emoji, conversational tone, ends with follow CTA",`,
    `  "hashtags": ["#tag1","#tag2",...] (exactly 10 tags: mix broad + niche Indian finance tags)`,
    `}`,
    ``,
    `Caption must: mention topic, feel human (not AI), use money/growth emoji, be scroll-stopping.`,
  ].join("\n");
}

async function generateCaption(topic, scenes) {
  const apiKey = process.env.GEMINI_API_KEY;
  const fallback = {
    caption:  `${normalizeText(topic)} ke baare mein yeh cheez jaanna zaroori hai! 💰\n\nAise aur smart money tips ke liye follow karo! 🚀`,
    hashtags: DEFAULT_HASHTAGS,
  };

  if (!apiKey) return fallback;

  try {
    const sceneTexts = scenes.slice(0, 6).map(s => `- ${s.text}`).join("\n");
    const raw = await requestGemini(buildCaptionPrompt(topic, sceneTexts), apiKey);
    const cleaned = fixMalformedJSON(
      String(raw || "").replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim()
    );
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return fallback;

    const obj = JSON.parse(match[0]);
    return {
      caption:  String(obj.caption  || "").trim() || fallback.caption,
      hashtags: Array.isArray(obj.hashtags) && obj.hashtags.length
        ? obj.hashtags.slice(0, 10)
        : DEFAULT_HASHTAGS,
    };
  } catch (_) {
    return fallback;
  }
}

module.exports = { generateScript, generateCaption, humanizeScript };
