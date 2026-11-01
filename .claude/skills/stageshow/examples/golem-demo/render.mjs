// Renders one full loop of a stage to an H.264 MP4 at 2x, from screenshots.
// The stage's clock and every CSS animation run SLOW times slower (the same
// switches film.mjs --slow uses), so screenshots land every few ms of demo
// time; each output frame takes the shot nearest its time. The loop is cut
// from the second loop (the first has the cursor's entrance): from 400 ms
// before one `type` mark to 400 ms before the next, a calm frame both ends.
//
//   node examples/golem-demo/render.mjs <url> <out.mp4> [--width 1100] [--dark]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [url, out] = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const width = Number(flag('width', 1100))
const dark = process.argv.includes('--dark')
const SLOW = 8
const FPS = 30
const LEAD = 400

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width, height: 1400 }, deviceScaleFactor: 2 })
await page.addInitScript(([slow, dark]) => {
  window.__stageshow = { slow, ...(dark ? { theme: 'dark' } : {}) }
}, [SLOW, dark])
const cdp = await page.context().newCDPSession(page)
await cdp.send('Animation.enable')
await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW })
await page.goto(url)
const stage = page.locator('.ss-stage:visible').first()
await stage.waitFor()

const dir = mkdtempSync(join(tmpdir(), 'golem-render-'))
const shots = []
const types = []
let last = null
const start = Date.now()
while (types.length < 3) {
  const t = (Date.now() - start) / SLOW
  const mark = await stage.getAttribute('data-mark')
  if (mark === 'type' && last !== 'type') types.push(t)
  last = mark
  const file = join(dir, `shot-${shots.length}.png`)
  await stage.screenshot({ path: file })
  shots.push({ t, file })
  if (t > 90000) throw new Error('no loop seen in 90 s of demo time')
}
await browser.close()

const from = types[1] - LEAD
const to = types[2] - LEAD
const frames = join(dir, 'frames')
mkdirSync(frames)
let k = 0
for (let t = from; t < to; t += 1000 / FPS) {
  const nearest = shots.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
  execFileSync('cp', [nearest.file, join(frames, `f${String(k++).padStart(5, '0')}.png`)])
}
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', out])
const gaps = shots.slice(1).map((s, i) => s.t - shots[i].t)
console.log(`${out}: ${k} frames, loop ${((to - from) / 1000).toFixed(2)} s, ${shots.length} shots, median shot gap ${gaps.sort((a, b) => a - b)[gaps.length >> 1].toFixed(1)} ms of demo time`)
rmSync(dir, { recursive: true })
