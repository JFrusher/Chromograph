Here is the updated PRD incorporating a **modern, web-first architecture** designed for seamless deployment on **Vercel**.

I have added an interactive browser-based encoder/decoder built with React, Three.js/Canvas, and Tailwind CSS, along with a updated Claude Code prompt to execute the build.

---

# Product Requirement Document (PRD)

## Project Title: **Chromograph Web** (Visual Text-Path Encoder & Visual Steganography Studio)

### 1. Vision & Executive Summary

**Chromograph Web** is a browser-based generative art studio and visual steganography tool. It turns plain text into aesthetic, continuous vector curves across a 5x6 character grid.

Sequence order is encoded visually via a continuous HSV color spectrum, variable stroke geometry, and particle flow vectors. Users can encode text, tweak visual parameters (glow, tension, palette, grid display) in real time, export high-res artwork, and decode uploaded Chromograph images directly in their browser.

---

### 2. Core Web Objectives & Big Aims

* **Instant Vercel Deployment:** Zero-config serverless setup using Next.js (App Router) and Tailwind CSS.
* **Wallpaper-Grade Canvas Art:** Interactive 2D/3D visual output featuring bloom/glow effects, customizable color maps, animated particle flow, and smooth spline math.
* **Client-Side OpenCV Decoding:** In-browser decoding of uploaded images via WebAssembly (`opencv-js` or lightweight native Canvas pixel sampling).

---

### 3. Web Architecture & Feature Specifications

#### 3.1. Front-End Interface (Studio Dashboard)

* **Left Panel (Controls & Input):**
* Text input field (supports A-Z, space, period, comma, question mark; auto-sanitizes input).
* Preset visual themes (Cyberpunk Neon, Sunset Gradient, Deep Space Glow, Monochromatic Ink).
* Fine-tuning sliders: Spline Tension, Path Thickness, Glow Intensity, Particle Speed, Grid Visibility (0% to 100%).


* **Center Viewport (Interactive Canvas):**
* High-DPI HTML5 Canvas or WebGL (Three.js/Pixi.js) renderer.
* Real-time animation: Option to toggle a "flowing light" animation tracing the curve's direction over time.
* Export options: PNG (High-Res), SVG (Vector path for plotters/designers).


* **Right Panel / Tab (Decoder Suite):**
* Drag-and-drop target for uploading existing Chromograph images.
* Step-by-step visual breakdown showing color-mask extraction, centroid tracing, and decoded text output.



#### 3.2. Grid & Spatial Mapping

* **Dimensions:** 5 Rows × 6 Columns (30 node coordinates).
* **Character Set:** `A-Z` (0–25), `[SPACE]` (26), `.` (27), `,` (28), `?` (29).
* **Multi-Pass Spacing:** Re-visited characters trigger orbital parametric offsets $(r \cdot \cos\theta, r \cdot \sin\theta)$ around the cell center to avoid path overlapping.

#### 3.3. Rendering & Color Engine

* **Path Generation:** Centripetal Catmull-Rom or Cubic Bezier splines recalculated on input change.
* **Color Interpolation:** Linear interpolation through Hue space ($H(t) = t \times 360^\circ$) mapped across path length $L$.
* **Calibration Strip:** Configurable toggle to draw a discrete reference gradient bar at the canvas bottom for decoding accuracy.

---

### 4. Technical Stack Strategy

* **Framework:** Next.js 14+ (App Router)
* **Hosting:** Vercel (Edge Runtime ready)
* **Styling:** Tailwind CSS + Lucide Icons + Framer Motion
* **Rendering Engine:** HTML5 Canvas API / `three.js` / `lucide-react`
* **Image Processing (Decoder):** Canvas API Pixel Manipulation or `opencv-js`

---

## Claude Code Execution Prompt (Web Edition)

Copy and paste this prompt directly into **Claude Code**:

```markdown
I am sharing an updated PRD for a Vercel-hosted web application called "Chromograph Web". It's a generative art text-encoder and visual steganography engine.

Please review the PRD, critique the stack/architecture, ask any clarifying questions, propose a step-by-step implementation plan, and then build the full project for Vercel deployment.

---
BEGIN PRD
---

# Product Requirement Document: Chromograph Web

## 1. Overview
Chromograph Web encodes text into a continuous colored spline curve flowing across a 5x6 grid (mapping A-Z, space, '.', ',', '?'). Sequence direction is visually encoded via an HSV gradient (Red at start -> Rainbow -> Violet/Red at end). The app runs entirely in the browser and deploys seamlessly to Vercel.

## 2. Key Goals
1. High Visual Impact: Interactive dark-mode studio UI built with Next.js, Tailwind CSS, and HTML5 Canvas/Three.js. Features glow shaders, custom presets, particle flow, and vector/raster export.
2. In-Browser Decoder: Drag-and-drop tool that samples image pixel colors, follows the hue trajectory, maps centroids to grid cells, and decodes the string.
3. Vercel Ready: Next.js App Router structure with zero extra backend dependencies required.

## 3. App Structure & Requirements
- Web App Layout:
  - Sidebar: Text input, visual parameter sliders (tension, thickness, glow, speed), theme presets, and export buttons (PNG/SVG).
  - Main Viewport: Interactive 2D/3D canvas rendering the glowing curve, grid points, and optional path animation.
  - Decoder Drawer/Tab: Image upload dropzone, visual debug view (color mask tracing), and decoded text display.
- Core Algorithmic Requirements:
  - 5x6 Grid Coordinate mapping (30 slots).
  - Catmull-Rom spline path generation with deterministic offsets for repeated letters.
  - Continuous HSV hue gradient mapping along curve length t=0..1.
  - Discrete hue calibration bar rendered at canvas footer.

---
END PRD
---

Instructions for Claude Code:
1. Critique this PRD for web-specific rendering challenges, performance trade-offs (Canvas vs WebGL vs SVG), and client-side decoding reliability.
2. Ask me 3-4 concise questions regarding design preferences, tech stack constraints, or UI library choices.
3. Provide a phased plan to scaffold the Next.js app, implement the spline & visual engine, build the decoder, and prepare Vercel deployment scripts.

```