#!/usr/bin/env node
// The customer demo's video: joins the filmed scenes (demo-results/results.json) into one
// portrait mp4 for a client, e2e/videos/customer-demo.mp4. Each scene opens on a title card;
// inside it the phone screen is shown at twice its size with the step's caption above it.
// Needs ffmpeg on PATH; cards and captions are rendered with Playwright's browser.
//
//   node scripts/demo-video.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const e2e = join(here, '..');
const report = JSON.parse(readFileSync(join(e2e, 'demo-results', 'results.json'), 'utf8'));
const out = join(e2e, 'videos');
const work = join(out, '.demo-work');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const [W, H, BAND] = [1080, 1920, 232];
const LEAD = 0.4;
const PHONE = { w: 780, h: 1688, x: 150, y: BAND };
const ENCODE = ['-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-an'];
const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Filmed scenes, in order, with their captions. */
const scenes = [];
const visit = (suite) => {
  for (const spec of suite.specs ?? []) {
    const m = spec.title.match(/^scene · (\d+) · (.+)$/);
    const r = spec.tests?.[0]?.results?.[0];
    if (!m || !r) continue;
    if (r.status !== 'passed') throw new Error(`scene ${m[1]} did not pass (${r.status}): film it again`);
    const video = r.attachments.filter((a) => a.name === 'video' && a.path && existsSync(a.path)).sort((a, b) => statSync(b.path).size - statSync(a.path).size)[0];
    // A caption is set at the tap that changes the screen; lead by LEAD so it lands with the tap.
    const captions = JSON.parse(Buffer.from(r.attachments.find((a) => a.name === 'captions').body, 'base64').toString('utf8')).map((c) => ({ ...c, at: Math.max(0, c.at - LEAD) }));
    scenes.push({ n: Number(m[1]), title: m[2], path: video.path, captions });
  }
  for (const child of suite.suites ?? []) visit(child);
};
for (const s of report.suites ?? []) visit(s);
scenes.sort((a, b) => a.n - b.n);
if (scenes.length === 0) throw new Error('no filmed scenes in demo-results/results.json: run the demo first');

const FONT = "font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
const shot = async (html, w, h, file) => {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(`<body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;${FONT}">${html}</body>`);
  await p.screenshot({ path: file });
  await p.close();
  return file;
};
const card = (kicker, title, sub = '') => `<div style="height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;padding:0 110px;background:#0f172a;color:#f8fafc">
  <p style="font-size:34px;letter-spacing:.1em;text-transform:uppercase;color:#93c5fd;margin:0">${esc(kicker)}</p>
  <h1 style="font-size:92px;line-height:1.1;margin:40px 0 0">${esc(title)}</h1>
  ${sub ? `<p style="font-size:40px;line-height:1.4;color:#cbd5e1;margin:44px 0 0">${esc(sub)}</p>` : ''}</div>`;
const still = (png, seconds, mp4) => ffmpeg(['-loop', '1', '-t', String(seconds), '-i', png, '-vf', `scale=${W}:${H},fps=30`, ...ENCODE, mp4]);

const parts = [];
still(await shot(card('JobWork', 'The customer app', 'Ordering a custom-made part on a phone — from enquiry to delivery.'), W, H, join(work, 'open.png')), 4, join(work, 'open.mp4'));
parts.push(join(work, 'open.mp4'));

for (const s of scenes) {
  const tag = String(s.n).padStart(2, '0');
  still(await shot(card(`Step ${s.n} of ${scenes.length}`, s.title), W, H, join(work, `${tag}-card.png`)), 2.5, join(work, `${tag}-card.mp4`));
  parts.push(join(work, `${tag}-card.mp4`));

  const inputs = [];
  const overlays = [];
  let last = '[base]';
  for (const [i, c] of s.captions.entries()) {
    const png = await shot(
      `<div style="height:100%;box-sizing:border-box;display:flex;align-items:center;padding:0 60px;background:#0f172a;color:#f8fafc;font-size:44px;line-height:1.25;font-weight:600">${esc(c.text)}</div>`,
      W,
      BAND,
      join(work, `${tag}-cap-${i}.png`),
    );
    inputs.push('-i', png);
    const end = s.captions[i + 1]?.at;
    const enable = end === undefined ? `gte(t,${c.at.toFixed(2)})` : `between(t,${c.at.toFixed(2)},${end.toFixed(2)})`;
    const next = `[v${i}]`;
    overlays.push(`${last}[${i + 2}:v]overlay=0:0:enable='${enable}'${next}`);
    last = next;
  }
  const filter = [
    `[1:v]scale=${PHONE.w}:${PHONE.h}:flags=lanczos,setsar=1[phone]`,
    `[0:v][phone]overlay=${PHONE.x}:${PHONE.y}:shortest=1[base]`,
    ...overlays,
  ].join(';');
  const mp4 = join(work, `${tag}-scene.mp4`);
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x0f172a:s=${W}x${H}:r=30`, '-i', s.path, ...inputs, '-filter_complex', filter, '-map', last, ...ENCODE, mp4]);
  parts.push(mp4);
}

still(await shot(card('JobWork', 'Custom parts, made and delivered', 'One accountable partner: quotation, production, inspection, delivery and documents — all in the app.'), W, H, join(work, 'close.png')), 4, join(work, 'close.mp4'));
parts.push(join(work, 'close.mp4'));
await browser.close();

mkdirSync(out, { recursive: true });
const list = join(work, 'list.txt');
writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
const target = join(out, 'customer-demo.mp4');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', target]);
rmSync(work, { recursive: true, force: true });
const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', target]).toString().trim());
console.log(`${scenes.length} scenes, ${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s: ${target}`);
