import { useState } from 'react';
import {
  applyAccentHue,
  applyMaterial,
  readMaterial,
  saveMaterial,
  windowHasMica,
  applyReduceMotion,
  DEFAULT_ACCENT_HUE,
  readAccentHue,
  readReduceMotion,
  systemPrefersReducedMotion,
} from '../theme';

// Appearance, in Settings: the accent hue and the amount of motion. The hue
// is the only colour the person chooses; its lightness and strength are fixed
// per theme in index.css, so no hue can make accent text or a primary button
// unreadable.

const PRESETS: Array<{ name: string; hue: number }> = [
  { name: 'Green', hue: DEFAULT_ACCENT_HUE },
  { name: 'Teal', hue: 190 },
  { name: 'Blue', hue: 250 },
  { name: 'Violet', hue: 295 },
  { name: 'Rose', hue: 355 },
  { name: 'Amber', hue: 70 },
];

export default function AppearanceCard() {
  const [hue, setHue] = useState<number>(readAccentHue);
  const [reduced, setReduced] = useState<boolean>(readReduceMotion);
  const [material, setMaterial] = useState(readMaterial);
  const systemReduced = systemPrefersReducedMotion();
  // Asked once, on the shell's answer from boot: a machine that cannot show
  // Mica gets an explanation instead of a switch that changes nothing.
  const micaHere = windowHasMica();

  const pick = (value: number) => setHue(applyAccentHue(value));
  const reset = () => setHue(applyAccentHue(null));

  return (
    <div className="settings-card appearance-card">
      <div className="appearance-row">
        <label className="setting-label" htmlFor="accent-hue">Accent colour</label>
        <span className="appearance-hue-value" aria-hidden="true">{hue}°</span>
      </div>
      <input
        id="accent-hue"
        className="hue-slider"
        type="range"
        min={0}
        max={360}
        step={1}
        value={hue}
        onChange={(e) => pick(Number(e.target.value))}
        aria-valuetext={`Hue ${hue} degrees`}
      />
      <div className="appearance-row">
        <div className="swatches" role="group" aria-label="Preset accent colours">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              className={`swatch${hue === p.hue ? ' is-active' : ''}`}
              style={{ ['--swatch-h' as string]: String(p.hue) }}
              onClick={() => pick(p.hue)}
              aria-pressed={hue === p.hue}
              aria-label={p.name}
              title={p.name}
            />
          ))}
        </div>
        <button type="button" onClick={reset} disabled={hue === DEFAULT_ACCENT_HUE}>Reset</button>
      </div>
      <div className="appearance-preview" aria-hidden="true">
        <button type="button" className="primary" tabIndex={-1}>Primary</button>
        <span className="appearance-preview-link">Accent text</span>
        <span className="appearance-preview-chip">Selected</span>
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={material === 'mica'}
          disabled={!micaHere}
          onChange={(e) => {
            const wanted = saveMaterial(e.target.checked ? 'mica' : 'solid');
            applyMaterial(wanted, micaHere);
            setMaterial(wanted);
          }}
        />
        Window material (Mica)
      </label>
      <p className="settings-hint">
        {micaHere
          ? 'The sidebar, title bar and status bar sit on the Windows 11 material, so your wallpaper shows through them. Chat and cards stay solid.'
          : 'This machine does not offer Mica -- it needs Windows 11 with Transparency effects turned on -- so the window stays solid.'}
      </p>

      <label className="toggle">
        <input
          type="checkbox"
          checked={reduced}
          onChange={(e) => setReduced(applyReduceMotion(e.target.checked))}
        />
        Reduce motion
      </label>
      <p className="settings-hint">
        Stops transitions, the drifting background and the pointer parallax.
        {systemReduced && !reduced && ' Your system also asks for less motion, so most movement stays off anyway.'}
      </p>
    </div>
  );
}
