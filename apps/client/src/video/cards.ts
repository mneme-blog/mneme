// Question title cards — the frames cut in before each answer clip.
//
// Rendered on the MAIN THREAD, not in the encoder worker: the bundled
// Newsreader/Hanken faces are loaded by the document, and worker FontFaceSet
// support for them is inconsistent across browsers. A card that silently falls
// back to a system font is the one defect that makes the whole film look cheap,
// so it is drawn where the fonts are certain and handed to the worker as an
// ImageBitmap (structured-cloneable, no pixel copy through JSON).
//
// The palette is read live from the document's CSS custom properties, so a film
// rendered under the Terminal skin in dark mode looks like the app the user is
// actually running — the same approach location/staticmap.ts takes for maps.

interface CardTheme {
  paper: string;
  ink: string;
  muted: string;
  accent: string;
  serif: string;
  mono: string;
}

function readTheme(): CardTheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback;
  return {
    paper: v('--paper', '#f4eee2'),
    ink: v('--ink', '#2a2521'),
    muted: v('--ink-3', '#a99f8e'),
    accent: v('--accent', '#b0563a'),
    serif: v('--serif', 'Georgia, serif'),
    mono: v('--mono', 'ui-monospace, monospace'),
  };
}

/** Greedy word wrap against a measured width; returns the lines that fit. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Draw one question card at the film's canonical size.
 * `n`/`total` render as a small counter so a viewer knows where they are.
 */
export async function renderTitleCard(
  text: string,
  n: number,
  total: number,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const theme = readTheme();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');

  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, width, height);

  const margin = Math.round(width * 0.11);
  const maxWidth = width - margin * 2;

  // Shrink until the question fits in four lines. Long questions are rare (the
  // prompt asks for one idea each) but a clipped card is unacceptable, and the
  // user can type any question they like in the plan step.
  let size = Math.round(height * 0.085);
  let lines: string[] = [];
  const minSize = Math.round(height * 0.04);
  for (;;) {
    ctx.font = `500 ${size}px ${theme.serif}`;
    lines = wrap(ctx, text, maxWidth);
    if (lines.length <= 4 || size <= minSize) break;
    size -= 2;
  }
  if (lines.length > 4) lines = [...lines.slice(0, 3), `${lines[3]}…`];

  const lineHeight = Math.round(size * 1.32);
  const blockHeight = lines.length * lineHeight;
  // Sit slightly above centre — optically centred once the counter is below.
  let y = Math.round((height - blockHeight) / 2 + lineHeight * 0.78);

  ctx.fillStyle = theme.ink;
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  for (const line of lines) {
    ctx.fillText(line, margin, y);
    y += lineHeight;
  }

  // A short accent rule under the text, then the counter.
  const ruleY = y - lineHeight + Math.round(size * 0.62);
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = Math.max(2, Math.round(height * 0.005));
  ctx.beginPath();
  ctx.moveTo(margin, ruleY);
  ctx.lineTo(margin + Math.round(width * 0.09), ruleY);
  ctx.stroke();

  ctx.font = `${Math.round(height * 0.033)}px ${theme.mono}`;
  ctx.fillStyle = theme.muted;
  ctx.fillText(`${n} / ${total}`, margin, ruleY + Math.round(height * 0.075));

  return createImageBitmap(canvas);
}
