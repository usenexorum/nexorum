// Browser test of /try: the recorded story end to end on BASE, and Live mode on LIVE_BASE (a server started with
// ANTHROPIC_BASE_URL pointing at server/mock-upstream.mjs). Screenshots go to tmp/try-*.png.
//   node tools/try-e2e.cjs [BASE] [LIVE_BASE]
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright"); // set PLAYWRIGHT_PATH if playwright is installed elsewhere
const BASE = process.argv[2] || "http://127.0.0.1:5210";
const LIVE = process.argv[3] || "http://127.0.0.1:5211";
const SHOTS = path.join(__dirname, "..", "tmp");
let fails = 0;
const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  // ---------- recorded ----------
  await page.goto(BASE + "/try/", { waitUntil: "networkidle" });
  ok(await page.locator(".actor").count() === 1, "agent on stage");
  const sugs = page.locator(".sug");
  const n3 = await sugs.count();
  ok(n3 === 5, `session 3 has 5 suggestions (${n3})`);
  for (let i = 0; i < n3; i++) { await page.locator(`.sug[data-i="${i}"]`).click(); await page.waitForFunction(() => !document.querySelector(".sug:not([disabled])") || document.querySelectorAll(".msg.a").length > 0, null, { timeout: 5000 }); await page.waitForTimeout(800); }
  ok(await page.locator(".tc").count() >= 3, "tool calls are shown as cards");
  await page.locator(".tc").first().click();
  ok(await page.locator(".tc[open] .res").first().isVisible(), "a tool card opens to its result");
  await page.click("#bEnd");
  const tx = await page.locator("#mem").innerText();
  ok(/REDACTED:anthropic_key/.test(tx) && !/Hk29dLpQ7v/.test(tx), "the transcript stores the key redacted (real scrubber)");
  await page.click("#bDream");
  await page.waitForTimeout(1500);
  ok(await page.locator(".actor").count() >= 3, `several agents on stage during the dream (${await page.locator(".actor").count()})`);
  await page.screenshot({ path: SHOTS + "/try-dream.png" });
  await page.waitForSelector("#bOk", { timeout: 40000 });
  const prop = await page.locator("#mem").innerText();
  ok(/Organizer/.test(prop) && /Analyzers/.test(prop), "proposal shows organizer and analyzer reports");
  ok(/4 new/.test(prop) && !/ deleted/.test(prop.split("Organizer")[0]), "proposal stats count the pages (4 new; the merged duplicate never reaches live)");
  ok(/deleted the duplicate page/.test(prop), "organizer change list mentions the merged duplicate");
  await page.screenshot({ path: SHOTS + "/try-proposal.png" });
  await page.click("#bOk");
  const ctx = await page.locator("#mem").innerText();
  ok(/How the digest changed/.test(ctx), "context tab shows how the digest changed");
  await page.click("#bNew");
  await page.locator('.sug[data-i="0"]').click(); await page.waitForTimeout(900);
  const last = await page.locator(".msg.a").last().innerText();
  ok(/pnpm test:unit/.test(last) && /testing\.md/.test(last), "session 4 answers from the wiki: " + last.slice(0, 80));
  ok(await page.locator(".tree button").count() === 4, "wiki tab shows a file tree of 4 pages");
  ok(await page.locator(".viewer mark").count() > 0, "the recalled lines are highlighted");
  const wl = page.locator(".viewer .wl").first();
  if (await wl.count()) { const target = await wl.getAttribute("data-open"); await wl.click(); ok((await page.locator(".viewer-h b").innerText()) === target, "a [[wikilink]] opens that page: " + target); }
  else ok(false, "viewer has wikilinks");
  await page.screenshot({ path: SHOTS + "/try-session4.png" });
  ok(errors.length === 0, "no console errors (recorded): " + errors.join(" | "));

  // ---------- live (mock model) ----------
  errors.length = 0;
  await page.goto(LIVE + "/try/", { waitUntil: "networkidle" });
  await page.waitForFunction(() => !document.getElementById("mLive").disabled, null, { timeout: 5000 });
  await page.click("#mLive");
  ok(await page.locator("#starters button").count() === 4, "live shows starter prompts");
  await page.locator("#starters button").first().click();
  await page.waitForFunction(() => document.querySelectorAll(".msg.a").length >= 1, null, { timeout: 15000 });
  await page.fill("#liveIn", "Please remember that I prefer short answers."); await page.press("#liveIn", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".msg.a").length >= 2, null, { timeout: 15000 });
  ok(await page.locator(".tc").count() >= 2, "live chat ran tools in the page");
  const tok = await page.locator("#tok").innerText();
  ok(Number(tok.replace(/,/g, "")) > 0, "token meter counts live usage: " + tok);
  await page.click("#bEnd");
  await page.click("#bDream");
  await page.waitForSelector("#bOk", { timeout: 60000 });
  const lp = await page.locator("#mem").innerText();
  ok(/completed/.test(lp) && /_index\.md/.test(lp), "live dream (real engine through the proxy) produced a proposal with the index");
  await page.screenshot({ path: SHOTS + "/try-live.png" });
  await page.click("#bOk");
  ok(Object.keys(await page.evaluate(() => document.querySelectorAll(".tree button").length)).length >= 0 && (await page.locator("#cW").innerText()) !== "0", "live wiki has pages after approve");
  await page.click("#bNew");
  ok(/wiki index/.test(await page.locator(".msg.t").first().innerText()), "the next live session loads the wiki index");
  ok(errors.length === 0, "no console errors (live): " + errors.join(" | "));

  // ---------- mobile ----------
  const m = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await m.goto(BASE + "/try/", { waitUntil: "networkidle" });
  const ow = await m.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  ok(ow <= 0, "no horizontal overflow at 375px (" + ow + ")");
  await m.screenshot({ path: SHOTS + "/try-mobile.png", fullPage: false });
  await browser.close();
  console.log(fails ? `\n${fails} failed` : "\nall passed");
  process.exitCode = fails ? 1 : 0;
})();
