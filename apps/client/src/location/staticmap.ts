// Compose a static map image from OpenStreetMap raster tiles on a canvas, with
// pin marker(s) and (for a journey) a connecting line, then export it as a
// blob. This runs ONCE, when the user inserts a location; the resulting image
// is encrypted and stored like any photo, so opening the entry later never
// touches a tile server again. That one-time fetch is the whole privacy cost of
// the map (the relay only ever sees the encrypted image).
//
// OSM's tile CDN sends `Access-Control-Allow-Origin: *`, so tiles loaded with
// crossOrigin='anonymous' keep the canvas un-tainted and toBlob() succeeds.
import { project, fitView, TILE_SIZE, type GeoPoint } from './mercator';

const TILE_URL = (z: number, x: number, y: number): string =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

// Terracotta accent, baked in (canvas can't read CSS custom properties).
const PIN_FILL = '#b0563a';
const ROUTE = '#97462c';

export interface StaticMapResult {
  blob: Blob;
  width: number;
  height: number;
  zoom: number;
}

// A tile server that accepts the connection but never responds would otherwise
// stall renderStaticMap forever — and the insert dialog with it.
const TILE_TIMEOUT_MS = 15_000;

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = ''; // abort the fetch
      resolve(null);
    }, TILE_TIMEOUT_MS);
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null); // one missing tile shouldn't abort the map
    };
    img.src = TILE_URL(z, x, y);
  });
}

function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const r = 7;
  ctx.save();
  ctx.fillStyle = PIN_FILL;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  // Teardrop: a circle head over a downward point, tip sitting on (x, y).
  ctx.beginPath();
  ctx.arc(x, y - 2 * r, r, Math.PI * 0.15, Math.PI * 0.85, true);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y - 2 * r, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

/**
 * Render a frozen map framing `from` (and `to`, if given). Returns the encoded
 * image plus its pixel size and the zoom used.
 */
export async function renderStaticMap(opts: {
  from: GeoPoint;
  to?: GeoPoint | null;
  size?: { w: number; h: number };
}): Promise<StaticMapResult> {
  const w = opts.size?.w ?? 600;
  const h = opts.size?.h ?? 340;
  const points = opts.to ? [opts.from, opts.to] : [opts.from];
  const { center, zoom } = fitView(points, { w, h });

  const scale = Math.min(typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1, 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#e8e3d6';
  ctx.fillRect(0, 0, w, h);

  // Map a geographic point to a logical canvas coordinate.
  const centerWorld = project(center.lat, center.lng, zoom);
  const toCanvas = (p: GeoPoint): { x: number; y: number } => {
    const world = project(p.lat, p.lng, zoom);
    return { x: world.x - centerWorld.x + w / 2, y: world.y - centerWorld.y + h / 2 };
  };

  // Tile range covering the viewport (top-left/bottom-right world pixels).
  const tlx = centerWorld.x - w / 2;
  const tly = centerWorld.y - h / 2;
  const n = 2 ** zoom;
  const x0 = Math.floor(tlx / TILE_SIZE);
  const y0 = Math.floor(tly / TILE_SIZE);
  const x1 = Math.floor((tlx + w) / TILE_SIZE);
  const y1 = Math.floor((tly + h) / TILE_SIZE);

  const jobs: Promise<void>[] = [];
  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue; // above the north pole / below the south
      const wrappedX = ((tx % n) + n) % n; // wrap the antimeridian
      const dx = tx * TILE_SIZE - tlx;
      const dy = ty * TILE_SIZE - tly;
      jobs.push(
        loadTile(zoom, wrappedX, ty).then((img) => {
          if (img) ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
        }),
      );
    }
  }
  await Promise.all(jobs);

  // Route line (journey only): a white halo under the accent stroke for legibility.
  if (opts.to) {
    const a = toCanvas(opts.from);
    const b = toCanvas(opts.to);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = ROUTE;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  for (const p of points) {
    const c = toCanvas(p);
    drawPin(ctx, c.x, c.y);
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85),
  );
  if (!blob) throw new Error('Failed to encode map image');
  return { blob, width: w, height: h, zoom };
}
