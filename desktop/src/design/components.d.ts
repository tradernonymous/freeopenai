/** The Design studio's token-bound component palette (UMD, node-tested). */
export interface DesignComponent {
  id: string;
  label: string;
  note: string;
  /** Rules using only the page's custom properties (var(--token, fallback)). */
  css: string;
  html: string;
}
export declare const COMPONENTS: DesignComponent[];
export declare function get(id: string): DesignComponent | null;
/** The component on its own: its <style data-neura-component> block and its markup. */
export declare function snippet(id: string): string;
/** The page with the component added (CSS once, markup before the last </main> or </body>). */
export declare function insertInto(html: string, id: string): string;
