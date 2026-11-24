// Sample-mode watermark: a fixed, click-through overlay with large diagonal
// "SAMPLE" text tiled across the viewport. Rendered ONLY on the public
// sample entry page and inside sample-guest sessions -- never for regular
// (demo / production) tenant sessions. pointer-events: none, so it can
// never block interaction.

const TILE = (() => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='560' height='360'>`
    + `<text x='20' y='200' font-family='Arial, Helvetica, sans-serif' font-size='92' font-weight='700'`
    + ` fill='rgba(120, 72, 0, 0.10)' transform='rotate(-24 280 180)'>SAMPLE</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();

export function SampleWatermark() {
  return <div aria-hidden="true" className="sample-watermark" style={{ backgroundImage: TILE }} />;
}
