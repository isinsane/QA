/**
 * The product's mark: two offset rounded squares, echoing the stacked-card
 * art in src/assets/hero.png rather than a generic icon-library glyph.
 * Rendered white-on-currentColor so it drops into .brand-mark's gradient box
 * everywhere the app shows it, and into the favicon (public/favicon.svg)
 * with the same shape hand-copied in since a static favicon can't share
 * component code.
 */
export function BrandMark({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="13" height="13" rx="3" stroke="currentColor" strokeWidth="1.8" opacity="0.55" />
      <rect x="8" y="8" width="13" height="13" rx="3" fill="currentColor" />
    </svg>
  )
}
