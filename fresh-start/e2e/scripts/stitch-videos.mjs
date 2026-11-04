#!/usr/bin/env node
// FW.0: joins the full portal walk's recordings into one mp4 per portal and one for the
// whole run, in run order, each clip preceded by a two-second title card naming the
// chapter, the actor and the outcome. Reads the JSON report Playwright wrote
// (walk-results/results.json) and writes e2e/videos/. Needs ffmpeg on PATH; the cards are
// rendered with Playwright's browser, so no ffmpeg text filters are required.
//
//   node scripts/stitch-videos.mjs
//
// FW_MOBILE=1 (after a walk run in that mode) writes only the client cut instead:
// videos/customer-mobile.mp4, the customer's screens on a phone, in portrait, without the
// sweep chapter, the supplier's application or a clip whose test failed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const e2e = join(here, '..');
const MOBILE = process.env.FW_MOBILE === '1';
const [W, H] = MOBILE ? [780, 1688] : [1280, 800];
const report = JSON.parse(readFileSync(join(e2e, 'walk-results', 'results.json'), 'utf8'));
const out = join(e2e, 'videos');
const work = join(out, '.work');
rmSync(out, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** Every test with a recording, in the order it ran. */
const clips = [];
const visit = (suite, file) => {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const r = t.results?.[0];
      // A test can record several pages: axe opens a blank helper page for every check.
      // The page under test is the longest recording, so the largest file.
      const video = (r?.attachments ?? [])
        .filter((a) => a.name === 'video' && a.path && existsSync(a.path))
        .sort((a, b) => statSync(b.path).size - statSync(a.path).size)[0];
      if (video) clips.push({ title: spec.title, file: file ?? suite.file, status: r.status, start: Date.parse(r.startTime), duration: r.duration, path: video.path });
    }
  }
  for (const child of suite.suites ?? []) visit(child, file ?? suite.file);
};
for (const s of report.suites ?? []) visit(s, s.file);
clips.sort((a, b) => a.start - b.start);
if (MOBILE) {
  const keep = clips.filter((c) => c.status === 'passed' && /^(customer|public) ·/.test(c.title) && !c.file.includes('12-sweep') && !/supplier/.test(c.title));
  clips.splice(0, clips.length, ...keep);
}
if (clips.length === 0) throw new Error('no recordings in walk-results/results.json: run the walk first');

const portalOf = (title) => (title.startsWith('ops ·') ? 'operations' : title.startsWith('supplier ·') ? 'supplier' : title.startsWith('customer ·') ? 'customer' : 'public');
const ENCODE = ['-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-an'];
const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
/** "the approver accepts…" reads as a caption; a bare verb gets its subject back. */
const sentence = (s, who) => {
  const t = /^(the |a |an |every )/.test(s) ? s : `${who === 'public' ? 'A visitor' : 'The customer'} ${s}`;
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const browser = await chromium.launch(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {});
const card = await browser.newPage({ viewport: { width: W, height: H } });
for (const [n, c] of clips.entries()) {
  const chapter = c.file.replace(/^.*\//, '').replace(/\.spec\.ts$/, '');
  const [who, ...rest] = c.title.split(' · ');
  const ok = c.status === 'passed';
  if (MOBILE) {
    await card.setContent(`<body style="margin:0;height:${H}px;display:flex;flex-direction:column;justify-content:center;padding:0 64px;font-family:Helvetica,Arial,sans-serif;background:#0f172a;color:#f8fafc">
    <p style="font-size:26px;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;margin:0">JobWork customer app · ${n + 1} of ${clips.length}</p>
    <h1 style="font-size:60px;line-height:1.2;margin:36px 0">${esc(sentence(rest.join(' · ') || c.title, who))}</h1></body>`);
  } else await card.setContent(`<body style="margin:0;height:800px;display:flex;flex-direction:column;justify-content:center;padding:0 96px;font-family:Helvetica,Arial,sans-serif;background:#0f172a;color:#f8fafc">
    <p style="font-size:22px;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;margin:0">JobWork full portal walk · ${esc(chapter)} · ${n + 1}/${clips.length}</p>
    <h1 style="font-size:54px;line-height:1.15;margin:28px 0">${esc(rest.join(' · ') || c.title)}</h1>
    <p style="font-size:28px;margin:0;color:#cbd5e1">${esc(who)} portal · <span style="color:${ok ? '#86efac' : '#fca5a5'}">${ok ? 'passed' : esc(c.status)}</span> · ${(c.duration / 1000).toFixed(1)} s</p></body>`);
  const png = join(work, `${String(n).padStart(3, '0')}-card.png`);
  await card.screenshot({ path: png });
  c.card = join(work, `${String(n).padStart(3, '0')}-card.mp4`);
  c.mp4 = join(work, `${String(n).padStart(3, '0')}-clip.mp4`);
  ffmpeg(['-loop', '1', '-t', '2', '-i', png, '-vf', `scale=${W}:${H}`, ...ENCODE, c.card]);
  // Playwright does not scale a page up to the video size: a 390-wide phone fills the top
  // left quarter of the 780 × 1688 frame, so crop it and double it.
  if (MOBILE) ffmpeg(['-i', c.path, '-vf', `crop=${W / 2}:${H / 2}:0:0,scale=${W}:${H}:flags=lanczos`, ...ENCODE, c.mp4]);
  else ffmpeg(['-i', c.path, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`, ...ENCODE, c.mp4]);
}
await browser.close();

const seconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
const stamp = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const index = ['# JobWork full portal walk — recordings', '', `${clips.length} chapters · ${clips.filter((c) => c.status === 'passed').length} passed`, ''];
const groups = MOBILE ? [['customer-mobile', clips]] : [
  ['00-full-walk', clips],
  ['01-operations', clips.filter((c) => portalOf(c.title) === 'operations')],
  ['02-customer', clips.filter((c) => portalOf(c.title) === 'customer' || portalOf(c.title) === 'public')],
  ['03-supplier', clips.filter((c) => portalOf(c.title) === 'supplier')],
];
for (const [name, list] of groups) {
  if (list.length === 0) continue;
  const listFile = join(work, `${name}.txt`);
  writeFileSync(listFile, list.flatMap((c) => [`file '${c.card}'`, `file '${c.mp4}'`]).join('\n'));
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', join(out, `${name}.mp4`)]);
  index.push(`## ${name}.mp4`, '', '| Start | Chapter | Result |', '|---|---|---|');
  let at = 0;
  for (const c of list) {
    index.push(`| ${stamp(at)} | ${c.title} | ${c.status} |`);
    at += seconds(c.card) + seconds(c.mp4);
  }
  index.push('');
}
writeFileSync(join(out, 'index.md'), index.join('\n'));
rmSync(work, { recursive: true, force: true });
console.log(`stitched ${clips.length} clips into ${groups.filter(([, l]) => l.length).length} videos in ${out}`);
