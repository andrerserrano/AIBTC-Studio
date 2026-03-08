# AIBTC Media — Batch Production Test Report

**Date:** March 8, 2026
**Test:** 6 cartoons through full production pipeline
**Purpose:** Confirm content quality, editorial, image generation, and humor before 8am launch

---

## Executive Summary

The content pipeline (ideation, captions, humor) is **strong and launch-ready**. The image generation layer (Gemini) is **not yet reliable** — the editor rejected all 6 cartoons, and after visual review I largely agree with the editor's calls. There is also a **launch-blocking env var bug** that will cause image generation to fail entirely in production.

**Bottom line:** Fix the env var bug, and you'll get images generating. But expect the editor to reject most first attempts — the production retry loop (up to 3 retries with editor feedback) will be doing heavy lifting. Some cartoons may take 2-3 retries to pass.

---

## 1. LAUNCH-BLOCKING BUG: Env Var Mismatch

Your `.env` file sets `GEMINI_API_KEY`, but `src/pipeline/generator.ts` uses `@ai-sdk/google` which reads `GOOGLE_GENERATIVE_AI_API_KEY`. There is **no mapping** anywhere in the production code (`src/config/`, `src/main.ts`).

**Impact:** Image generation will silently fail at launch.
**Fix:** Add this line to your `.env`:
```
GOOGLE_GENERATIVE_AI_API_KEY=<same value as GEMINI_API_KEY>
```
Or add a mapping in `src/main.ts` before any pipeline code runs:
```ts
if (process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY
}
```

---

## 2. Content Quality — STRONG

| Metric | Average | Range | Assessment |
|--------|---------|-------|------------|
| Topic scoring | 6.4 | 4.3–8.1 | Good signal selection |
| Self-critique (overall) | 7.6 | 6.8–8.3 | High bar maintained |
| Humor | 7.0 | 6–8 | Consistently witty |
| Clarity | 8.5 | 8–9 | Reads instantly |
| Shareability | 7.3 | 6–8 | Screenshot-worthy |

### Caption Highlights (all excellent)
- *"I created 50 agents to help me code. Now I debug 50 personalities."* (66 chars)
- *"My references? They're standing right behind me."* (48 chars)
- *"We automated everything except the meeting about automation."* (60 chars)
- *"Phase 1 complete. Phase 2: figure out what Phase 1 was supposed to do."*
- *"Chapter 3: Explaining compound interest to your humans."*

The ideation → critique → caption pipeline is producing consistently sharp, on-brand content. The New Yorker tone lands. Captions are all under 100 chars. The three-concept generation with self-critique is working as designed.

---

## 3. Image Generation — NEEDS WORK

**Editor approval rate: 0/6 (0%)**
**Average editor score: 3.8/10**

### Recurring Gemini Issues (by frequency)

1. **Text leaks in images** (6/6 cartoons) — Gemini renders readable text on whiteboards, signs, labels, documents despite the style prompt explicitly banning it. Worst offender: one image had "LIGHTNING NETWORK", "SMART CONTRACTS", "BLOCKCHAIN", "MINING", "DATA ANALYTICS" all visible.

2. **Robot eye/face anatomy** (5/6) — Eyes rendered as large rectangular bars or goggle-like shapes instead of small vertical orange rectangles on dark screens. Several robots have visible mouths/smiles, which violates the dark-screen-only face rule.

3. **Brand logos on devices** (4/6) — Apple-like logos appear on laptop backs. Laptops should be completely plain.

4. **Bitcoin ₿ too prominent** (3/6) — ₿ symbols on mugs and props are fine per the style guide, but Gemini sometimes makes them prominent or adds them to whiteboards.

5. **"AIBTC Media" text in image** (2/6) — The brand watermark text appeared in the actual image despite the prompt explicitly banning it.

6. **Too many characters** (2/6) — Crowd scenes with 20+ robots when the joke only needed 2-3.

### Visual Assessment of Each Cartoon

| # | Caption | Editor Score | My Visual Take |
|---|---------|:---:|---|
| 1 | "I created 50 agents..." | 5 | Concept is great, crowd works here since quantity IS the joke. Robot designs are acceptable but too many limbs in the crowd. |
| 2 | "My references?..." | 4 | Clean composition but only 1 robot instead of 3 needed for the joke. Robot is too smooth/3D, not enough ink-line cartoon feel. |
| 3 | "Finally, an AI that reads docs..." | 4 | Good duo composition. Hard hat + magnifying glass work. But ₿ mug, goggle-eyes, and squiggly text on papers. |
| 4 | "We automated everything..." | 3 | Whiteboard covered in readable text ("v2.0", "Q3 REVIEW"). This is the most common failure mode. |
| 5 | "The machine is teaching suits..." | 3 | "BLOCK" text on whiteboard, ₿ on board, Apple logos on laptops. Triple violation. |
| 6 | "Being the only option..." | 4 | Market stall is a creative scene. Robot design is decent. Cleanest of the batch but still has issues. |

### What's Working in Image Gen
- The monochrome + orange palette is **mostly respected** — images read as editorial cartoons
- Scene compositions are **legible** — you understand the joke visually in 2 seconds
- The caption compositing layer (sharp overlay) works perfectly — clean frame, orange divider, serif italic caption
- Orange robot eyes appear in most images (the brand signature)
- Environmental settings are appropriate and varied

---

## 4. The Editor Is Working Correctly

The editor is catching real issues. After reviewing all 6 images myself, I agree with the editor's calls — these would not meet the published quality bar. The editor is strict but appropriate. Its feedback is specific and actionable, which means the retry loop should improve results on subsequent attempts.

The production pipeline has retry logic (up to `config.maxImageRetries` retries per image), and the editor feedback gets passed back to Gemini. This batch test only ran 1 attempt per cartoon to test the full pipeline breadth. In production, the retry loop will likely get some cartoons through on attempt 2 or 3.

---

## 5. Performance

| Metric | Value |
|--------|-------|
| Average time per cartoon (end-to-end) | ~105 seconds |
| Image generation (Gemini) | ~30-40 seconds |
| Ideation + Critique + Caption (Claude) | ~40-50 seconds |
| Editor review (Claude multimodal) | ~15-20 seconds |
| Total test (6 cartoons, sequential) | ~10.5 minutes |

---

## 6. Launch Readiness Assessment

| Component | Status | Notes |
|-----------|--------|-------|
| News scanning (AIBTC + RSS) | ✅ Ready | Multi-source working, good signal diversity |
| Topic scoring | ✅ Ready | Worldview-weighted scoring producing relevant topics |
| Ideation (3 concepts) | ✅ Ready | Creative, on-brand, good variety |
| Self-critique | ✅ Ready | Honest scoring, catches weak concepts |
| Caption generation | ✅ Ready | Sharp, concise, New Yorker tone |
| Image generation (Gemini) | ⚠️ Functional but inconsistent | Text leaks and anatomy issues in ~100% of first attempts |
| Editor (multimodal review) | ✅ Ready | Catching real issues, specific feedback |
| Caption compositing (sharp) | ✅ Ready | Clean framing, perfect typography |
| Env var mapping | 🚨 BROKEN | `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY` not mapped |
| Retry loop | ✅ Built | Untested at scale — expect 2-3 attempts needed per cartoon |

### Recommendations Before Launch

1. **CRITICAL:** Fix the `GOOGLE_GENERATIVE_AI_API_KEY` env var mapping (5 min fix)
2. **HIGH:** Consider increasing `maxImageRetries` from 3 to 5 — with 0% first-attempt pass rate, you want headroom
3. **MEDIUM:** Consider adding a `stripTextFromVisual()` pass on the full prompt (not just the scene description) to further reduce text leak triggers
4. **MEDIUM:** Add explicit negative prompting for Apple logos: "laptop backs are plain flat rectangles with zero marks, logos, or symbols"
5. **LOW:** The editor prompt could emphasize that "crowd scenes are acceptable when quantity IS the joke" to avoid false rejections on swarm concepts

---

## 7. Files

All 6 composed cartoons are saved in `batch-test-results/` alongside this report.
Full JSON results: `.data-batch-test/batch-results.json`
Test script: `tests/test-batch-production.ts`
