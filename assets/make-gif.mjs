// Build the demo from real VS Code captures: before, hovered update, after.
import { readFileSync, writeFileSync } from 'node:fs'
import gifenc from 'gifenc'
import { PNG } from 'pngjs'

const { GIFEncoder, quantize, applyPalette } = gifenc
const gif = GIFEncoder()
let dimensions
for (const [name, delay] of [['f0', 1500], ['f1', 1800], ['f2', 3000]]) {
  const png = PNG.sync.read(readFileSync(new URL(`../images/raw/${name}.png`, import.meta.url)))
  const { width, height, data } = png
  if (dimensions && (dimensions[0] !== width || dimensions[1] !== height)) {
    throw new Error('Demo frames must have matching dimensions')
  }
  dimensions = [width, height]
  const palette = quantize(data, 256)
  gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay })
}
gif.finish()
writeFileSync(new URL('../images/demo.gif', import.meta.url), gif.bytes())
console.log('images/demo.gif', (gif.bytes().length / 1024).toFixed(0) + ' KB')
