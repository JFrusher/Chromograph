/**
 * Animated export and capture, both native browser APIs.
 *
 * Recording drives `captureStream(0)`, whose track only emits a frame when asked.
 * That is the whole reason for using it: one `requestFrame()` per character means
 * the file contains exactly the frames intended, rather than whatever the
 * compositor happened to sample.
 *
 * Reading plays the file back and takes each presented frame via
 * `requestVideoFrameCallback`. Seeking is not frame-accurate in any browser, so
 * playback is the only reliable way through -- which costs real time, one frame
 * period per character.
 */

/** Frames per second of the exported animation, and so the decode's pace. */
export const ANIM_FPS = 10;

export type FrameDrawer = (ctx: CanvasRenderingContext2D, k: number) => void;

export function animationSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";
}

function pickMimeType(): string | null {
  for (const type of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export async function recordAnimation(opts: {
  width: number;
  height: number;
  frames: number;
  draw: FrameDrawer;
}): Promise<Blob> {
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error("This browser cannot record WebM.");

  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 12_000_000 });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  recorder.start();
  for (let k = 0; k < opts.frames; k++) {
    opts.draw(ctx, k);
    track.requestFrame();
    // The recorder timestamps by wall clock, so this wait is what sets the frame
    // rate. Without it every frame lands on the same timestamp and most are lost.
    await new Promise((r) => setTimeout(r, 1000 / ANIM_FPS));
  }
  // One extra beat so the final frame is not truncated by the stop.
  await new Promise((r) => setTimeout(r, 1000 / ANIM_FPS));
  recorder.stop();
  track.stop();
  return done;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
};

/** Hard cap, so a file that is not ours cannot spin forever. */
const MAX_FRAMES = 1200;

export async function framesFromVideo(file: File, onProgress?: (n: number) => void): Promise<ImageData[]> {
  const video = document.createElement("video") as VideoWithFrameCallback;
  if (typeof video.requestVideoFrameCallback !== "function") {
    throw new Error("This browser cannot read video frames. Try Chrome, Edge or Safari.");
  }

  const url = URL.createObjectURL(file);
  try {
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Could not read that video."));
    });

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context");

    const out: ImageData[] = [];
    await video.play();
    await new Promise<void>((resolve) => {
      const finish = () => resolve();
      video.onended = finish;
      const grab = () => {
        ctx.drawImage(video, 0, 0);
        out.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
        onProgress?.(out.length);
        if (video.ended || out.length >= MAX_FRAMES) return finish();
        video.requestVideoFrameCallback!(grab);
      };
      video.requestVideoFrameCallback!(grab);
    });
    video.pause();
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}
