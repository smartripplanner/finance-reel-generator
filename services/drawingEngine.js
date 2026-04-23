"use strict";

const { createCanvas } = require("canvas");

const W = 1080;
const H = 1920;

// Fixed layout zones
const TEXT_AREA  = { x: 60, y: 130, width: 960, height: 480 };
const VISUAL_AREA = { x: 60, y: 680, width: 960, height: 1100 };

// Legacy colours (kept for compat)
const COLORS = {
  ink:    "#1A1A2E",
  muted:  "#3f3f46",
  paper:  "#ffffff",
  blue:   "#2563eb",
  green:  "#16a34a",
  red:    "#dc2626",
  yellow: "#fde047",
  orange: "#f97316",
};

// ── Per-scene colour themes ───────────────────────────────────────────────────
const SCENE_THEMES = [
  { bg: "#FFFBF0", accent: "#FF6B35", highlight: "#FFD700", text: "#1A1A2E" },
  { bg: "#EFF8FF", accent: "#2563EB", highlight: "#F59E0B", text: "#1A1A2E" },
  { bg: "#F0FDF4", accent: "#16A34A", highlight: "#84CC16", text: "#1A1A2E" },
  { bg: "#FDF4FF", accent: "#9333EA", highlight: "#EC4899", text: "#1A1A2E" },
  { bg: "#FFF7ED", accent: "#EA580C", highlight: "#EAB308", text: "#1A1A2E" },
  { bg: "#F0FDFA", accent: "#0891B2", highlight: "#10B981", text: "#1A1A2E" },
  { bg: "#FEF2F2", accent: "#DC2626", highlight: "#F97316", text: "#1A1A2E" },
  { bg: "#FFFBEB", accent: "#D97706", highlight: "#059669", text: "#1A1A2E" },
];

// ── Emoji sets per icon type ──────────────────────────────────────────────────
const EMOJI_SETS = {
  "rupee":      ["💰", "💵", "🤑", "✨"],
  "wallet":     ["👛", "💳", "💸", "✨"],
  "chart":      ["📊", "📈", "💹", "⭐"],
  "trend-up":   ["📈", "🚀", "🔝", "✨"],
  "trend-down": ["📉", "😰", "⬇️", "❌"],
  "target":     ["🎯", "🏆", "⭐", "✅"],
  "house":      ["🏠", "🔑", "🌟", "✨"],
  "bank":       ["🏦", "💳", "🔐", "✨"],
  "lightbulb":  ["💡", "✨", "🌟", "⭐"],
  "brain":      ["🧠", "💭", "🤔", "✨"],
  "person":     ["🧑‍💼", "👤", "💼", "⭐"],
  "calendar":   ["📅", "⏰", "📆", "✨"],
  "coin-stack": ["🪙", "💰", "💎", "✨"],
  "arrow-up":   ["📈", "🚀", "⬆️", "✨"],
  "arrow-down": ["📉", "⬇️", "❌", "😰"],
};

// ── Utility ───────────────────────────────────────────────────────────────────
function hashSeed(input) {
  const text = String(input || "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function createRng(seedInput) {
  let seed = hashSeed(seedInput) || 1;
  return function next() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeOutCubic(t) {
  const x = clamp(t, 0, 1);
  return 1 - Math.pow(1 - x, 3);
}

function easeInOutCubic(t) {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

// Damped spring: overshoots then settles — gives emoji a lively bounce
function springBounce(t) {
  const x = clamp(t, 0, 1);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const omega = 2 * Math.PI * 2.5;
  const zeta  = 0.38;
  const decay = Math.exp(-zeta * omega * x);
  const freq  = Math.sqrt(1 - zeta * zeta) * omega;
  return 1 - decay * Math.cos(freq * x);
}

// ── Text measurement ──────────────────────────────────────────────────────────
const BOLD_FONT = '"Arial Black", "Impact", "Segoe UI Black", sans-serif';
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

const _measureCanvas = createCanvas(10, 10);
const _mctx = _measureCanvas.getContext("2d");

function measureTextWidth(text, fontSize) {
  _mctx.font = `900 ${fontSize}px ${BOLD_FONT}`;
  return _mctx.measureText(text).width;
}

// ── Keyword colour ────────────────────────────────────────────────────────────
function getKeywordColor(word, theme) {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/sip|profit|return|grow|rich|smart|achha|badh|save|invest/.test(w)) return theme.accent;
  if (/loss|debt|emi|risk|galti|broke|ghat|fail|nahi|kyun|kyu/.test(w))   return "#DC2626";
  if (/paisa|salary|cash|rupee|money|income|paise/.test(w))                 return "#D97706";
  if (/follow|subscribe|dekho|jaano|samjho/.test(w))                        return theme.accent;
  return theme.text;
}

// ── Text layout → array of positioned runs ───────────────────────────────────
function layoutTextRuns(text, box, theme) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  let fontSize = box.width >= 900 ? 92 : 80;
  let lines = [];

  while (fontSize >= 46) {
    lines = [];
    let line = [];
    let lineW = 0;

    for (const word of words) {
      const token = word + " ";
      const tw    = measureTextWidth(token, fontSize);
      if (line.length && lineW + tw > box.width - 30) {
        lines.push(line);
        line  = [];
        lineW = 0;
      }
      line.push({ text: token, color: getKeywordColor(word, theme) });
      lineW += tw;
    }
    if (line.length) lines.push(line);
    if (lines.length <= 5) break;
    fontSize -= 6;
  }

  const lineH   = fontSize * 1.38;
  const totalH  = lineH * lines.length;
  const startY  = box.y + Math.max(16, (box.height - totalH) / 2);
  const positioned = [];

  lines.forEach((line, li) => {
    const lineW = line.reduce((s, r) => s + measureTextWidth(r.text, fontSize), 0);
    let x = box.x + Math.max(0, (box.width - lineW) / 2);
    for (const run of line) {
      const rw = measureTextWidth(run.text, fontSize);
      positioned.push({ ...run, x, y: startY + li * lineH, width: rw, height: fontSize, fontSize });
      x += rw;
    }
  });

  return positioned;
}

// ── Bold text renderer with white stroke ─────────────────────────────────────
function drawBoldText(ctx, text, box, progress, theme) {
  if (!text || progress <= 0) return;

  const runs   = layoutTextRuns(text, box, theme);
  const letters = runs.flatMap((r) => r.text.split("").map((ch) => ({ ch, run: r })));
  const total  = Math.max(1, letters.length);
  const visible = clamp(Math.ceil(total * progress), 0, total);
  let counter  = 0;

  for (const run of runs) {
    const chars = run.text.split("");
    let x = run.x;

    for (const ch of chars) {
      const w   = measureTextWidth(ch || " ", run.fontSize);
      const lp  = clamp(visible - counter, 0, 1);
      counter++;

      if (lp <= 0) { x += w; continue; }

      const alpha = lp >= 1 ? 1 : easeOutCubic(lp);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `900 ${run.fontSize}px ${BOLD_FONT}`;
      ctx.textBaseline = "top";

      // Shadow for depth
      ctx.shadowColor  = "rgba(0,0,0,0.22)";
      ctx.shadowBlur   = run.fontSize * 0.18;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 4;

      // White outline stroke
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth   = run.fontSize * 0.14;
      ctx.lineJoin    = "round";
      ctx.strokeText(ch, x, run.y);

      // Coloured fill (no shadow on fill to avoid double shadow)
      ctx.shadowColor = "transparent";
      ctx.fillStyle   = run.color;
      ctx.fillText(ch, x, run.y);

      ctx.restore();
      x += w;
    }
  }
}

// ── Emoji renderer ────────────────────────────────────────────────────────────
function drawEmoji(ctx, emoji, cx, cy, size, alpha) {
  if (alpha <= 0 || size <= 0) return;
  ctx.save();
  ctx.globalAlpha  = alpha;
  ctx.font         = `${Math.round(size)}px ${EMOJI_FONT}`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, cx, cy);
  ctx.restore();
}

// Animate a single emoji with spring bounce + fade in
function drawEmojiAnimated(ctx, emoji, cx, cy, maxSize, progress, delay = 0) {
  const p = clamp((progress - delay) / Math.max(0.001, 1 - delay), 0, 1);
  if (p <= 0) return;

  const scale = springBounce(p);
  const alpha = clamp(p * 4, 0, 1);
  const size  = maxSize * Math.max(0, scale);

  // Soft glow ring behind emoji
  if (alpha > 0.15 && size > 60) {
    ctx.save();
    ctx.globalAlpha = alpha * 0.12;
    ctx.fillStyle   = "#FFD700";
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.65, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawEmoji(ctx, emoji, cx, cy, size, alpha);
}

// ── Resolve which emoji set to use for an element ────────────────────────────
function resolveEmojiSet(element) {
  let key;
  if (element.type === "arrow") {
    key = element.direction === "up" ? "arrow-up" : "arrow-down";
  } else {
    key = element.name || "coin-stack";
  }
  return EMOJI_SETS[key] || EMOJI_SETS["coin-stack"];
}

// ── Draw the whole emoji cluster for a scene ─────────────────────────────────
function drawEmojiScene(ctx, scene, box, progress) {
  const visuals = (scene.elements || []).filter(
    (e) => e.type !== "text" && e.type !== "highlight"
  );

  if (!visuals.length) {
    // Fallback: single coin-stack
    drawEmojiAnimated(ctx, "💰", box.x + box.width / 2, box.y + box.height * 0.38, 320, progress);
    drawEmojiAnimated(ctx, "✨", box.x + box.width * 0.7, box.y + box.height * 0.18, 100, progress, 0.3);
    drawEmojiAnimated(ctx, "💵", box.x + box.width * 0.3, box.y + box.height * 0.6,  110, progress, 0.45);
    return;
  }

  if (visuals.length === 1) {
    const emojis = resolveEmojiSet(visuals[0]);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height * 0.38;

    // Main hero emoji
    drawEmojiAnimated(ctx, emojis[0], cx, cy, 340, progress, 0);

    // Orbiting decorations
    const orbit = [
      { dx: -270, dy: -130, size: 140, delay: 0.22 },
      { dx:  280, dy:  -90, size: 125, delay: 0.32 },
      { dx: -190, dy:  210, size: 105, delay: 0.40 },
      { dx:  240, dy:  200, size: 115, delay: 0.35 },
    ];
    orbit.forEach((o, i) => {
      drawEmojiAnimated(ctx, emojis[i + 1] || "✨", cx + o.dx, cy + o.dy, o.size, progress, o.delay);
    });

  } else if (visuals.length === 2) {
    const cols = [
      { cx: box.x + box.width * 0.28, cy: box.y + box.height * 0.38, size: 260, delay: 0    },
      { cx: box.x + box.width * 0.72, cy: box.y + box.height * 0.42, size: 240, delay: 0.18 },
    ];
    visuals.slice(0, 2).forEach((el, i) => {
      const emojis = resolveEmojiSet(el);
      const c = cols[i];
      drawEmojiAnimated(ctx, emojis[0], c.cx, c.cy, c.size, progress, c.delay);
      drawEmojiAnimated(ctx, emojis[1] || "✨", c.cx + 110, c.cy - 80, 95, progress, c.delay + 0.18);
    });

  } else {
    // 3+ visuals: triangle arrangement
    const tri = [
      { cx: box.x + box.width * 0.50, cy: box.y + box.height * 0.27, size: 220, delay: 0    },
      { cx: box.x + box.width * 0.24, cy: box.y + box.height * 0.64, size: 200, delay: 0.16 },
      { cx: box.x + box.width * 0.76, cy: box.y + box.height * 0.64, size: 200, delay: 0.26 },
    ];
    visuals.slice(0, 3).forEach((el, i) => {
      const emojis = resolveEmojiSet(el);
      const c = tri[i];
      drawEmojiAnimated(ctx, emojis[0], c.cx, c.cy, c.size, progress, c.delay);
      drawEmojiAnimated(ctx, "✨", c.cx + 85, c.cy - 55, 75, progress, c.delay + 0.22);
    });
  }
}

// ── Themed background ─────────────────────────────────────────────────────────
function drawThemedBackground(ctx, theme) {
  // Solid base
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);

  // Large soft blob (bottom-right)
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle   = theme.accent;
  ctx.beginPath();
  ctx.arc(W * 0.88, H * 0.74, 420, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Small blob (top-left)
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.fillStyle   = theme.highlight;
  ctx.beginPath();
  ctx.arc(W * 0.14, H * 0.14, 210, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Top accent bar
  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, 0, W, 14);

  // Separator between text zone and visual zone
  ctx.save();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth   = 4;
  ctx.globalAlpha = 0.25;
  ctx.setLineDash([24, 14]);
  ctx.beginPath();
  ctx.moveTo(60, 652);
  ctx.lineTo(W - 60, 652);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ── Scene layout (fixed; only the API shape matters for renderer compat) ─────
function generateSceneLayout(scene, index) {
  return {
    layoutType: "top-text-bottom-animation",
    textBox:    { x: 60, y: 130, width: 960, height: 480 },
    visualBox:  { x: 60, y: 670, width: 960, height: 1110 },
    entry:      "scale",
    speed:      1.0,
    orderBias:  0.5,
    seed:       hashSeed(`${scene.text}|${index}|layout`),
    microShiftX: 0,
    microShiftY: 0,
    splitRows:   1,
  };
}

// ── normalizeElements (unchanged API) ─────────────────────────────────────────
function normalizeElements(scene) {
  if (Array.isArray(scene.elements) && scene.elements.length) {
    return scene.elements.slice(0, 4).map((e) => ({
      type:      String(e.type      || "icon").toLowerCase(),
      content:   String(e.content   || "").trim(),
      style:     String(e.style     || "normal").toLowerCase(),
      name:      String(e.name      || "").toLowerCase(),
      direction: String(e.direction || "up").toLowerCase(),
      animation: String(e.animation || "draw").toLowerCase(),
      keyword:   String(e.keyword   || "").trim(),
    }));
  }
  return [
    { type: "text",  content: scene.text, style: "highlight", animation: "slide", keyword: "" },
    { type: "icon",  name: "rupee",       animation: "draw",  keyword: "paisa" },
  ];
}

// ── Main render ───────────────────────────────────────────────────────────────
function renderScene(ctx, scenePlan, currentTime, frameIndex) {
  const { scene, layout, timings } = scenePlan;
  const sceneIndex = typeof timings.sceneIndex === "number" ? timings.sceneIndex : 0;
  const theme      = SCENE_THEMES[sceneIndex % SCENE_THEMES.length];

  // 1. Themed background (replaces the white fill from renderer)
  drawThemedBackground(ctx, theme);

  // 2. Text — appears quickly at scene start
  const textProgress = clamp(
    (currentTime - timings.textStart) / Math.max(0.001, timings.textEnd - timings.textStart),
    0, 1
  );
  drawBoldText(ctx, scene.text, layout.textBox, textProgress, theme);

  // 3. Emoji visuals — animate after text settles
  const drawProgress = clamp(
    (currentTime - timings.drawStart) / Math.max(0.001, timings.drawEnd - timings.drawStart),
    0, 1
  );
  drawEmojiScene(ctx, scene, layout.visualBox, drawProgress);
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  W, H, COLORS, TEXT_AREA, VISUAL_AREA, SCENE_THEMES,
  createRng, hashSeed, clamp, lerp, easeOutCubic, easeInOutCubic,
  normalizeElements, generateSceneLayout, renderScene,
};
