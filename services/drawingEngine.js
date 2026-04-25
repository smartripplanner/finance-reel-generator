"use strict";

const { createCanvas } = require("canvas");

// ── Canvas dimensions ─────────────────────────────────────────────────────────
const W = 720;
const H = 1280;

const TEXT_AREA   = { x: 40, y: 87,  width: 640, height: 320 };
const VISUAL_AREA = { x: 40, y: 453, width: 640, height: 733 };

// ── Colours ───────────────────────────────────────────────────────────────────
const COLORS = {
  ink: "#1A1A2E", muted: "#3f3f46", paper: "#ffffff",
  blue: "#2563eb", green: "#16a34a", red: "#dc2626",
  yellow: "#fde047", orange: "#f97316",
};

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

// ── Utility ───────────────────────────────────────────────────────────────────
function hashSeed(input) {
  let h = 0;
  for (let i = 0; i < String(input).length; i++)
    h = (h * 31 + String(input).charCodeAt(i)) >>> 0;
  return h >>> 0;
}
function createRng(seedInput) {
  let seed = hashSeed(seedInput) || 1;
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}
function clamp(v, lo, hi)  { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t)     { return a + (b - a) * t; }
function easeOutCubic(t)   { const x = clamp(t,0,1); return 1 - Math.pow(1-x,3); }
function easeInOutCubic(t) { const x = clamp(t,0,1); return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2; }

function springBounce(t) {
  const x = clamp(t,0,1);
  if (x<=0) return 0; if (x>=1) return 1;
  const omega = 2*Math.PI*2.5, zeta = 0.38;
  return 1 - Math.exp(-zeta*omega*x) * Math.cos(Math.sqrt(1-zeta*zeta)*omega*x);
}

// ── Canvas icon drawing library ───────────────────────────────────────────────
// All icons: (ctx, cx, cy, size, color)
// size = diameter of bounding circle. No emoji / font dependency.

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
}

// Money bag
function icoMoney(ctx, cx, cy, sz, col) {
  const r = sz * 0.33;
  ctx.save();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy + sz*0.07, r, 0, Math.PI*2); ctx.fill();
  roundRect(ctx, cx - r*0.28, cy - r*0.85, r*0.56, r*0.52, r*0.12); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy - r*1.08, r*0.16, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.font = `bold ${sz*0.40}px Arial, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("\u20B9", cx, cy + sz*0.07);  // ₹
  ctx.restore();
}

// Ascending bar chart with up-arrow badge
function icoBarChart(ctx, cx, cy, sz, col) {
  const bw = sz*0.17, base = cy + sz*0.38;
  const heights = [0.38, 0.58, 0.46, 0.76];
  ctx.save(); ctx.fillStyle = col;
  heights.forEach((h, i) => {
    const x = cx - sz*0.38 + i*(bw + sz*0.06), bh = sz*h;
    roundRect(ctx, x, base - bh, bw, bh, bw*0.28); ctx.fill();
  });
  // Up arrow (top-right)
  const ax = cx+sz*0.38, ay = cy-sz*0.34;
  ctx.beginPath();
  ctx.moveTo(ax,          ay-sz*0.13);
  ctx.lineTo(ax+sz*0.13,  ay+sz*0.05);
  ctx.lineTo(ax+sz*0.05,  ay+sz*0.05);
  ctx.lineTo(ax+sz*0.05,  ay+sz*0.22);
  ctx.lineTo(ax-sz*0.05,  ay+sz*0.22);
  ctx.lineTo(ax-sz*0.05,  ay+sz*0.05);
  ctx.lineTo(ax-sz*0.13,  ay+sz*0.05);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Descending line chart with down-arrow
function icoLineChartDown(ctx, cx, cy, sz, col) {
  ctx.save();
  ctx.strokeStyle = col; ctx.lineWidth = sz*0.09;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(cx-sz*0.40, cy-sz*0.26);
  ctx.lineTo(cx-sz*0.08, cy-sz*0.06);
  ctx.lineTo(cx+sz*0.14, cy+sz*0.10);
  ctx.lineTo(cx+sz*0.40, cy+sz*0.28);
  ctx.stroke();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx+sz*0.40, cy+sz*0.28, sz*0.09, 0, Math.PI*2); ctx.fill();
  // Down arrow
  const ax = cx+sz*0.28, ay = cy+sz*0.42;
  ctx.beginPath();
  ctx.moveTo(ax,         ay+sz*0.13);
  ctx.lineTo(ax+sz*0.13, ay-sz*0.05);
  ctx.lineTo(ax+sz*0.05, ay-sz*0.05);
  ctx.lineTo(ax+sz*0.05, ay-sz*0.22);
  ctx.lineTo(ax-sz*0.05, ay-sz*0.22);
  ctx.lineTo(ax-sz*0.05, ay-sz*0.05);
  ctx.lineTo(ax-sz*0.13, ay-sz*0.05);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Calendar with grid dots
function icoCalendar(ctx, cx, cy, sz, col) {
  const w = sz*0.78, h = sz*0.72;
  const x = cx-w/2, y = cy-h/2+sz*0.04;
  const cr = sz*0.08;
  ctx.save();
  ctx.fillStyle = col;
  roundRect(ctx, x, y, w, h, cr); ctx.fill();
  // Header darken
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  roundRect(ctx, x, y, w, h*0.30, cr); ctx.fill();
  ctx.fillRect(x, y+h*0.20, w, h*0.10);
  // Binding rings
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx-w*0.23, y, sz*0.06, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx+w*0.23, y, sz*0.06, 0, Math.PI*2); ctx.fill();
  // Grid dots
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const gx0 = x+w*0.17, gy0 = y+h*0.47;
  const gxS = (w*0.66)/2, gyS = (h*0.42)/1;
  for (let r=0; r<2; r++) for (let c=0; c<3; c++) {
    ctx.beginPath();
    ctx.arc(gx0+c*gxS, gy0+r*gyS, sz*0.045, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

// Lightbulb
function icoLightbulb(ctx, cx, cy, sz, col) {
  const r = sz*0.32, fy = cy-sz*0.07;
  ctx.save(); ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(cx, fy-r*0.08, r, Math.PI, 0, false);
  ctx.lineTo(cx+r*0.44, fy+r*0.54);
  ctx.lineTo(cx-r*0.44, fy+r*0.54);
  ctx.closePath(); ctx.fill();
  ctx.fillRect(cx-r*0.38, fy+r*0.54, r*0.76, r*0.22);
  ctx.fillRect(cx-r*0.30, fy+r*0.76, r*0.60, r*0.20);
  // Shine
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath(); ctx.arc(cx-r*0.22, fy-r*0.32, r*0.17, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// Bullseye / target
function icoBullseye(ctx, cx, cy, sz, col) {
  ctx.save();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.46, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.32, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.19, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.08, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// Person / user icon
function icoPerson(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy-sz*0.26, sz*0.18, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy+sz*0.34, sz*0.34, Math.PI, 0, false); ctx.fill();
  ctx.restore();
}

// House / home
function icoHouse(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle = col;
  // Roof
  ctx.beginPath();
  ctx.moveTo(cx,        cy-sz*0.42);
  ctx.lineTo(cx+sz*0.44, cy-sz*0.04);
  ctx.lineTo(cx-sz*0.44, cy-sz*0.04);
  ctx.closePath(); ctx.fill();
  // Body
  roundRect(ctx, cx-sz*0.30, cy-sz*0.04, sz*0.60, sz*0.42, sz*0.05); ctx.fill();
  // Door
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  roundRect(ctx, cx-sz*0.09, cy+sz*0.11, sz*0.18, sz*0.27, sz*0.04); ctx.fill();
  ctx.restore();
}

// Bank / building
function icoBank(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle = col;
  // Pediment
  ctx.beginPath();
  ctx.moveTo(cx, cy-sz*0.42);
  ctx.lineTo(cx+sz*0.44, cy-sz*0.18); ctx.lineTo(cx-sz*0.44, cy-sz*0.18);
  ctx.closePath(); ctx.fill();
  ctx.fillRect(cx-sz*0.44, cy-sz*0.18, sz*0.88, sz*0.08);
  // Three columns
  [-0.26,0,0.26].forEach(dx => {
    ctx.fillRect(cx+dx*sz-sz*0.06, cy-sz*0.10, sz*0.12, sz*0.38);
  });
  ctx.fillRect(cx-sz*0.44, cy+sz*0.28, sz*0.88, sz*0.10);
  ctx.restore();
}

// Up / down arrow
function icoArrow(ctx, cx, cy, sz, col, up) {
  const d = up ? -1 : 1;
  ctx.save(); ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(cx,          cy + d*(-sz*0.40));
  ctx.lineTo(cx+sz*0.38,  cy + d*(-sz*0.08));
  ctx.lineTo(cx+sz*0.16,  cy + d*(-sz*0.08));
  ctx.lineTo(cx+sz*0.16,  cy + d*( sz*0.40));
  ctx.lineTo(cx-sz*0.16,  cy + d*( sz*0.40));
  ctx.lineTo(cx-sz*0.16,  cy + d*(-sz*0.08));
  ctx.lineTo(cx-sz*0.38,  cy + d*(-sz*0.08));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// 4-pointed sparkle star (used for orbit decorations)
function icoSparkle(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle = col;
  const r1 = sz*0.44, r2 = sz*0.17;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i*Math.PI/4) - Math.PI/2;
    const r = i%2===0 ? r1 : r2;
    const px = cx + r*Math.cos(a), py = cy + r*Math.sin(a);
    i===0 ? ctx.moveTo(px,py) : ctx.lineTo(px,py);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Small coin (used as orbit decoration)
function icoCoin(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.42, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.28, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// ── Icon name → drawing function ──────────────────────────────────────────────
const ICON_FN = {
  "rupee":      icoMoney,
  "wallet":     icoMoney,
  "coin-stack": icoMoney,
  "chart":      icoBarChart,
  "trend-up":   icoBarChart,
  "trend-down": icoLineChartDown,
  "target":     icoBullseye,
  "house":      icoHouse,
  "bank":       icoBank,
  "lightbulb":  icoLightbulb,
  "brain":      icoLightbulb,
  "person":     icoPerson,
  "calendar":   icoCalendar,
  "arrow-up":   (ctx,cx,cy,sz,col) => icoArrow(ctx,cx,cy,sz,col,true),
  "arrow-down": (ctx,cx,cy,sz,col) => icoArrow(ctx,cx,cy,sz,col,false),
};
function resolveIconFn(element) {
  const key = element.type==="arrow"
    ? (element.direction==="up" ? "arrow-up" : "arrow-down")
    : (element.name || "coin-stack");
  return ICON_FN[key] || icoMoney;
}

// Orbit decorations cycle between sparkle and coin
const ORBIT_FNS = [icoSparkle, icoCoin, icoSparkle, icoCoin];

// ── Animated icon renderer ────────────────────────────────────────────────────
function drawIconAnimated(ctx, iconFn, cx, cy, size, color, progress, delay = 0) {
  const p = clamp((progress - delay) / Math.max(0.001, 1-delay), 0, 1);
  if (p <= 0) return;
  const scale = springBounce(p);
  const alpha = clamp(p * 4, 0, 1);
  if (alpha <= 0 || scale <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  // Glow ring
  if (alpha > 0.15 && size > 40) {
    ctx.globalAlpha = alpha * 0.13;
    ctx.fillStyle = "#FFD700";
    ctx.beginPath(); ctx.arc(cx, cy, size*0.62, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = alpha;
  }

  iconFn(ctx, cx, cy, size, color);
  ctx.restore();
}

// ── Scene icon cluster ────────────────────────────────────────────────────────
function drawIconScene(ctx, scene, box, progress, theme) {
  const col    = theme.accent;
  const decCol = theme.highlight;
  const visuals = (scene.elements||[]).filter(e => e.type!=="text" && e.type!=="highlight");

  if (!visuals.length) {
    // Fallback: single money bag + sparkle decorations
    drawIconAnimated(ctx, icoMoney,    box.x+box.width/2,   box.y+box.height*0.38, 213, col,    progress, 0);
    drawIconAnimated(ctx, icoSparkle,  box.x+box.width*0.7, box.y+box.height*0.18,  67, decCol, progress, 0.30);
    drawIconAnimated(ctx, icoCoin,     box.x+box.width*0.3, box.y+box.height*0.60,  73, decCol, progress, 0.45);
    return;
  }

  if (visuals.length === 1) {
    const fn = resolveIconFn(visuals[0]);
    const cx = box.x+box.width/2, cy = box.y+box.height*0.38;
    drawIconAnimated(ctx, fn, cx, cy, 227, col, progress, 0);
    const orbit = [
      { dx:-180, dy: -87, sz:93, delay:0.22 },
      { dx: 187, dy: -60, sz:83, delay:0.32 },
      { dx:-127, dy: 140, sz:70, delay:0.40 },
      { dx: 160, dy: 133, sz:77, delay:0.35 },
    ];
    orbit.forEach((o, i) => {
      drawIconAnimated(ctx, ORBIT_FNS[i], cx+o.dx, cy+o.dy, o.sz, decCol, progress, o.delay);
    });

  } else if (visuals.length === 2) {
    const cols = [
      { cx:box.x+box.width*0.28, cy:box.y+box.height*0.38, sz:173, delay:0    },
      { cx:box.x+box.width*0.72, cy:box.y+box.height*0.42, sz:160, delay:0.18 },
    ];
    visuals.slice(0,2).forEach((el,i) => {
      const c = cols[i];
      drawIconAnimated(ctx, resolveIconFn(el), c.cx, c.cy, c.sz, col, progress, c.delay);
      drawIconAnimated(ctx, ORBIT_FNS[i], c.cx+73, c.cy-53, 63, decCol, progress, c.delay+0.18);
    });

  } else {
    const tri = [
      { cx:box.x+box.width*0.50, cy:box.y+box.height*0.27, sz:147, delay:0    },
      { cx:box.x+box.width*0.24, cy:box.y+box.height*0.64, sz:133, delay:0.16 },
      { cx:box.x+box.width*0.76, cy:box.y+box.height*0.64, sz:133, delay:0.26 },
    ];
    visuals.slice(0,3).forEach((el,i) => {
      const c = tri[i];
      drawIconAnimated(ctx, resolveIconFn(el), c.cx, c.cy, c.sz, col, progress, c.delay);
      drawIconAnimated(ctx, icoSparkle, c.cx+57, c.cy-37, 50, decCol, progress, c.delay+0.22);
    });
  }
}

// ── Text measurement ──────────────────────────────────────────────────────────
const BOLD_FONT = '"Arial Black", "Impact", "Segoe UI Black", sans-serif';
const _mc = createCanvas(10,10), _mctx = _mc.getContext("2d");
function measureTextWidth(text, fontSize) {
  _mctx.font = `900 ${fontSize}px ${BOLD_FONT}`;
  return _mctx.measureText(text).width;
}

function getKeywordColor(word, theme) {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g,"");
  if (/sip|profit|return|grow|rich|smart|achha|badh|save|invest/.test(w)) return theme.accent;
  if (/loss|debt|emi|risk|galti|broke|ghat|fail|nahi|kyun|kyu/.test(w))   return "#DC2626";
  if (/paisa|salary|cash|rupee|money|income|paise/.test(w))                return "#D97706";
  if (/follow|subscribe|dekho|jaano|samjho/.test(w))                       return theme.accent;
  return theme.text;
}

// ── Text layout ───────────────────────────────────────────────────────────────
function layoutTextRuns(text, box, theme) {
  const words = String(text||"").split(/\s+/).filter(Boolean);
  let fontSize = box.width >= 600 ? 61 : 53;
  let lines = [];
  while (fontSize >= 31) {
    lines = []; let line=[], lineW=0;
    for (const word of words) {
      const token = word+" ", tw = measureTextWidth(token, fontSize);
      if (line.length && lineW+tw > box.width-20) { lines.push(line); line=[]; lineW=0; }
      line.push({ text: token, color: getKeywordColor(word,theme) });
      lineW += tw;
    }
    if (line.length) lines.push(line);
    if (lines.length <= 5) break;
    fontSize -= 4;
  }
  const lineH=fontSize*1.38, totalH=lineH*lines.length;
  const startY=box.y+Math.max(11,(box.height-totalH)/2);
  const positioned=[];
  lines.forEach((line,li) => {
    const lineW = line.reduce((s,r) => s+measureTextWidth(r.text,fontSize), 0);
    let x = box.x+Math.max(0,(box.width-lineW)/2);
    for (const run of line) {
      const rw=measureTextWidth(run.text,fontSize);
      positioned.push({...run,x,y:startY+li*lineH,width:rw,height:fontSize,fontSize});
      x+=rw;
    }
  });
  return positioned;
}

// ── Bold text renderer ────────────────────────────────────────────────────────
function drawBoldText(ctx, text, box, progress, theme) {
  if (!text || progress<=0) return;
  const runs=layoutTextRuns(text,box,theme);
  const letters=runs.flatMap(r=>r.text.split("").map(ch=>({ch,run:r})));
  const total=Math.max(1,letters.length);
  const visible=clamp(Math.ceil(total*progress),0,total);
  let counter=0;
  for (const run of runs) {
    let x=run.x;
    for (const ch of run.text.split("")) {
      const w=measureTextWidth(ch||" ",run.fontSize);
      const lp=clamp(visible-counter,0,1); counter++;
      if (lp<=0) { x+=w; continue; }
      const alpha=lp>=1?1:easeOutCubic(lp);
      ctx.save();
      ctx.globalAlpha=alpha;
      ctx.font=`900 ${run.fontSize}px ${BOLD_FONT}`;
      ctx.textBaseline="top";
      ctx.shadowColor="rgba(0,0,0,0.22)"; ctx.shadowBlur=run.fontSize*0.18;
      ctx.shadowOffsetX=2; ctx.shadowOffsetY=3;
      ctx.strokeStyle="#FFFFFF"; ctx.lineWidth=run.fontSize*0.14; ctx.lineJoin="round";
      ctx.strokeText(ch,x,run.y);
      ctx.shadowColor="transparent"; ctx.fillStyle=run.color; ctx.fillText(ch,x,run.y);
      ctx.restore(); x+=w;
    }
  }
}

// ── Themed background ─────────────────────────────────────────────────────────
function drawThemedBackground(ctx, theme) {
  ctx.fillStyle=theme.bg; ctx.fillRect(0,0,W,H);
  ctx.save(); ctx.globalAlpha=0.08; ctx.fillStyle=theme.accent;
  ctx.beginPath(); ctx.arc(W*0.88,H*0.74,280,0,Math.PI*2); ctx.fill(); ctx.restore();
  ctx.save(); ctx.globalAlpha=0.07; ctx.fillStyle=theme.highlight;
  ctx.beginPath(); ctx.arc(W*0.14,H*0.14,140,0,Math.PI*2); ctx.fill(); ctx.restore();
  ctx.fillStyle=theme.accent; ctx.fillRect(0,0,W,9);
  ctx.save(); ctx.strokeStyle=theme.accent; ctx.lineWidth=3; ctx.globalAlpha=0.25;
  ctx.setLineDash([16,9]);
  ctx.beginPath(); ctx.moveTo(40,435); ctx.lineTo(W-40,435); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();
}

// ── Scene layout ──────────────────────────────────────────────────────────────
function generateSceneLayout(scene, index) {
  return {
    layoutType:"top-text-bottom-animation",
    textBox:   { x:40, y:87,  width:640, height:320 },
    visualBox: { x:40, y:447, width:640, height:740 },
    entry:"scale", speed:1.0, orderBias:0.5,
    seed: hashSeed(`${scene.text}|${index}|layout`),
    microShiftX:0, microShiftY:0, splitRows:1,
  };
}

// ── Normalize elements ────────────────────────────────────────────────────────
function normalizeElements(scene) {
  if (Array.isArray(scene.elements) && scene.elements.length) {
    return scene.elements.slice(0,4).map(e => ({
      type:      String(e.type      ||"icon").toLowerCase(),
      content:   String(e.content   ||"").trim(),
      style:     String(e.style     ||"normal").toLowerCase(),
      name:      String(e.name      ||"").toLowerCase(),
      direction: String(e.direction ||"up").toLowerCase(),
      animation: String(e.animation ||"draw").toLowerCase(),
      keyword:   String(e.keyword   ||"").trim(),
    }));
  }
  return [
    { type:"text", content:scene.text, style:"highlight", animation:"slide", keyword:"" },
    { type:"icon", name:"rupee",       animation:"draw",  keyword:"paisa" },
  ];
}

// ── Main scene render ─────────────────────────────────────────────────────────
function renderScene(ctx, scenePlan, currentTime) {
  const { scene, layout, timings } = scenePlan;
  const sceneIndex = typeof timings.sceneIndex==="number" ? timings.sceneIndex : 0;
  const theme      = SCENE_THEMES[sceneIndex % SCENE_THEMES.length];

  drawThemedBackground(ctx, theme);

  const textProgress = clamp(
    (currentTime - timings.textStart) / Math.max(0.001, timings.textEnd-timings.textStart),
    0, 1
  );
  drawBoldText(ctx, scene.text, layout.textBox, textProgress, theme);

  const drawProgress = clamp(
    (currentTime - timings.drawStart) / Math.max(0.001, timings.drawEnd-timings.drawStart),
    0, 1
  );
  drawIconScene(ctx, scene, layout.visualBox, drawProgress, theme);
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  W, H, COLORS, TEXT_AREA, VISUAL_AREA, SCENE_THEMES,
  createRng, hashSeed, clamp, lerp, easeOutCubic, easeInOutCubic,
  normalizeElements, generateSceneLayout, renderScene,
};
