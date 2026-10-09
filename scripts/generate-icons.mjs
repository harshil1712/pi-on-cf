// Generates the PWA icons from the π mark: an orange rounded square with a
// white π, matching src/components/pi-mark.tsx. No image tooling needed — the
// π is drawn from three rectangles into raw pixels and encoded as PNG.
//
// Usage: node scripts/generate-icons.mjs  (writes into public/)
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const BRAND = [0xf6, 0x82, 0x1f] // --color-pi-brand
const WHITE = [0xff, 0xff, 0xff]

/** The π of the mark as the three rectangles it reads as: a bar and two stems. */
const GLYPH = [
  { x0: 112, x1: 400, y0: 128, y1: 192 }, // bar
  { x0: 112, x1: 176, y0: 128, y1: 396 }, // left stem
  { x0: 336, x1: 400, y0: 128, y1: 396 }, // right stem
]

const rectDistance = (x, y, { x0, x1, y0, y1 }) =>
  Math.hypot(Math.max(x0 - x, x - x1, 0), Math.max(y0 - y, y - y1, 0))

const roundedRectDistance = (x, y, size, radius) => {
  const qx = Math.abs(x - size / 2) - (size / 2 - radius)
  const qy = Math.abs(y - size / 2) - (size / 2 - radius)
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

/** Anti-aliased coverage from a distance field: 1 inside, 0 outside, over a 1px edge. */
const coverage = (distance) => Math.min(Math.max(0.5 - distance, 0), 1)

/** Renders the icon at `size` px; `rounded` clips the corners, else it fills the square (as apple-touch-icon wants). */
function render(size, rounded) {
  const scale = size / 512
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Distances in the 512-space the design is drawn in, for a crisp edge at any size.
      const dx = (x + 0.5) / scale
      const dy = (y + 0.5) / scale
      const background = coverage(rounded ? roundedRectDistance(dx, dy, 512, 116) : Math.max(Math.abs(dx - 256) - 256, Math.abs(dy - 256) - 256))
      const glyph = Math.max(...GLYPH.map((rect) => coverage(rectDistance(dx, dy, rect))))
      const index = (y * size + x) * 4
      pixels[index] = BRAND[0] + (WHITE[0] - BRAND[0]) * glyph
      pixels[index + 1] = BRAND[1] + (WHITE[1] - BRAND[1]) * glyph
      pixels[index + 2] = BRAND[2] + (WHITE[2] - BRAND[2]) * glyph
      pixels[index + 3] = 255 * background
    }
  }
  return pixels
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function png(size, pixels) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  // One filter-type byte, zero, before each row.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const row = pixels.subarray(y * size * 4, (y + 1) * size * 4)
    raw.set(row, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [name, size, rounded] of [
  ['icon-512.png', 512, true],
  ['icon-192.png', 192, true],
  ['apple-touch-icon.png', 180, false],
]) {
  writeFileSync(`${OUT}/${name}`, png(size, render(size, rounded)))
  console.log(`public/${name}`)
}
