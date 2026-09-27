// Icon pipeline: render the Windows/tray icon set from the upstream brand
// artwork (`_upstream/apps/desktop/resources/icon.png`, 1024²) and assemble a
// multi-size `icon.ico` whose entries are PNG-compressed images. Run with the
// upstream workspace's `sharp` available:
//   node generate.mjs <source-icon.png> <output-dir>
// Outputs: icon.png (1024²), 32x32.png, 128x128.png, icon.ico (16..256).

import { createRequire } from 'node:module'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const require = createRequire(
  'file:///C:/Users/Yoova/OneDrive/Dokumen/Coding/dsh/_upstream/node_modules/.pnpm/sharp@0.35.3_@types+node@22.20.0/node_modules/sharp',
)
const sharp = require('sharp')

const [source, outDir] = process.argv.slice(2)
if (!source || !outDir) {
  console.error('usage: node generate.mjs <source-icon.png> <output-dir>')
  process.exit(1)
}
await mkdir(outDir, { recursive: true })

const original = await readFile(source)
await writeFile(join(outDir, 'icon.png'), await sharp(original).resize(1024, 1024).png().toBuffer())
await writeFile(join(outDir, '32x32.png'), await sharp(original).resize(32, 32).png().toBuffer())
await writeFile(join(outDir, '128x128.png'), await sharp(original).resize(128, 128).png().toBuffer())

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = []
for (const size of sizes) {
  pngs.push(await sharp(original).resize(size, size).png().toBuffer())
}
// ICO container with PNG entries (supported since Windows Vista).
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(sizes.length, 4)
const entries = []
let offset = 6 + 16 * sizes.length
for (let index = 0; index < sizes.length; index++) {
  const size = sizes[index]
  const png = pngs[index]
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size >= 256 ? 0 : size, 0)
  entry.writeUInt8(size >= 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2) // palette colors
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bit count
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += png.length
  entries.push(entry)
}
await writeFile(join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]))
console.log('icons written to', outDir)
