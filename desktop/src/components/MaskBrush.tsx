import { useCallback, useEffect, useRef, useState } from 'react';

// Paint the part of a picture that may change.
//
// Two canvases, because they answer two different people:
//
//   * the one on screen is for the person painting: it sits over the picture
//     at whatever size the layout gives it, and shows the strokes in a
//     translucent gold so the picture stays readable underneath;
//   * the mask itself is for sd-server: an offscreen canvas at the picture's
//     OWN pixel size, black everywhere, white where it may change. Measured
//     against a real sd-server with sd-v1-5-inpainting: white is repainted,
//     black is kept, and the RGBA PNG a canvas exports is accepted as the
//     one-channel mask the API documents -- every channel carries the same
//     black or white, so whichever one it reads says the same thing.
//
// The mask is handed back when a stroke ends, not on every pointer move: a
// PNG of a large picture takes a moment to encode, and nothing reads it until
// the person presses Change.

interface Props {
  /** The picture being changed, as a data: URL. */
  src: string;
  /** Its natural size: the mask is drawn at exactly this size. */
  width: number;
  height: number;
  /** A PNG data: URL of the mask, or null when nothing is painted. */
  onChange: (mask: string | null) => void;
}

const SHOWN = 'rgba(201, 169, 97, 0.55)';

export default function MaskBrush({ src, width, height, onChange }: Props) {
  const shown = useRef<HTMLCanvasElement>(null);
  const mask = useRef<HTMLCanvasElement | null>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const painted = useRef(false);
  // Brush size in the picture's own pixels, so a stroke covers the same part
  // of the picture however large the window happens to show it.
  const [size, setSize] = useState(() => Math.max(8, Math.round(Math.min(width, height) / 12)));
  const [erasing, setErasing] = useState(false);

  // A new picture starts with a clean mask: a region painted over the last
  // picture means nothing on this one.
  const reset = useCallback(() => {
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const ctx = off.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }
    mask.current = off;
    painted.current = false;
    const view = shown.current;
    if (view) {
      view.width = width;
      view.height = height;
      view.getContext('2d')?.clearRect(0, 0, width, height);
    }
  }, [width, height]);

  useEffect(() => {
    reset();
    onChange(null);
    // onChange is the parent's setter; re-running on its identity would wipe
    // the mask on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, reset]);

  /** Where the pointer is, in the picture's own pixels. */
  const at = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * width,
      y: ((event.clientY - box.top) / box.height) * height,
    };
  };

  const line = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const off = mask.current?.getContext('2d');
    const view = shown.current?.getContext('2d');
    if (!off || !view) return;
    for (const ctx of [off, view]) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = size;
    }
    // The mask: white may change, black stays -- erasing paints it back black.
    off.strokeStyle = erasing ? '#000' : '#fff';
    off.beginPath();
    off.moveTo(from.x, from.y);
    off.lineTo(to.x, to.y);
    off.stroke();
    // What the person sees: gold where it may change; erasing cuts it away.
    view.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
    view.strokeStyle = erasing ? '#000' : SHOWN;
    view.beginPath();
    view.moveTo(from.x, from.y);
    view.lineTo(to.x, to.y);
    view.stroke();
    view.globalCompositeOperation = 'source-over';
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = at(event);
    last.current = point;
    line(point, point);
    if (!erasing) painted.current = true;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!last.current) return;
    const point = at(event);
    line(last.current, point);
    last.current = point;
  };

  const finish = () => {
    if (!last.current) return;
    last.current = null;
    onChange(painted.current && mask.current ? mask.current.toDataURL('image/png') : null);
  };

  const clear = () => {
    reset();
    onChange(null);
  };

  return (
    <div className="mask-brush">
      <div className="mask-brush-stage" style={{ aspectRatio: `${width} / ${height}` }}>
        <img src={src} alt="The picture to change" draggable={false} />
        <canvas
          ref={shown}
          aria-label="Paint over the part that may change"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
          style={{ cursor: 'crosshair', touchAction: 'none' }}
        />
      </div>
      <div className="dictation-row">
        <button onClick={() => setErasing(false)} aria-pressed={!erasing}>Paint</button>
        <button onClick={() => setErasing(true)} aria-pressed={erasing}>Erase</button>
        <label className="settings-hint">
          Brush
          <input
            type="range"
            min={4}
            max={Math.max(32, Math.round(Math.min(width, height) / 3))}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
        </label>
        <button onClick={clear}>Clear</button>
      </div>
    </div>
  );
}
