/** Radial menu placement (UMD, shared with node:test). */
export interface RadialPoint {
  index: number;
  angle: number;
  x: number;
  y: number;
}

export interface RadialLayout {
  cx: number;
  cy: number;
  radius: number;
  itemSize: number;
  items: RadialPoint[];
}

export declare function place(input: {
  x?: number;
  y?: number;
  count?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  radius?: number;
  itemSize?: number;
  margin?: number;
}): RadialLayout;

export declare const RADIUS: number;
export declare const ITEM: number;
export declare const MARGIN: number;
