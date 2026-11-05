// Builds images/demo.gif from the frames captured in images/raw.
import { readFileSync, writeFileSync } from 'node:fs'
import gifenc from 'gifenc'
import { PNG } from 'pngjs'

const { GIFEncoder, quantize, applyPalette } = gifenc
const raw = new URL('../images/raw/', import.meta.url)
const load = (name) => PNG.sync.read(readFileSync(new URL(`${name}.png`, raw)))

// Lens positions in the 1720x1330 frame, taken from the hero capture.
const LENS = {
  react: [195, 312, 705, 356],
  lucide: [658, 664, 1070, 708],
  drizzle: [234, 1072, 790, 1116],
}

function outline(png, [x0, y0, x1, y1]) {
  const out = new PNG({ width: png.width, height: png.height })
  png.data.copy(out.data)
  const amber = [245, 158, 11]
  for (let y = y0 - 4; y <= y1 + 4; y++) {
    for (let x = x0 - 4; x <= x1 + 4; x++) {
      const edge = x < x0 || x > x1 || y < y0 || y > y1
      const i = (y * png.width + x) * 4
      const mix = edge ? 1 : 0.14
      for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(out.data[i + c] * (1 - mix) + amber[c] * mix)
    }
  }
  return out
}

/** 2x box downscale, so the GIF stays small and text stays smooth. */
function half(png) {
  const w = png.width >> 1, h = png.height >> 1
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          sum += png.data[((y * 2 + dy) * png.width + x * 2 + dx) * 4 + c]
        }
        data[(y * w + x) * 4 + c] = sum >> 2
      }
    }
  }
  return { width: w, height: h, data }
}

const [f0, f1, f2, f3] = ['f0', 'f1', 'f2', 'f3'].map(load)
const frames = [
  [f0, 1000],
  [outline(f0, LENS.react), 1100],
  [f1, 900],
  [outline(f1, LENS.lucide), 1100],
  [f2, 900],
  [outline(f2, LENS.drizzle), 1100],
  [f3, 2800],
]

const gif = GIFEncoder()
for (const [png, delay] of frames) {
  const { width, height, data } = half(png)
  const palette = quantize(data, 256)
  gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay })
}
gif.finish()
writeFileSync(new URL('../images/demo.gif', import.meta.url), gif.bytes())
console.log('images/demo.gif', (gif.bytes().length / 1024).toFixed(0) + ' KB')
