"use strict";

const axios = require("axios");

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const MIN_SCENES = 8;
const MAX_SCENES = 10;
const MIN_TOTAL_DURATION = 30;
const MAX_TOTAL_DURATION = 45;
const CTA_TEXT = "Aise aur smart money reels chahiye? Follow kar lo.";
const ALLOWED_ELEMENT_TYPES = [
  "text",
  "icon",
  "arrow",
  "chart",
  "calendar",
  "highlight",
  "person",
];
const ALLOWED_ICON_NAMES = ["rupee", "person", "chart", "calendar", "bank", "coin-stack", "wallet", "lightbulb", "brain", "target", "house", "trend-up", "trend-down"];
const ALLOWED_ANIMATIONS = ["draw", "grow", "pop", "slide", "pulse"];

function buildPrompt(topic) {
  return [
    `You are a senior Indian reel writer creating a dynamic Hinglish whiteboard reel about "${topic}".`,
    `The narrator is FEMALE. Use feminine verb forms throughout (karungi, bolungi, dungi, jaungi, rahi, gayi, aayi, etc.) — never masculine forms (karunga, bolunga, dunga, jaunga, raha, gaya, aaya).`,
    "",
    `Return ONLY a valid JSON array with ${MIN_SCENES}-${MAX_SCENES} scenes.`,
    'Each scene object must contain exactly these keys: "text", "duration", "elements".',
    "",
    "Scene rules:",
    "- Scene 1 must be an emotionally strong hook with curiosity.",
    "- Structure: hook, relatable problem, why it happens, insight, action, CTA.",
    "- Hinglish only.",
    "- Conversational reel voice, not textbook finance language.",
    "- Short punchy spoken lines.",
    "- Total duration across scenes must land between 30 and 45 seconds.",
    "- First scene should feel like: 90% log paisa kamaate hai, par ameer kyun nahi bante?",
    "- Last scene must ask the viewer to follow for more.",
    "",
    "elements rules:",
    '- "elements" must be an array of 2-4 structured objects.',
    '- Each element object may contain: "type", "content", "style", "name", "direction", "animation", "keyword".',
    `- Allowed type values: ${ALLOWED_ELEMENT_TYPES.join(", ")}.`,
    `- Allowed icon names: ${ALLOWED_ICON_NAMES.join(", ")}.`,
    `- Allowed animation values: ${ALLOWED_ANIMATIONS.join(", ")}.`,
    '- Use "keyword" to connect a visual to the exact word or phrase it should sync with.',
    "- Visuals must immediately represent the spoken meaning.",
    "",
    "Icon mapping guide (suggest icons to match meaning):",
    "- rupee / paisa / salary → income, money",
    "- wallet → spending, expense, budget",
    "- chart → growth, returns, profit, performance",
    "- trend-up → growth, increase, improve",
    "- trend-down → loss, decline, fall",
    "- target → goal, aim, achieve",
    "- house → home, security, future",
    "- bank → saving, security, account",
    "- lightbulb → idea, smart move, realization",
    "- brain → smart thinking, intelligence, learning",
    "- person → people, investor, you, customer",
    "- calendar → time, month, duration, years",
    "- coin-stack → wealth, accumulation, savings",
    "",
    "Example scene shape:",
    '[{"text":"90% log salary aane ke baad bhi broke kyun feel karte hai?","duration":4,"elements":[{"type":"text","content":"broke kyun?","style":"highlight","animation":"slide","keyword":"broke"},{"type":"icon","name":"wallet","animation":"draw","keyword":"broke"},{"type":"arrow","direction":"down","animation":"grow","keyword":"kyun"}]}]',
    "",
    "Return JSON only. No markdown. No explanation.",
  ].join("\n");
}

function buildRepairPrompt(topic, previousOutput, errorMessage) {
  return [
    buildPrompt(topic),
    "",
    "Your previous output failed validation.",
    `Validation error: ${errorMessage}`,
    "Fix the JSON and return only the corrected JSON array.",
    "",
    "Previous output:",
    previousOutput || "(empty response)",
  ].join("\n");
}

function fixMalformedJSON(raw) {
  return raw
    // Smart / curly quotes → straight quotes
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Trailing commas before } or ]  (e.g.  ,\n} or ,\n])
    .replace(/,\s*([}\]])/g, "$1")
    // Single-quoted strings → double-quoted (simple cases only)
    .replace(/'([^'\\]*)'/g, '"$1"')
    // Strip JS-style line comments
    .replace(/\/\/[^\n]*/g, "")
    // Strip block comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Unescaped newlines inside string values
    .replace(/"([^"\\]*)(\n)([^"\\]*)"/g, '"$1 $3"');
}

// Walk the JSON char-by-char and close any incomplete array at root level.
// Handles Gemini truncation where the response is cut off mid-object.
function repairPartialJSON(raw) {
  const str = raw.trim();
  if (!str.startsWith("[")) return null;

  let depth = 0;
  let lastRootObjEnd = -1; // index of last '}' at depth 1 (= root array element)
  let inString = false;
  let escaped  = false;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escaped)              { escaped = false; continue; }
    if (c === "\\" && inString) { escaped = true;  continue; }
    if (c === '"')              { inString = !inString; continue; }
    if (inString)               continue;

    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 1 && c === "}") lastRootObjEnd = i;
    }
  }

  if (lastRootObjEnd > 0) {
    return str.slice(0, lastRootObjEnd + 1) + "]";
  }
  return null;
}

function extractJSONArray(rawText) {
  const stripped = String(rawText || "")
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // ① Repair-first: walk the JSON and close at last complete root-level object.
  //    This handles BOTH well-formed and truncated responses correctly.
  //    The naive greedy regex (\[[\s\S]*\]) must NOT run first because for
  //    truncated responses it matches up to the last inner ] (e.g. an elements
  //    array bracket), returning malformed JSON before repair even runs.
  const repaired = repairPartialJSON(stripped);
  if (repaired) {
    const fixed = fixMalformedJSON(repaired);
    try {
      JSON.parse(fixed);           // validate before accepting
      return fixed;
    } catch (_) {}                 // fall through — may be further broken
  }

  // ② Last resort: greedy regex (catches wrapped / non-standard output)
  const match = stripped.match(/\[[\s\S]*\]/);
  if (match) return fixMalformedJSON(match[0]);

  throw new Error(`No JSON array found in response: ${stripped.slice(0, 300)}`);
}

function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function normalizeDuration(value, fallback = 4) {
  return Math.max(3, Math.min(5, Math.round(Number(value) || fallback)));
}

function normalizeElement(element, sceneText) {
  const normalized = {
    type: String(element?.type || "icon").trim().toLowerCase(),
    content: normalizeText(element?.content || ""),
    style: String(element?.style || "normal").trim().toLowerCase(),
    name: String(element?.name || "").trim().toLowerCase(),
    direction: String(element?.direction || "").trim().toLowerCase(),
    animation: String(element?.animation || "draw").trim().toLowerCase(),
    keyword: normalizeText(element?.keyword || ""),
  };

  if (!ALLOWED_ELEMENT_TYPES.includes(normalized.type)) {
    normalized.type = normalized.name || normalized.direction ? "icon" : "text";
  }

  if (!ALLOWED_ANIMATIONS.includes(normalized.animation)) {
    normalized.animation = normalized.type === "arrow" ? "grow" : "draw";
  }

  if (normalized.type === "icon" && !ALLOWED_ICON_NAMES.includes(normalized.name)) {
    normalized.name = inferIconName(sceneText);
  }

  if (normalized.type === "arrow" && !["up", "down", "left", "right"].includes(normalized.direction)) {
    normalized.direction = inferArrowDirection(sceneText);
  }

  if (normalized.type === "text" && !normalized.content) {
    normalized.content = sceneText;
  }

  if (!normalized.keyword) {
    normalized.keyword = inferKeyword(sceneText, normalized);
  }

  return normalized;
}

function inferIconName(text) {
  const lower = String(text || "").toLowerCase();
  if (/wallet|kharcha|spend|paise/.test(lower)) return "wallet";
  if (/idea|soch|smart|clever|yaad/.test(lower)) return "lightbulb";
  if (/dimag|soch|brain|samajh/.test(lower)) return "brain";
  if (/goal|lakshya|target|uddeshy/.test(lower)) return "target";
  if (/ghar|home|house|kal|future|safe/.test(lower)) return "house";
  if (/badh|grow|upar|increase|rise|up/.test(lower)) return "trend-up";
  if (/ghat|kam|down|decrease|loss|fall/.test(lower)) return "trend-down";
  if (/salary|paisa|rupee|income|cash/.test(lower)) return "rupee";
  if (/calendar|mahine|month/.test(lower)) return "calendar";
  if (/bank|account|khaata/.test(lower)) return "bank";
  if (/chart|growth|return|compound|profit/.test(lower)) return "chart";
  if (/person|log|tum|aap|ladka|ladki/.test(lower)) return "person";
  return "coin-stack";
}

function inferArrowDirection(text) {
  const lower = String(text || "").toLowerCase();
  if (/badh|grow|upar|increase|rich/.test(lower)) return "up";
  return "down";
}

function inferKeyword(text, element) {
  const loweredText = String(text || "").toLowerCase();
  if (element.type === "arrow") {
    if (element.direction === "up") return /badh|grow|upar/.test(loweredText) ? "badhta" : "grow";
    return /ghat|kam|down|leak/.test(loweredText) ? "ghat" : "kam";
  }
  if (element.type === "icon") {
    if (element.name === "rupee") return /salary/.test(loweredText) ? "salary" : "paisa";
    if (element.name === "calendar") return /mahine/.test(loweredText) ? "mahine" : "month";
  }
  return String(text || "").split(/\s+/)[0] || "";
}

function looksWeakHook(text) {
  const lower = String(text || "").toLowerCase();
  return !(/[?]|kyun|kyu|kaise|sach|secret|galti|mistake|90%|80%|kabhi/.test(lower));
}

function createHook(topic) {
  const subject = normalizeText(topic || "paisa");
  return `90% log ${subject} mein mehnat karte hai, par result kyun nahi dikhta?`;
}

function createCtaScene() {
  return {
    text: CTA_TEXT,
    duration: 4,
    elements: [
      { type: "text", content: "Follow kar lo", style: "highlight", animation: "slide", keyword: "follow" },
      { type: "person", animation: "draw", keyword: "follow" },
      { type: "arrow", direction: "up", animation: "grow", keyword: "smart" },
    ],
  };
}

function createBridgeScene(topic, index) {
  const lines = [
    `Salary badi lagti hai, lekin invisible kharche usse quietly kha jaate hai.`,
    `Problem paisa kam aana nahi, uska bina system ke nikal jaana hota hai.`,
    `Jab tak money flow dikhega nahi, tab tak progress feel bhi nahi hogi.`,
    `Ek smart tweak se wahi income zyada disciplined lagne lagti hai.`,
    `Jo log pehle save karte hai, unka stress month end pe sabse kam hota hai.`,
  ];
  const text = lines[index % lines.length];
  return {
    text,
    duration: 4,
    elements: [
      { type: "text", content: text.split(",")[0], style: "highlight", animation: "slide", keyword: "Salary" },
      { type: "icon", name: inferIconName(text), animation: "draw", keyword: inferKeyword(text, { type: "icon", name: inferIconName(text) }) },
      { type: "arrow", direction: inferArrowDirection(text), animation: "grow", keyword: inferKeyword(text, { type: "arrow", direction: inferArrowDirection(text) }) },
    ],
  };
}

function postProcessScenes(rawScenes, topic) {
  const cleaned = Array.isArray(rawScenes)
    ? rawScenes
        .filter((scene) => scene && typeof scene === "object")
        .map((scene) => ({
          text: normalizeText(scene.text || ""),
          duration: normalizeDuration(scene.duration, 4),
          elements: Array.isArray(scene.elements) ? scene.elements : [],
        }))
        .filter((scene) => scene.text)
    : [];

  if (!cleaned.length) {
    throw new Error("No valid scenes were produced.");
  }

  while (cleaned.length < MIN_SCENES - 1) {
    cleaned.push(createBridgeScene(topic, cleaned.length));
  }

  const trimmed = cleaned.slice(0, MAX_SCENES - 1).map((scene) => ({
    ...scene,
    elements: (scene.elements.length ? scene.elements : createBridgeScene(topic, 0).elements)
      .slice(0, 4)
      .map((element) => normalizeElement(element, scene.text)),
  }));

  trimmed[0] = {
    ...trimmed[0],
    text: looksWeakHook(trimmed[0].text) ? createHook(topic) : trimmed[0].text,
    duration: 4,
    elements: [
      { type: "text", content: "kyun nahi?", style: "highlight", animation: "slide", keyword: "kyun" },
      { type: "icon", name: "rupee", animation: "draw", keyword: "log" },
      { type: "arrow", direction: "down", animation: "grow", keyword: "result" },
    ],
  };

  const scenesWithCta = trimmed.concat(createCtaScene());
  let totalDuration = scenesWithCta.reduce((sum, scene) => sum + scene.duration, 0);

  while (totalDuration < MIN_TOTAL_DURATION && scenesWithCta.length < MAX_SCENES) {
    const bridge = createBridgeScene(topic, scenesWithCta.length + 1);
    scenesWithCta.splice(Math.max(2, scenesWithCta.length - 1), 0, {
      ...bridge,
      elements: bridge.elements.map((element) => normalizeElement(element, bridge.text)),
    });
    totalDuration = scenesWithCta.reduce((sum, scene) => sum + scene.duration, 0);
  }

  if (totalDuration > MAX_TOTAL_DURATION) {
    let overflow = totalDuration - MAX_TOTAL_DURATION;
    for (const scene of scenesWithCta) {
      if (overflow <= 0) break;
      if (scene.duration > 3) {
        scene.duration -= 1;
        overflow -= 1;
      }
    }
  }

  return scenesWithCta.map((scene) => ({
    text: scene.text,
    duration: normalizeDuration(scene.duration, 4),
    elements: scene.elements.map((element) => normalizeElement(element, scene.text)),
  }));
}

function parseScenes(rawText, topic) {
  let parsed;
  try {
    parsed = JSON.parse(extractJSONArray(rawText));
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${error.message}`);
  }

  const scenes = postProcessScenes(parsed, topic);
  const totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  if (totalDuration < MIN_TOTAL_DURATION || totalDuration > MAX_TOTAL_DURATION) {
    throw new Error(`Total duration ${totalDuration}s is outside 30-45s.`);
  }

  return scenes;
}

async function requestGemini(prompt, apiKey) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.88,
      topP: 0.92,
      maxOutputTokens: 8192,   // generous budget — truncation was the root cause
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
  let lastError = null;
  let lastOutput = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      lastOutput = await requestGemini(prompt, apiKey);
      return parseScenes(lastOutput, topic);
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      const detail = error.response?.data?.error?.message || error.message;

      if (status && [429, 500, 503].includes(status) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
        continue;
      }

      if (attempt < 3) {
        prompt = buildRepairPrompt(topic, lastOutput, detail);
        continue;
      }
    }
  }

  throw new Error(lastError?.message || "Gemini failed after 3 structured retries.");
}

async function callGroq(topic) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is missing from .env");

  const response = await axios.post(
    GROQ_URL,
    {
      model: GROQ_MODEL,
      messages: [{ role: "user", content: buildPrompt(topic) }],
      temperature: 0.95,
      max_tokens: 2000,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 45_000,
    }
  );

  const rawText = response.data?.choices?.[0]?.message?.content || "";
  return parseScenes(rawText, topic);
}

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

// ── Caption + Hashtag generation ─────────────────────────────────────────────
const DEFAULT_HASHTAGS = [
  "#finance","#money","#investing","#SIP","#personalfinance",
  "#wealth","#IndianFinance","#moneymanagement","#financetips","#paisa",
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
    `  "caption": "2-3 line Hinglish caption with emoji, ends with CTA to follow",`,
    `  "hashtags": ["#tag1","#tag2",...] (exactly 10 tags, India-finance focused)`,
    `}`,
    ``,
    `Caption rules: conversational tone, include money emoji, mention topic keyword.`,
    `Hashtag rules: mix broad (#finance) + niche (#SIPinvesting), all lowercase.`,
  ].join("\n");
}

async function generateCaption(topic, scenes) {
  const apiKey = process.env.GEMINI_API_KEY;
  const fallback = {
    caption: `${normalizeText(topic)} ke baare mein yeh cheez jaanna zaroori hai! 💰\n\nAise aur smart money tips ke liye follow karo! 🚀`,
    hashtags: DEFAULT_HASHTAGS,
  };

  if (!apiKey) return fallback;

  try {
    const sceneTexts = scenes
      .slice(0, 6)
      .map((s) => `- ${s.text}`)
      .join("\n");

    const raw = await requestGemini(buildCaptionPrompt(topic, sceneTexts), apiKey);
    const cleaned = fixMalformedJSON(
      String(raw || "")
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/g, "")
        .trim()
    );
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return fallback;

    const obj = JSON.parse(match[0]);
    return {
      caption:   String(obj.caption  || "").trim() || fallback.caption,
      hashtags:  Array.isArray(obj.hashtags) && obj.hashtags.length
        ? obj.hashtags.slice(0, 10)
        : DEFAULT_HASHTAGS,
    };
  } catch (_) {
    return fallback;
  }
}

module.exports = { generateScript, generateCaption };
