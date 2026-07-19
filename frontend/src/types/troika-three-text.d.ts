// troika-three-text ships no types of its own. It reaches us as a transitive
// dependency of @react-three/drei, whose <Text> is a thin wrapper over it, and
// PlaneVisual calls into it directly to warm the font cache that <Text> reads.
// Only the surface we actually use is declared.
declare module 'troika-three-text' {
  export interface PreloadFontOptions {
    font?: string
    characters?: string
    sdfGlyphSize?: number
  }
  export function preloadFont(options: PreloadFontOptions, callback: () => void): void

  export interface TextBuilderConfig {
    /** Font used when a <Text> names none. Null hands resolution to a CDN. */
    defaultFontURL?: string | null
  }
  export function configureTextBuilder(config: TextBuilderConfig): void
}
