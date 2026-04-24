"use strict";

const express    = require("express");
const router     = express.Router();
const path       = require("path");
const fs         = require("fs");
const { v4: uuidv4 } = require("uuid");
const ffmpeg     = require("fluent-ffmpeg");
const ffmpegBin  = require("ffmpeg-static");

const { generateScript, generateCaption } = require("../services/gemini");
const { generateAudio  } = require("../services/elevenlabs");
const { renderFrames   } = require("../services/renderer");

ffmpeg.setFfmpegPath(ffmpegBin);

const ROOT       = path.join(__dirname, "..");
const TEMP_BASE  = path.join(ROOT, "temp");
const OUTPUT_DIR = path.join(ROOT, "output");

// ─── Job store ────────────────────────────────────────────────────────────────
// Kept in-memory; survives tab switches / page refreshes as long as the
// server process lives (fine for Render — restarts only on new deploys).
const MAX_JOBS = 60;
const jobs     = new Map();   // jobId → job object

/**
 * @typedef {{
 *   id: string, topic: string,
 *   status: 'queued'|'processing'|'completed'|'failed',
 *   progress: number, step: string,
 *   videoUrl: string|null, caption: string|null, hashtags: string[],
 *   error: string|null, createdAt: string, updatedAt: string
 * }} Job
 */

function createJob(topic) {
  // Evict oldest entry when store is full
  if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);

  const job = {
    id:        uuidv4(),
    topic,
    status:    "queued",
    progress:  0,
    step:      "Queued…",
    videoUrl:  null,
    caption:   null,
    hashtags:  [],
    error:     null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  return job;
}

function patch(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
}

// ─── History (derived from completed jobs) ────────────────────────────────────
function getHistory() {
  return Array.from(jobs.values())
    .filter(j  => j.status === "completed")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10)
    .map(j => ({
      id:         j.id,
      topic:      j.topic,
      video_url:  j.videoUrl,
      caption:    j.caption,
      hashtags:   j.hashtags,
      created_at: j.createdAt,
    }));
}

// ─── Video encoder ────────────────────────────────────────────────────────────
function encodeVideo(framesDir, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, "frame_%04d.png")).inputOptions(["-framerate 30"])
      .input(audioPath)
      .videoCodec("libx264")
      .outputOptions(["-preset fast", "-crf 22", "-pix_fmt yuv420p", "-movflags +faststart", "-shortest"])
      .audioCodec("aac").audioBitrate("128k")
      .output(outputPath)
      .on("start", cmd => console.log("[ffmpeg]", cmd.slice(0, 120)))
      .on("end",   resolve)
      .on("error", (err, _o, stderr) =>
        reject(new Error(`FFmpeg: ${err.message}\n${(stderr || "").slice(-400)}`))
      )
      .run();
  });
}

// ─── Background job runner ────────────────────────────────────────────────────
async function runJob(jobId) {
  // Each job gets its own temp sub-dir — prevents concurrent-job collisions
  const jobTemp   = path.join(TEMP_BASE, jobId);
  const framesDir = path.join(jobTemp, "frames");
  const audioPath = path.join(jobTemp, "audio.mp3");
  const videoFile = `reel_${Date.now()}.mp4`;
  const videoPath = path.join(OUTPUT_DIR, videoFile);
  const videoUrl  = `/output/${videoFile}`;

  try {
    fs.mkdirSync(framesDir, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const job = jobs.get(jobId);
    if (!job) return;

    // ── 1 / 4  Script ─────────────────────────────────────────────────────────
    patch(jobId, { status: "processing", progress: 5, step: "Generating script…" });
    const scenes = await generateScript(job.topic);
    console.log(`[${jobId.slice(0,8)}] script: ${scenes.length} scenes`);

    // ── 2 / 4  Audio + Caption (parallel) ────────────────────────────────────
    patch(jobId, { progress: 20, step: "Creating voiceover…" });
    const narration = scenes.map(s => s.text).join(". ");
    const [, captionData] = await Promise.all([
      generateAudio(narration, audioPath),
      generateCaption(job.topic, scenes).catch(() => ({
        caption:  `${job.topic} ke baare mein yeh jaanna zaroori hai! 💰\nFollow karo tips ke liye! 🚀`,
        hashtags: ["#finance","#money","#SIP","#investing","#personalfinance",
                   "#wealth","#IndianFinance","#moneymanagement","#financetips","#paisa"],
      })),
    ]);
    console.log(`[${jobId.slice(0,8)}] audio + caption ready`);

    // ── 3 / 4  Render frames (real-time progress 42 → 80 %) ──────────────────
    patch(jobId, { progress: 42, step: "Rendering frames…" });
    await renderFrames(
      scenes, framesDir, job.topic,
      (pct) => {
        // Map 0–100 % frame render → 42–80 % overall
        patch(jobId, { progress: 42 + Math.round(pct * 0.38), step: "Rendering frames…" });
      },
      audioPath   // per-job audio path (not the legacy global)
    );
    console.log(`[${jobId.slice(0,8)}] frames done`);

    // ── 4 / 4  Encode ─────────────────────────────────────────────────────────
    patch(jobId, { progress: 82, step: "Encoding video…" });
    await encodeVideo(framesDir, audioPath, videoPath);
    console.log(`[${jobId.slice(0,8)}] encoded → ${videoFile}`);

    // ── Done ──────────────────────────────────────────────────────────────────
    patch(jobId, {
      status:   "completed",
      progress: 100,
      step:     "Done!",
      videoUrl,
      caption:  captionData.caption,
      hashtags: captionData.hashtags,
    });
    console.log(`[${jobId.slice(0,8)}] ✅ complete`);

  } catch (err) {
    console.error(`[${jobId.slice(0,8)}] ❌`, err.message);
    patch(jobId, { status: "failed", step: "Failed.", error: err.message });
  } finally {
    // Always clean up the per-job temp dir
    try { fs.rmSync(jobTemp, { recursive: true, force: true }); } catch (_) {}
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /generate
 * Creates a job immediately and starts async processing.
 * Returns { jobId, status } without waiting for the video.
 */
router.post("/", (req, res) => {
  const topic = (req.body.topic || "").trim();
  if (!topic) return res.status(400).json({ error: "topic is required" });

  const job = createJob(topic);
  console.log(`[${job.id.slice(0,8)}] job created: "${topic}"`);

  // Fire-and-forget — never await this
  runJob(job.id).catch(err => console.error("runJob unhandled:", err));

  return res.json({ jobId: job.id, status: job.status });
});

/**
 * GET /generate/status/:jobId
 * Polled by the frontend every 3 s.
 */
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  return res.json({
    jobId:    job.id,
    status:   job.status,    // queued | processing | completed | failed
    progress: job.progress,  // 0–100
    step:     job.step,
    videoUrl: job.videoUrl,
    caption:  job.caption,
    hashtags: job.hashtags,
    error:    job.error,
  });
});

/**
 * GET /generate/history
 * Returns last 10 completed reels.
 */
router.get("/history", (_req, res) => res.json(getHistory()));

module.exports = router;
