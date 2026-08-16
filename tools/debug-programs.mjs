import { launch, startServer } from './lib.mjs';
const server = await startServer(5273);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 480, height: 270 } });
const page = await ctx.newPage();
await page.goto(`${server.url}/harness.html?shot=ocean-noon&seed=20260814&w=480&h=270`, { waitUntil: 'load' });
await page.waitForFunction('window.__SHOT_READY === true', { timeout: 90000 });
const r = await page.evaluate(() => ({ before: window.__PROGRAMS_BEFORE, after: window.__PROGRAMS_AFTER }));
const setB = new Set(r.before);
console.log('before:', r.before.length, ' after:', r.after.length);
console.log('--- NEW PROGRAMS ---');
for (const k of r.after) if (!setB.has(k)) console.log('  NEW:', k.slice(0, 400));
console.log('--- keys that differ only late ---');
const short = (k) => k.slice(0, 60);
const groups = {};
for (const k of r.after) { (groups[short(k)] = groups[short(k)] || []).push(k); }
for (const g of Object.values(groups)) {
  if (g.length > 1 && new Set(g).size > 1) {
    const uniq = [...new Set(g)];
    for (let i = 0; i < uniq.length; i++) console.log('  variant' + i + ':', uniq[i].slice(0, 300));
  }
}

await b.close(); await server.stop();
