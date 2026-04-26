"use strict";

const { createCanvas } = require("canvas");

// ── Canvas dimensions (720 × 1280 — 9:16 reel format) ────────────────────────
const W = 720;
const H = 1280;

// ── Utility math ──────────────────────────────────────────────────────────────
function clamp(v, lo, hi)  { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t)     { return a + (b - a) * t; }
function easeOutCubic(t)   { const x = clamp(t,0,1); return 1 - Math.pow(1-x,3); }
function easeInOutCubic(t) { const x = clamp(t,0,1); return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2; }
function easeOutBack(t)    { const x=clamp(t,0,1),c1=1.70158,c3=c1+1; return 1+c3*Math.pow(x-1,3)+c1*Math.pow(x-1,2); }

function springBounce(t) {
  const x = clamp(t,0,1);
  if (x<=0) return 0; if (x>=1) return 1;
  const omega=2*Math.PI*2.5, zeta=0.38;
  return 1 - Math.exp(-zeta*omega*x) * Math.cos(Math.sqrt(1-zeta*zeta)*omega*x);
}

function hashSeed(input) {
  let h = 0;
  for (let i=0; i<String(input).length; i++) h=(h*31+String(input).charCodeAt(i))>>>0;
  return h>>>0;
}

// ── Brand colour system ───────────────────────────────────────────────────────
// Purpose-driven themes — each scene type has a semantically meaningful palette.
const PURPOSE_THEMES = {
  hook:    { bg:"#FFFBF0", accent:"#FF6B35", highlight:"#FFD700", text:"#0F172A" }, // vivid orange — energy
  pain:    { bg:"#FFF1F2", accent:"#DC2626", highlight:"#F97316", text:"#0F172A" }, // red — danger
  reveal:  { bg:"#EFF6FF", accent:"#2563EB", highlight:"#F59E0B", text:"#0F172A" }, // blue — insight
  action:  { bg:"#F0FDF4", accent:"#16A34A", highlight:"#84CC16", text:"#0F172A" }, // green — go
  payoff:  { bg:"#ECFDF5", accent:"#059669", highlight:"#10B981", text:"#0F172A" }, // emerald — success
  cta:     { bg:"#FDF4FF", accent:"#7C3AED", highlight:"#A78BFA", text:"#0F172A" }, // purple — premium
  neutral: { bg:"#FFFBEB", accent:"#D97706", highlight:"#FCD34D", text:"#0F172A" }, // amber — fallback
};

// Legacy rotating themes — used as fallback for bridge/generic scenes
const SCENE_THEMES = [
  PURPOSE_THEMES.hook,
  PURPOSE_THEMES.pain,
  PURPOSE_THEMES.reveal,
  PURPOSE_THEMES.action,
  PURPOSE_THEMES.payoff,
  PURPOSE_THEMES.cta,
  PURPOSE_THEMES.neutral,
  { bg:"#F0FDFA", accent:"#0891B2", highlight:"#06B6D4", text:"#0F172A" },
];

const COLORS = {
  ink:"#1A1A2E", muted:"#3f3f46", paper:"#ffffff",
  blue:"#2563eb", green:"#16a34a", red:"#dc2626",
  yellow:"#fde047", orange:"#f97316",
};

function getThemeForScene(scene, sceneIndex) {
  const purpose = (scene && scene.scenePurpose) ? scene.scenePurpose : null;
  return (purpose && PURPOSE_THEMES[purpose])
    ? PURPOSE_THEMES[purpose]
    : SCENE_THEMES[sceneIndex % SCENE_THEMES.length];
}

// ── Seven layout configurations ───────────────────────────────────────────────
// All coordinates are for the 720 × 1280 canvas.
const LAYOUT_CONFIGS = {
  "center": {
    textBox:   { x:40,  y:87,  width:640, height:290 },
    visualBox: { x:40,  y:417, width:640, height:773 },
    textAlign: "center",
  },
  "split-left": {
    textBox:   { x:40,  y:87,  width:640, height:270 },
    visualBox: { x:40,  y:397, width:640, height:793 },
    textAlign: "left",
  },
  "split-right": {
    textBox:   { x:40,  y:87,  width:640, height:270 },
    visualBox: { x:40,  y:397, width:640, height:793 },
    textAlign: "right",
  },
  "stat-zoom": {
    textBox:   { x:40,  y:67,  width:640, height:180 },
    visualBox: { x:30,  y:287, width:660, height:903 },
    textAlign: "center",
    bigStat:   true,
  },
  "comparison": {
    textBox:   { x:40,  y:87,  width:640, height:210 },
    visualBox: { x:40,  y:337, width:640, height:853 },
    textAlign: "center",
    splitVisual: true,
  },
  "minimal": {
    textBox:   { x:70,  y:187, width:580, height:230 },
    visualBox: { x:60,  y:457, width:600, height:723 },
    textAlign: "center",
    dramatic:  true,
  },
  "cta": {
    textBox:   { x:40,  y:160, width:640, height:290 },
    visualBox: { x:40,  y:490, width:640, height:690 },
    textAlign: "center",
  },
};

// ── Rounded rectangle helper ──────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// ICON DRAWING LIBRARY — zero font/emoji dependency, pure canvas paths
// All signatures: (ctx, cx, cy, size, color)
// ══════════════════════════════════════════════════════════════════════════════

// ── Money bag with ₹ ─────────────────────────────────────────────────────────
function icoMoney(ctx, cx, cy, sz, col) {
  const r = sz*0.33;
  ctx.save();
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(cx, cy+sz*0.07, r, 0, Math.PI*2); ctx.fill();
  roundRect(ctx, cx-r*0.28, cy-r*0.85, r*0.56, r*0.52, r*0.12); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy-r*1.08, r*0.16, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.font = `bold ${sz*0.40}px Arial, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("\u20B9", cx, cy+sz*0.07);
  ctx.restore();
}

// ── Ascending bar chart ───────────────────────────────────────────────────────
function icoBarChart(ctx, cx, cy, sz, col) {
  const bw=sz*0.17, base=cy+sz*0.38, heights=[0.38,0.58,0.46,0.76];
  ctx.save(); ctx.fillStyle=col;
  heights.forEach((h,i) => {
    const x=cx-sz*0.38+i*(bw+sz*0.06), bh=sz*h;
    roundRect(ctx, x, base-bh, bw, bh, bw*0.28); ctx.fill();
  });
  const ax=cx+sz*0.38, ay=cy-sz*0.34;
  ctx.beginPath();
  ctx.moveTo(ax, ay-sz*0.13); ctx.lineTo(ax+sz*0.13, ay+sz*0.05);
  ctx.lineTo(ax+sz*0.05, ay+sz*0.05); ctx.lineTo(ax+sz*0.05, ay+sz*0.22);
  ctx.lineTo(ax-sz*0.05, ay+sz*0.22); ctx.lineTo(ax-sz*0.05, ay+sz*0.05);
  ctx.lineTo(ax-sz*0.13, ay+sz*0.05); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── Descending line chart ─────────────────────────────────────────────────────
function icoLineChartDown(ctx, cx, cy, sz, col) {
  ctx.save();
  ctx.strokeStyle=col; ctx.lineWidth=sz*0.09; ctx.lineCap="round"; ctx.lineJoin="round";
  ctx.beginPath();
  ctx.moveTo(cx-sz*0.40, cy-sz*0.26); ctx.lineTo(cx-sz*0.08, cy-sz*0.06);
  ctx.lineTo(cx+sz*0.14, cy+sz*0.10); ctx.lineTo(cx+sz*0.40, cy+sz*0.28); ctx.stroke();
  ctx.fillStyle=col;
  ctx.beginPath(); ctx.arc(cx+sz*0.40, cy+sz*0.28, sz*0.09, 0, Math.PI*2); ctx.fill();
  const ax=cx+sz*0.28, ay=cy+sz*0.42;
  ctx.beginPath();
  ctx.moveTo(ax, ay+sz*0.13); ctx.lineTo(ax+sz*0.13, ay-sz*0.05);
  ctx.lineTo(ax+sz*0.05, ay-sz*0.05); ctx.lineTo(ax+sz*0.05, ay-sz*0.22);
  ctx.lineTo(ax-sz*0.05, ay-sz*0.22); ctx.lineTo(ax-sz*0.05, ay-sz*0.05);
  ctx.lineTo(ax-sz*0.13, ay-sz*0.05); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── Calendar with grid dots ───────────────────────────────────────────────────
function icoCalendar(ctx, cx, cy, sz, col) {
  const w=sz*0.78, h=sz*0.72, x=cx-w/2, y=cy-h/2+sz*0.04, cr=sz*0.08;
  ctx.save(); ctx.fillStyle=col;
  roundRect(ctx, x, y, w, h, cr); ctx.fill();
  ctx.fillStyle="rgba(0,0,0,0.15)";
  roundRect(ctx, x, y, w, h*0.30, cr); ctx.fill(); ctx.fillRect(x, y+h*0.20, w, h*0.10);
  ctx.fillStyle=col;
  ctx.beginPath(); ctx.arc(cx-w*0.23, y, sz*0.06, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx+w*0.23, y, sz*0.06, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle="rgba(255,255,255,0.85)";
  const gx0=x+w*0.17, gy0=y+h*0.47, gxS=(w*0.66)/2, gyS=(h*0.42)/1;
  for (let r=0; r<2; r++) for (let c=0; c<3; c++) {
    ctx.beginPath(); ctx.arc(gx0+c*gxS, gy0+r*gyS, sz*0.045, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

// ── Lightbulb ─────────────────────────────────────────────────────────────────
function icoLightbulb(ctx, cx, cy, sz, col) {
  const r=sz*0.32, fy=cy-sz*0.07;
  ctx.save(); ctx.fillStyle=col;
  ctx.beginPath();
  ctx.arc(cx, fy-r*0.08, r, Math.PI, 0, false);
  ctx.lineTo(cx+r*0.44, fy+r*0.54); ctx.lineTo(cx-r*0.44, fy+r*0.54); ctx.closePath(); ctx.fill();
  ctx.fillRect(cx-r*0.38, fy+r*0.54, r*0.76, r*0.22);
  ctx.fillRect(cx-r*0.30, fy+r*0.76, r*0.60, r*0.20);
  ctx.fillStyle="rgba(255,255,255,0.22)";
  ctx.beginPath(); ctx.arc(cx-r*0.22, fy-r*0.32, r*0.17, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// ── Bullseye ──────────────────────────────────────────────────────────────────
function icoBullseye(ctx, cx, cy, sz, col) {
  ctx.save();
  const rings=[{r:sz*0.46,c:col},{r:sz*0.32,c:"rgba(255,255,255,0.92)"},{r:sz*0.19,c:col},{r:sz*0.08,c:"rgba(255,255,255,0.95)"}];
  rings.forEach(({r,c}) => {
    ctx.fillStyle=c; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
  });
  ctx.restore();
}

// ── Person ────────────────────────────────────────────────────────────────────
function icoPerson(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle=col;
  ctx.beginPath(); ctx.arc(cx, cy-sz*0.26, sz*0.18, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx, cy+sz*0.34, sz*0.34, Math.PI, 0, false); ctx.fill();
  ctx.restore();
}

// ── House ─────────────────────────────────────────────────────────────────────
function icoHouse(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle=col;
  ctx.beginPath();
  ctx.moveTo(cx, cy-sz*0.42); ctx.lineTo(cx+sz*0.44, cy-sz*0.04); ctx.lineTo(cx-sz*0.44, cy-sz*0.04);
  ctx.closePath(); ctx.fill();
  roundRect(ctx, cx-sz*0.30, cy-sz*0.04, sz*0.60, sz*0.42, sz*0.05); ctx.fill();
  ctx.fillStyle="rgba(255,255,255,0.85)";
  roundRect(ctx, cx-sz*0.09, cy+sz*0.11, sz*0.18, sz*0.27, sz*0.04); ctx.fill();
  ctx.restore();
}

// ── Bank / building ───────────────────────────────────────────────────────────
function icoBank(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle=col;
  ctx.beginPath();
  ctx.moveTo(cx, cy-sz*0.42); ctx.lineTo(cx+sz*0.44, cy-sz*0.18); ctx.lineTo(cx-sz*0.44, cy-sz*0.18);
  ctx.closePath(); ctx.fill();
  ctx.fillRect(cx-sz*0.44, cy-sz*0.18, sz*0.88, sz*0.08);
  [-0.26,0,0.26].forEach(dx => ctx.fillRect(cx+dx*sz-sz*0.06, cy-sz*0.10, sz*0.12, sz*0.38));
  ctx.fillRect(cx-sz*0.44, cy+sz*0.28, sz*0.88, sz*0.10);
  ctx.restore();
}

// ── Arrow (up or down) ────────────────────────────────────────────────────────
function icoArrow(ctx, cx, cy, sz, col, up) {
  const d = up ? -1 : 1;
  ctx.save(); ctx.fillStyle=col;
  ctx.beginPath();
  ctx.moveTo(cx,          cy+d*(-sz*0.40));
  ctx.lineTo(cx+sz*0.38,  cy+d*(-sz*0.08));
  ctx.lineTo(cx+sz*0.16,  cy+d*(-sz*0.08));
  ctx.lineTo(cx+sz*0.16,  cy+d*( sz*0.40));
  ctx.lineTo(cx-sz*0.16,  cy+d*( sz*0.40));
  ctx.lineTo(cx-sz*0.16,  cy+d*(-sz*0.08));
  ctx.lineTo(cx-sz*0.38,  cy+d*(-sz*0.08));
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── 4-point sparkle ───────────────────────────────────────────────────────────
function icoSparkle(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle=col;
  const r1=sz*0.44, r2=sz*0.17;
  ctx.beginPath();
  for (let i=0; i<8; i++) {
    const a=(i*Math.PI/4)-Math.PI/2, r=i%2===0?r1:r2;
    const px=cx+r*Math.cos(a), py=cy+r*Math.sin(a);
    i===0 ? ctx.moveTo(px,py) : ctx.lineTo(px,py);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

// ── Small coin ────────────────────────────────────────────────────────────────
function icoCoin(ctx, cx, cy, sz, col) {
  ctx.save(); ctx.fillStyle=col;
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.42, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle="rgba(255,255,255,0.5)";
  ctx.beginPath(); ctx.arc(cx, cy, sz*0.28, 0, Math.PI*2); ctx.fill();
  ctx.restore();
}

// ══════════════════════════════════════════════════════════════════════════════
// VISUAL METAPHOR SCENES — composed from icon primitives, one per metaphor type
// All signatures: (ctx, box, progress, theme) — box = {x,y,width,height}
// ══════════════════════════════════════════════════════════════════════════════

function metLeakingWallet(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.35, sz=Math.min(box.width,box.height)*0.34;
  drawIconAnimated(ctx, icoMoney, cx, cy, sz, theme.accent, progress, 0);
  // Dripping drops
  if (progress > 0.25) {
    const dp = clamp((progress-0.25)/0.75, 0, 1);
    ctx.save();
    ctx.fillStyle = "#DC2626";
    for (let i=0; i<5; i++) {
      const dx = cx + (i-2)*sz*0.18;
      const dy = cy + sz*0.40 + dp*sz*(0.8+i*0.12);
      const ds = sz*(0.055-i*0.004);
      const lp = clamp(dp*2-i*0.1, 0, 1);
      if (lp<=0) continue;
      ctx.globalAlpha=lp*0.85;
      ctx.beginPath(); ctx.arc(dx, dy, ds, 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }
  drawIconAnimated(ctx,(c,cx,cy,sz,col)=>icoArrow(c,cx,cy,sz,col,false),
    cx, cy+sz*0.90, sz*0.40, "#DC2626", progress, 0.45);
}

function metTreadmill(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.32;
  drawIconAnimated(ctx, icoPerson, cx, cy, sz, theme.accent, progress, 0);
  // Running arrows going nowhere (circular)
  if (progress > 0.3) {
    const ap=clamp((progress-0.3)/0.7,0,1);
    ctx.save();
    ctx.strokeStyle=theme.accent; ctx.lineWidth=sz*0.06; ctx.globalAlpha=ap*0.7;
    ctx.beginPath(); ctx.arc(cx, cy+sz*0.55, sz*0.45, 0, Math.PI*1.5); ctx.stroke();
    ctx.restore();
    drawIconAnimated(ctx,(c,cx,cy,sz,col)=>icoArrow(c,cx,cy,sz,col,false),
      cx+sz*0.45, cy+sz*0.55, sz*0.25, theme.accent, progress, 0.4);
  }
  // "Cycle" text hint
  drawIconAnimated(ctx, icoSparkle, cx-sz*0.7, cy-sz*0.4, sz*0.22, theme.highlight, progress, 0.5);
  drawIconAnimated(ctx, icoSparkle, cx+sz*0.7, cy-sz*0.2, sz*0.18, theme.highlight, progress, 0.6);
}

function metChainRupee(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.33;
  drawIconAnimated(ctx, icoMoney, cx, cy, sz, theme.accent, progress, 0);
  if (progress > 0.3) {
    const cp=clamp((progress-0.3)/0.7,0,1);
    ctx.save();
    ctx.strokeStyle="#DC2626"; ctx.lineWidth=sz*0.07; ctx.globalAlpha=cp*0.85;
    ctx.lineCap="round";
    // Chain links around the bag
    for (let i=0; i<4; i++) {
      const a=(i/4)*Math.PI*2-Math.PI/2, r=sz*0.55;
      const x1=cx+r*Math.cos(a), y1=cy+r*Math.sin(a);
      const x2=cx+r*Math.cos(a+Math.PI/4), y2=cy+r*Math.sin(a+Math.PI/4);
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
    ctx.restore();
    drawIconAnimated(ctx,(c,cx,cy,sz,col)=>icoArrow(c,cx,cy,sz,col,false),
      cx, cy+sz*1.0, sz*0.38, "#DC2626", progress, 0.5);
  }
}

function metMoneyTree(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.42, sz=Math.min(box.width,box.height)*0.36;
  // Tree trunk
  drawIconAnimated(ctx, (c,cx,cy,sz,col) => {
    c.save(); c.fillStyle=col;
    roundRect(c, cx-sz*0.08, cy, sz*0.16, sz*0.52, sz*0.04); c.fill();
    // Canopy tiers
    [[0,-0.52,0.52],[0,-0.80,0.40],[0,-1.0,0.28]].forEach(([dx,dy,r]) => {
      c.beginPath(); c.arc(cx+dx*sz, cy+dy*sz, r*sz, 0, Math.PI*2); c.fill();
    });
    c.restore();
  }, cx, cy, sz, theme.accent, progress, 0);
  // Coins on canopy
  const positions = [{dx:-0.28,dy:-0.80},{dx:0.25,dy:-0.72},{dx:0,dy:-0.95},{dx:-0.20,dy:-0.60},{dx:0.22,dy:-0.58}];
  positions.forEach((p,i) =>
    drawIconAnimated(ctx, icoCoin, cx+p.dx*sz, cy+p.dy*sz, sz*0.14, theme.highlight, progress, 0.25+i*0.08)
  );
}

function metSleepingMoney(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.34;
  drawIconAnimated(ctx, icoMoney, cx, cy, sz, theme.accent, progress, 0);
  drawIconAnimated(ctx, icoBank, cx+sz*0.72, cy-sz*0.15, sz*0.55, theme.highlight, progress, 0.25);
  // ZZZ text
  if (progress > 0.4) {
    const zp=clamp((progress-0.4)/0.6,0,1);
    ctx.save();
    ctx.globalAlpha=zp*0.75;
    ctx.fillStyle=theme.accent;
    ctx.font=`900 ${sz*0.30}px Arial Black, Impact, sans-serif`;
    ctx.textAlign="left"; ctx.textBaseline="middle";
    ctx.fillText("z z z", cx+sz*0.22, cy-sz*0.45);
    ctx.restore();
  }
}

function metShrinkingCoin(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.32;
  drawIconAnimated(ctx, icoCoin, cx-sz*0.62, cy, sz*0.52, theme.accent, progress, 0);
  drawIconAnimated(ctx,(c,cx,cy,sz,col)=>icoArrow(c,cx,cy,sz,col,false),
    cx, cy, sz*0.35, "#DC2626", progress, 0.25);
  drawIconAnimated(ctx, icoCoin, cx+sz*0.62, cy+sz*0.08, sz*0.32, theme.highlight, progress, 0.30);
  // "Inflation" label
  if (progress > 0.5) {
    const ip=clamp((progress-0.5)/0.5,0,1);
    ctx.save();
    ctx.globalAlpha=ip*0.8;
    ctx.fillStyle="#DC2626";
    ctx.font=`bold ${sz*0.22}px Arial, sans-serif`;
    ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("INFLATION", cx, cy+sz*0.72);
    ctx.restore();
  }
}

function metLightbulbRupee(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.37, sz=Math.min(box.width,box.height)*0.36;
  drawIconAnimated(ctx, icoLightbulb, cx, cy, sz, theme.accent, progress, 0);
  drawIconAnimated(ctx, icoMoney,     cx+sz*0.65, cy+sz*0.15, sz*0.42, theme.highlight, progress, 0.22);
  drawIconAnimated(ctx, icoSparkle,   cx-sz*0.55, cy-sz*0.40, sz*0.25, theme.highlight, progress, 0.35);
  drawIconAnimated(ctx, icoSparkle,   cx+sz*0.45, cy-sz*0.50, sz*0.20, theme.accent,    progress, 0.45);
}

function metBullseyeCoin(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.36;
  drawIconAnimated(ctx, icoBullseye, cx, cy, sz, theme.accent, progress, 0);
  drawIconAnimated(ctx, icoCoin,     cx, cy, sz*0.24, theme.highlight, progress, 0.30);
  drawIconAnimated(ctx,(c,cx,cy,sz,col)=>icoArrow(c,cx,cy,sz,col,true),
    cx+sz*0.70, cy-sz*0.30, sz*0.42, theme.accent, progress, 0.38);
}

function metCalendarGrowth(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.34;
  drawIconAnimated(ctx, icoCalendar, cx-sz*0.45, cy, sz*0.72, theme.accent,    progress, 0    );
  drawIconAnimated(ctx, icoBarChart, cx+sz*0.50, cy-sz*0.05, sz*0.60, theme.highlight, progress, 0.22);
}

function metSplitComparison(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.30;
  // Divider line
  if (progress > 0.1) {
    const lp=clamp((progress-0.1)/0.3,0,1);
    ctx.save();
    ctx.strokeStyle=theme.accent; ctx.lineWidth=3; ctx.globalAlpha=lp*0.4; ctx.setLineDash([8,5]);
    ctx.beginPath(); ctx.moveTo(cx, box.y+box.height*0.08); ctx.lineTo(cx, box.y+box.height*0.85); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }
  // Rich side (left = growing)
  drawIconAnimated(ctx, icoBarChart, cx-sz*0.70, cy, sz*0.80, "#16A34A",     progress, 0    );
  // Poor side (right = losing)
  drawIconAnimated(ctx, icoLineChartDown, cx+sz*0.70, cy, sz*0.80, "#DC2626", progress, 0.15);
}

function metRedStamp(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.38, sz=Math.min(box.width,box.height)*0.35;
  drawIconAnimated(ctx, icoMoney, cx, cy+sz*0.10, sz, theme.accent, progress, 0);
  if (progress > 0.3) {
    const sp=clamp((progress-0.3)/0.35,0,1);
    const ep=easeOutBack(sp);
    ctx.save();
    ctx.globalAlpha=sp*0.88;
    ctx.translate(cx, cy-sz*0.15);
    ctx.rotate(-0.18);
    ctx.scale(ep, ep);
    ctx.strokeStyle="#DC2626"; ctx.lineWidth=sz*0.085;
    ctx.strokeRect(-sz*0.62, -sz*0.22, sz*1.24, sz*0.44);
    ctx.fillStyle="#DC2626";
    ctx.font=`900 ${sz*0.34}px Arial Black, Impact, sans-serif`;
    ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText("GAUR KARO!", 0, 0);
    ctx.restore();
  }
}

function metArrowLaunch(ctx, box, progress, theme) {
  const cx=box.x+box.width/2, cy=box.y+box.height*0.42, sz=Math.min(box.width,box.height)*0.38;
  drawIconAnimated(ctx,(c,cx,cy,sz,col)=>icoArrow(c,cx,cy,sz,col,true),
    cx, cy, sz, theme.accent, progress, 0);
  drawIconAnimated(ctx, icoSparkle, cx-sz*0.55, cy+sz*0.35, sz*0.28, theme.highlight, progress, 0.28);
  drawIconAnimated(ctx, icoSparkle, cx+sz*0.55, cy+sz*0.20, sz*0.22, theme.highlight, progress, 0.38);
  drawIconAnimated(ctx, icoCoin,    cx,          cy+sz*0.60, sz*0.22, theme.accent,    progress, 0.45);
}

// ── Metaphor dispatch map ─────────────────────────────────────────────────────
const METAPHOR_FNS = {
  "leaking-wallet":   metLeakingWallet,
  "treadmill":        metTreadmill,
  "chain-rupee":      metChainRupee,
  "money-tree":       metMoneyTree,
  "sleeping-money":   metSleepingMoney,
  "shrinking-coin":   metShrinkingCoin,
  "lightbulb-rupee":  metLightbulbRupee,
  "bullseye-coin":    metBullseyeCoin,
  "calendar-growth":  metCalendarGrowth,
  "split-comparison": metSplitComparison,
  "red-stamp":        metRedStamp,
  "arrow-launch":     metArrowLaunch,
};

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

const ORBIT_FNS = [icoSparkle, icoCoin, icoSparkle, icoCoin];

// ── Animated icon renderer ────────────────────────────────────────────────────
function drawIconAnimated(ctx, iconFn, cx, cy, size, color, progress, delay=0) {
  const p = clamp((progress-delay)/Math.max(0.001,1-delay), 0, 1);
  if (p<=0) return;
  const scale=springBounce(p), alpha=clamp(p*4,0,1);
  if (alpha<=0||scale<=0) return;

  ctx.save();
  ctx.globalAlpha=alpha;
  ctx.translate(cx,cy); ctx.scale(scale,scale); ctx.translate(-cx,-cy);

  // Glow ring (only for large icons)
  if (alpha>0.15 && size>50) {
    ctx.globalAlpha=alpha*0.13; ctx.fillStyle="#FFD700";
    ctx.beginPath(); ctx.arc(cx,cy,size*0.62,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=alpha;
  }
  iconFn(ctx, cx, cy, size, color);
  ctx.restore();
}

// ── Generic icon cluster (used when no specific metaphor) ─────────────────────
// Purpose-keyed fallback icons — each scene purpose gets a semantically unique
// primary icon so the zero-visual fallback never repeats the same shape.
const PURPOSE_FALLBACK_FN = {
  hook:    icoMoney,
  pain:    icoLineChartDown,
  reveal:  icoLightbulb,
  action:  icoBarChart,
  payoff:  icoBullseye,
  cta:     icoPerson,
  neutral: icoCalendar,
};

function drawIconCluster(ctx, scene, box, progress, theme) {
  const col    = theme.accent;
  const decCol = theme.highlight;

  // Filter out text/highlight elements — only visual elements drive the cluster
  const rawVisuals = (scene.elements||[]).filter(e => e.type!=="text" && e.type!=="highlight");

  // Deduplicate visuals by icon name so the same icon never appears twice
  // in the same scene (e.g. two "person" entries from AI or override logic)
  const seenNames = new Set();
  const visuals   = rawVisuals.filter(el => {
    const key = el.type === "arrow" ? `arrow-${el.direction}` : (el.name || el.type);
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  if (!visuals.length) {
    // Fallback: use purpose-driven primary icon so no two scenes look identical
    const primaryFn = PURPOSE_FALLBACK_FN[scene.scenePurpose || "neutral"] || icoMoney;
    const cx = box.x+box.width/2, cy = box.y+box.height*0.36;
    drawIconAnimated(ctx, primaryFn, cx, cy, 213, col,    progress, 0);
    drawIconAnimated(ctx, icoSparkle, box.x+box.width*0.72, box.y+box.height*0.18,  67, decCol, progress, 0.30);
    drawIconAnimated(ctx, icoCoin,    box.x+box.width*0.28, box.y+box.height*0.58,  73, decCol, progress, 0.45);
    return;
  }

  if (visuals.length === 1) {
    const fn = resolveIconFn(visuals[0]);
    const cx = box.x+box.width/2, cy = box.y+box.height*0.36;
    drawIconAnimated(ctx, fn, cx, cy, 227, col, progress, 0);
    [{dx:-180,dy:-87,sz:93,delay:0.22},{dx:187,dy:-60,sz:83,delay:0.32},
     {dx:-127,dy:140,sz:70,delay:0.40},{dx:160, dy:133,sz:77,delay:0.35}]
      .forEach((o,i) => drawIconAnimated(ctx, ORBIT_FNS[i], cx+o.dx, cy+o.dy, o.sz, decCol, progress, o.delay));

  } else if (visuals.length === 2) {
    [{cx:box.x+box.width*0.28, cy:box.y+box.height*0.36, sz:173, delay:0   },
     {cx:box.x+box.width*0.72, cy:box.y+box.height*0.40, sz:160, delay:0.18}]
      .forEach((c,i) => {
        drawIconAnimated(ctx, resolveIconFn(visuals[i]), c.cx, c.cy, c.sz, col, progress, c.delay);
        drawIconAnimated(ctx, ORBIT_FNS[i], c.cx+73, c.cy-53, 63, decCol, progress, c.delay+0.18);
      });

  } else {
    [{cx:box.x+box.width*0.50, cy:box.y+box.height*0.25, sz:147, delay:0   },
     {cx:box.x+box.width*0.24, cy:box.y+box.height*0.60, sz:133, delay:0.16},
     {cx:box.x+box.width*0.76, cy:box.y+box.height*0.60, sz:133, delay:0.26}]
      .forEach((c,i) => {
        drawIconAnimated(ctx, resolveIconFn(visuals[i]), c.cx, c.cy, c.sz, col, progress, c.delay);
        drawIconAnimated(ctx, icoSparkle, c.cx+57, c.cy-37, 50, decCol, progress, c.delay+0.22);
      });
  }
}

// ── Visual area router ────────────────────────────────────────────────────────
function drawVisualArea(ctx, scene, box, progress, theme) {
  const metaphorFn = METAPHOR_FNS[scene.visualMetaphor || ""];
  if (metaphorFn) {
    metaphorFn(ctx, box, progress, theme);
  } else {
    drawIconCluster(ctx, scene, box, progress, theme);
  }
}

// ── Text measurement ──────────────────────────────────────────────────────────
const BOLD_FONT = '"Arial Black","Impact","Segoe UI Black",sans-serif';
const _mc=createCanvas(10,10), _mctx=_mc.getContext("2d");
function measureTextWidth(text, fontSize) {
  _mctx.font=`900 ${fontSize}px ${BOLD_FONT}`;
  return _mctx.measureText(text).width;
}

// ── Per-word colour tinting ───────────────────────────────────────────────────
function getKeywordColor(word, theme) {
  const w=word.toLowerCase().replace(/[^a-z0-9]/g,"");
  if (/sip|profit|return|grow|rich|smart|achha|badh|save|invest|karo|aaj|follow/.test(w)) return theme.accent;
  if (/loss|debt|emi|risk|galti|broke|ghat|fail|nahi|kyun|kyu|trap|danger/.test(w))       return "#DC2626";
  if (/paisa|salary|cash|rupee|money|income|paise/.test(w))                                return "#D97706";
  return theme.text;
}

// ── Text layout ───────────────────────────────────────────────────────────────
function layoutTextRuns(text, box, theme, textAlign="center") {
  const words=String(text||"").split(/\s+/).filter(Boolean);
  let fontSize=box.width>=600 ? 61 : 53;
  let lines=[];
  while (fontSize>=29) {
    lines=[]; let line=[], lineW=0;
    for (const word of words) {
      const token=word+" ", tw=measureTextWidth(token,fontSize);
      if (line.length && lineW+tw>box.width-20) { lines.push(line); line=[]; lineW=0; }
      line.push({ text:token, color:getKeywordColor(word,theme) });
      lineW+=tw;
    }
    if (line.length) lines.push(line);
    if (lines.length<=5) break;
    fontSize-=4;
  }
  const lineH=fontSize*1.38, totalH=lineH*lines.length;
  const startY=box.y+Math.max(11,(box.height-totalH)/2);
  const positioned=[];
  lines.forEach((line,li) => {
    const lineW=line.reduce((s,r)=>s+measureTextWidth(r.text,fontSize),0);
    let x;
    if (textAlign==="left")       x = box.x+20;
    else if (textAlign==="right") x = box.x+box.width-lineW-20;
    else                          x = box.x+Math.max(0,(box.width-lineW)/2);
    for (const run of line) {
      const rw=measureTextWidth(run.text,fontSize);
      positioned.push({...run,x,y:startY+li*lineH,width:rw,height:fontSize,fontSize});
      x+=rw;
    }
  });
  return positioned;
}

// ── Bold text renderer with smooth reveal (no flash) ─────────────────────────
function drawBoldText(ctx, text, box, progress, theme, emphasisWord="", textAlign="center") {
  if (!text||progress<=0) return;
  const runs=layoutTextRuns(text, box, theme, textAlign);
  const letters=runs.flatMap(r=>r.text.split("").map(ch=>({ch,run:r})));
  const total=Math.max(1,letters.length);
  const visible=clamp(Math.ceil(total*progress),0,total);
  let counter=0;

  for (const run of runs) {
    let x=run.x;
    const isEmphasis = emphasisWord &&
      run.text.trim().toLowerCase().startsWith(emphasisWord.toLowerCase().slice(0,5));

    for (const ch of run.text.split("")) {
      const w=measureTextWidth(ch||" ", run.fontSize);
      const lp=clamp(visible-counter,0,1); counter++;
      if (lp<=0) { x+=w; continue; }

      const alpha = lp>=1 ? 1 : easeOutCubic(lp);
      // Gentle slide-up: characters rise 5px as they appear, settle at 0
      const slideY = lp>=1 ? 0 : 5*(1-easeOutCubic(lp));

      ctx.save();
      ctx.globalAlpha=alpha;
      // Emphasis word: 8% larger
      const scale = isEmphasis ? 1.08 : 1.0;
      const fs    = run.fontSize * scale;
      ctx.font=`900 ${fs}px ${BOLD_FONT}`;
      ctx.textBaseline="top";
      // Softer shadow — was fs*0.18 / offset 2,3 (caused reflection artifact)
      ctx.shadowColor="rgba(0,0,0,0.18)"; ctx.shadowBlur=fs*0.06;
      ctx.shadowOffsetX=1; ctx.shadowOffsetY=2;
      ctx.strokeStyle="#FFFFFF"; ctx.lineWidth=fs*0.14; ctx.lineJoin="round";
      const dy = (isEmphasis ? run.y - (fs-run.fontSize)*0.5 : run.y) + slideY;
      ctx.strokeText(ch, x, dy);
      ctx.shadowColor="transparent"; ctx.fillStyle=run.color; ctx.fillText(ch, x, dy);
      ctx.restore();
      x+=w;
    }
  }

  // Emphasis underline (full word, drawn after all characters)
  if (emphasisWord && progress>0.7) {
    const emphP = clamp((progress-0.7)/0.3, 0, 1);
    for (const run of runs) {
      if (!run.text.trim().toLowerCase().startsWith(emphasisWord.toLowerCase().slice(0,5))) continue;
      const uw=measureTextWidth(run.text, run.fontSize);
      ctx.save();
      ctx.globalAlpha=emphP*0.85;
      ctx.strokeStyle=run.color; ctx.lineWidth=run.fontSize*0.07; ctx.lineCap="round";
      ctx.beginPath();
      ctx.moveTo(run.x,       run.y+run.fontSize*1.1);
      ctx.lineTo(run.x+uw*emphP, run.y+run.fontSize*1.1);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ── Themed background ─────────────────────────────────────────────────────────
function drawThemedBackground(ctx, theme) {
  // Base fill
  ctx.fillStyle=theme.bg; ctx.fillRect(0,0,W,H);

  // Large ambient circle (bottom-right)
  ctx.save(); ctx.globalAlpha=0.07; ctx.fillStyle=theme.accent;
  ctx.beginPath(); ctx.arc(W*0.87,H*0.72,290,0,Math.PI*2); ctx.fill(); ctx.restore();

  // Small ambient circle (top-left)
  ctx.save(); ctx.globalAlpha=0.06; ctx.fillStyle=theme.highlight;
  ctx.beginPath(); ctx.arc(W*0.13,H*0.13,145,0,Math.PI*2); ctx.fill(); ctx.restore();

  // Top accent stripe
  ctx.fillStyle=theme.accent; ctx.fillRect(0,0,W,9);

  // Subtle horizontal divider between text and visual zones
  ctx.save(); ctx.strokeStyle=theme.accent; ctx.lineWidth=2; ctx.globalAlpha=0.18;
  ctx.setLineDash([14,8]);
  ctx.beginPath(); ctx.moveTo(40,413); ctx.lineTo(W-40,413); ctx.stroke();
  ctx.setLineDash([]); ctx.restore();
}

// ── Subtle camera motion (ctx already in save state) ─────────────────────────
function applyCameraMotion(ctx, scenePurpose, sceneProgress) {
  // Max 2.5% zoom, 10px pan — imperceptible but adds life
  const p=easeOutCubic(clamp(sceneProgress,0,1));
  let s=1, tx=0, ty=0;

  switch (scenePurpose) {
    case "hook":   s=lerp(1.024,1.0,p);  break;  // slight zoom-in
    case "pain":   tx=lerp(-10,0,p);     break;  // pan right (unsettled)
    case "reveal": s=1.0+0.014*Math.sin(sceneProgress*Math.PI); break;  // pulse
    case "action": tx=lerp(10,0,p);      break;  // pan left (forward)
    case "payoff": s=lerp(1.018,1.0,p);  break;  // zoom-out (breath of relief)
    case "cta":    /* static */          break;
    default:       s=1+0.008*Math.sin(sceneProgress*Math.PI*2); // gentle breathe
  }

  ctx.translate(W/2+tx, H/2+ty);
  ctx.scale(s, s);
  ctx.translate(-W/2, -H/2);
}

// ── Hook burst — accent flash on first scene ──────────────────────────────────
function drawHookBurst(ctx, elapsed, theme) {
  if (elapsed>=0.22) return;
  const a=easeOutCubic(1-elapsed/0.22)*0.28;
  ctx.save();
  ctx.globalAlpha=a; ctx.fillStyle=theme.accent;
  ctx.fillRect(0,0,W,H);
  ctx.restore();
}

// ── Reveal flash — brief accent-colour pulse at reveal scene open ─────────────
// Replaces the old "Gaur Karo" stamp which overlapped scene content.
// Now it's the same style as the hook burst: a full-canvas colour wash that
// fades out in ~180 ms — noticeable but never blocking the visuals.
function drawRevealStamp(ctx, elapsed, scene, theme) {
  if (elapsed >= 0.18 || elapsed < 0) return;
  const a = easeOutCubic(1 - elapsed / 0.18) * 0.22;
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle   = theme.accent;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// ── Scene exit fade (within MICRO_PAUSE window) ───────────────────────────────
// Previously: a hard left-to-right colour-strip wipe — very jarring to the eye.
// Now: a smooth white flash that peaks at the mid-point of the transition and
// fades back out, like a camera shutter — barely perceptible but clean.
function drawSceneExit(ctx, t, _theme) {
  if (t <= 0) return;
  // sin(t·π) creates a bell curve: 0 → peak → 0 over the transition window
  const a = Math.sin(clamp(t, 0, 1) * Math.PI) * 0.42;
  if (a <= 0.005) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle   = "#FFFFFF";
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// ── Brand watermark ───────────────────────────────────────────────────────────
function drawWatermark(ctx, theme) {
  ctx.save();
  ctx.globalAlpha=0.32;
  const text="Rich Banega Bharat", fs=15, x=W-30, y=H-28;
  ctx.font=`bold ${fs}px Arial, sans-serif`;
  const tw=ctx.measureText(text).width;
  // Small accent dot before the brand name
  ctx.fillStyle=theme.accent;
  ctx.beginPath(); ctx.arc(x-tw-10, y-fs*0.3, 5, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle=theme.text;
  ctx.textAlign="right"; ctx.textBaseline="bottom";
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function drawProgressBar(ctx, fraction, theme) {
  ctx.save();
  ctx.strokeStyle="rgba(0,0,0,0.08)"; ctx.lineWidth=7; ctx.lineCap="round";
  ctx.beginPath(); ctx.moveTo(53,H-21); ctx.lineTo(W-53,H-21); ctx.stroke();
  ctx.strokeStyle=theme ? theme.accent : COLORS.blue;
  ctx.lineWidth=7;
  ctx.beginPath(); ctx.moveTo(53,H-21); ctx.lineTo(53+(W-106)*clamp(fraction,0,1),H-21); ctx.stroke();
  ctx.restore();
}

// ── Scene layout builder ──────────────────────────────────────────────────────
function generateSceneLayout(scene, index) {
  const layoutKey = (scene && scene.layout) ? scene.layout : "center";
  const cfg       = LAYOUT_CONFIGS[layoutKey] || LAYOUT_CONFIGS.center;
  return {
    layoutType:  layoutKey,
    textBox:     cfg.textBox,
    visualBox:   cfg.visualBox,
    textAlign:   cfg.textAlign   || "center",
    bigStat:     cfg.bigStat     || false,
    splitVisual: cfg.splitVisual || false,
    dramatic:    cfg.dramatic    || false,
    entry: "scale", speed:1.0, orderBias:0.5,
    seed: hashSeed(`${scene && scene.text}|${index}|layout`),
    microShiftX:0, microShiftY:0, splitRows:1,
  };
}

// ── Element normalisation (used by renderer.js) ───────────────────────────────
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
    { type:"text",  content:scene.text, style:"highlight", animation:"slide", keyword:"" },
    { type:"icon",  name:"rupee",        animation:"draw",  keyword:"paisa" },
  ];
}

// ── Main scene renderer ───────────────────────────────────────────────────────
function renderScene(ctx, scenePlan, currentTime) {
  const { scene, layout, timings } = scenePlan;
  const sceneIndex  = typeof timings.sceneIndex==="number" ? timings.sceneIndex : 0;
  const theme       = getThemeForScene(scene, sceneIndex);
  const textAlign   = layout.textAlign || "center";
  const emphasisWord= (scene && scene.emphasisWord) || "";
  const scenePurpose= (scene && scene.scenePurpose) || "action";

  // ── Scene progress values ─────────────────────────────────────────────────
  const sceneProgress  = clamp((currentTime-timings.sceneStart)/Math.max(0.001,timings.sceneEnd-timings.sceneStart),0,1);
  const textProgress   = clamp((currentTime-timings.textStart) /Math.max(0.001,timings.textEnd-timings.textStart),  0,1);
  const drawProgress   = clamp((currentTime-timings.drawStart) /Math.max(0.001,timings.drawEnd-timings.drawStart),  0,1);
  const transitionT    = timings.drawEnd < timings.sceneEnd
    ? clamp((currentTime-timings.drawEnd)/Math.max(0.001,timings.sceneEnd-timings.drawEnd),0,1)
    : 0;
  const elapsed = currentTime - timings.sceneStart;

  // ── Background ────────────────────────────────────────────────────────────
  drawThemedBackground(ctx, theme);

  // ── Camera motion (applied as transform on content layer) ─────────────────
  ctx.save();
  applyCameraMotion(ctx, scenePurpose, sceneProgress);

  // ── Text ──────────────────────────────────────────────────────────────────
  drawBoldText(ctx, scene.text, layout.textBox, textProgress, theme, emphasisWord, textAlign);

  // ── Visual area ───────────────────────────────────────────────────────────
  drawVisualArea(ctx, scene, layout.visualBox, drawProgress, theme);

  // ── Restore camera transform ──────────────────────────────────────────────
  ctx.restore();

  // ── Scene-specific overlays (drawn in screen space, not camera space) ─────

  // Hook: accent burst on open
  if (scenePurpose==="hook") drawHookBurst(ctx, elapsed, theme);

  // Reveal: dramatic stamp at start
  if (scenePurpose==="reveal" && elapsed>=0) drawRevealStamp(ctx, elapsed, scene, theme);

  // Scene exit wipe
  if (transitionT>0) drawSceneExit(ctx, transitionT, theme);

  // Watermark (always visible)
  drawWatermark(ctx, theme);
}

// ── Intro frame ───────────────────────────────────────────────────────────────
function drawIntroFrame(ctx, frame, INTRO_FPS) {
  const totalIntroFrames = INTRO_FPS || 12;
  const p     = clamp(frame/Math.max(1,totalIntroFrames),0,1);
  const eased = easeOutCubic(p);
  const theme = PURPOSE_THEMES.hook;

  ctx.fillStyle=theme.bg; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=theme.accent; ctx.fillRect(0,0,W,9);

  ctx.save();
  ctx.globalAlpha=eased;
  ctx.translate(W/2, H/2);

  // Animated coin icon in place of emoji
  icoMoney(ctx, 0, -67*eased, Math.round(133*eased), theme.accent);

  ctx.font=`900 ${Math.round(lerp(18,38,eased))}px Arial Black, Impact, sans-serif`;
  ctx.fillStyle=theme.text; ctx.textAlign="center"; ctx.textBaseline="top";
  ctx.fillText("Rich Banega Bharat", 0, 53);
  ctx.restore();

  drawWatermark(ctx, theme);
}

// ── Memory logging helper ─────────────────────────────────────────────────────
function logMemory(frame, totalFrames) {
  const m=process.memoryUsage(), mb=b=>Math.round(b/1024/1024);
  console.log(`[renderer] frame ${frame}/${totalFrames} | heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} MB | rss ${mb(m.rss)} MB`);
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  W, H, COLORS,
  SCENE_THEMES, PURPOSE_THEMES,
  clamp, lerp, easeOutCubic, easeInOutCubic,
  normalizeElements, generateSceneLayout, renderScene,
  drawIntroFrame, drawProgressBar, logMemory,
  getThemeForScene,
};
