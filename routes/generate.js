"use strict";

const express    = require("express");
const router     = express.Router();
const path       = require("path");
const fs         = require("fs");
const ffmpeg     = require("fluent-ffmpeg");
const ffmpegBin  = require("ffmpeg-static");

const { generateScript, generateCaption } = require("../services/gemini");
const { generateAudio  } = require("../services/elevenlabs");
const { renderFrames   } = require("../services/renderer");

ffmpeg.setFfmpegPath(ffmpegBin);

// ─── Paths ────────────────────────────────────────────────────────────────────
const ROOT       = path.join(__dirname, "..");
const TEMP_DIR   = path.join(ROOT, "temp");
const FRAMES_DIR = path.join(TEMP_DIR, "frames");
const OUTPUT_DIR = path.join(ROOT, "output");
const AUDIO_PATH = path.join(TEMP_DIR, "audio.mp3");

// ─── In-memory history (last 10 reels) ───────────────────────────────────────
const MAX_HISTORY = 10;
const reelHistory = [];   // [{ id, topic, video_url, caption, hashtags, created_at }]

function addToHistory(entry) {
  reelHistory.unshift(entry);
  // Keep only last MAX_HISTORY entries; delete orphaned video files
  while (reelHistory.length > MAX_HISTORY) {
    const removed = reelHistory.pop();
    const oldFile = path.join(ROOT, removed.video_url.replace(/^\//, ""));
    try { if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile); } catch (_) {}
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ensureDirs() {
  [FRAMES_DIR, OUTPUT_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

function cleanup() {
  try {
    if (fs.existsSync(FRAMES_DIR)) fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
    if (fs.existsSync(AUDIO_PATH)) fs.unlinkSync(AUDIO_PATH);
  } catch (e) {
    console.warn("[cleanup]", e.message);
  }
}

function encodeVideo(framesDir, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, "frame_%04d.png"))
      .inputOptions(["-framerate 30"])
      .input(audioPath)
      .videoCodec("libx264")
      .outputOptions(["-preset fast", "-crf 22", "-pix_fmt yuv420p", "-movflags +faststart", "-shortest"])
      .audioCodec("aac")
      .audioBitrate("128k")
      .output(outputPath)
      .on("start", (cmd) => console.log("[ffmpeg] command:", cmd))
      .on("stderr", (line) => {
        if (line.includes("frame=") || line.includes("time="))
          process.stdout.write(`\r   ${line.trim()}`);
      })
      .on("end", () => { process.stdout.write("\n"); resolve(); })
      .on("error", (err, _stdout, stderr) => {
        process.stdout.write("\n");
        reject(new Error(`FFmpeg failed: ${err.message}\n${(stderr || "").slice(-600)}`));
      })
      .run();
  });
}

// ─── GET /generate/history ────────────────────────────────────────────────────
router.get("/history", (_req, res) => {
  res.json(reelHistory);
});

// ─── POST /generate ───────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const { topic } = req.body;
  if (!topic || typeof topic !== "string" || !topic.trim()) {
    return res.status(400).json({ error: "topic is required" });
  }

  const cleanTopic = topic.trim();
  ensureDirs();

  // Each reel gets a unique timestamped filename so history links stay valid
  const videoId   = Date.now();
  const videoFile = `reel_${videoId}.mp4`;
  const videoPath = path.join(OUTPUT_DIR, videoFile);
  const videoUrl  = `/output/${videoFile}`;

  try {
    // ── 1. Script ─────────────────────────────────────────────────────────────
    console.log(`\n[1/4] Generating script — "${cleanTopic}"`);
    const scenes = await generateScript(cleanTopic);
    const totalDuration = scenes.reduce((s, sc) => s + sc.duration, 0);
    console.log(`      ${scenes.length} scenes / ~${totalDuration}s total`);
    scenes.forEach((sc, i) =>
      console.log(`      [${i + 1}] "${sc.text}"  elements=${Array.isArray(sc.elements) ? sc.elements.length : 0}  ${sc.duration}s`)
    );

    // ── 2. Audio + Caption (parallel — they're independent) ───────────────────
    console.log("\n[2/4] Generating audio + caption in parallel …");
    const narration = scenes.map((sc) => sc.text).join(". ");

    const [, captionData] = await Promise.all([
      generateAudio(narration, AUDIO_PATH),
      generateCaption(cleanTopic, scenes).catch((err) => {
        console.warn("      Caption generation failed:", err.message);
        return {
          caption: `${cleanTopic} ke baare mein yeh jaanna zaroori hai! 💰\n\nAise aur tips ke liye follow karo! 🚀`,
          hashtags: ["#finance","#money","#SIP","#investing","#personalfinance","#wealth","#IndianFinance","#moneymanagement","#financetips","#paisa"],
        };
      }),
    ]);

    const audioStat = fs.statSync(AUDIO_PATH);
    console.log(`      Audio: ${(audioStat.size / 1024).toFixed(1)} KB`);
    console.log(`      Caption ready ✓`);

    // ── 3. Render frames ──────────────────────────────────────────────────────
    console.log("\n[3/4] Rendering frames …");
    const frameCount = await renderFrames(scenes, FRAMES_DIR, cleanTopic);
    console.log(`      ${frameCount} frames written`);

    // ── 4. Encode ─────────────────────────────────────────────────────────────
    console.log("\n[4/4] Encoding video …");
    await encodeVideo(FRAMES_DIR, AUDIO_PATH, videoPath);
    const videoStat = fs.statSync(videoPath);
    console.log(`      Saved: ${videoFile} (${(videoStat.size / (1024 * 1024)).toFixed(2)} MB)`);

    cleanup();
    console.log("\n✅ Done!\n");

    // ── Save to history ───────────────────────────────────────────────────────
    addToHistory({
      id:         videoId,
      topic:      cleanTopic,
      video_url:  videoUrl,
      caption:    captionData.caption,
      hashtags:   captionData.hashtags,
      created_at: new Date().toISOString(),
    });

    return res.json({
      video:    videoUrl,
      caption:  captionData.caption,
      hashtags: captionData.hashtags,
    });

  } catch (err) {
    cleanup();
    console.error("\n[ERROR]", err.message);
    return res.status(500).json({ error: err.message || "Video generation failed" });
  }
});

module.exports = router;
