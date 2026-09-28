// Captures product screenshots for the marketing pages from a running local server (npm run dev with
// DEV_LOGIN=true), in light and dark, as WebP files: public/shots/<name>-<theme>.webp.
//
//   node scripts/screenshots.mjs              every shot
//   node scripts/screenshots.mjs inbox issue  just these
//   node scripts/screenshots.mjs --resize     only remake the half-size (-1x) files from the 2x ones
//
// Each shot is captured at 2x; a half-size copy (-1x.webp) is made for phones, and the pages pick one with srcset.
//
// Uses an installed Chromium browser through puppeteer-core (set CHROME_PATH to use another one).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const BROWSER = process.env.CHROME_PATH ?? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const OUT = new URL("../public/shots/", import.meta.url);

// Founder-only links, toasts and flash messages don't belong in marketing shots.
const CLEAN_CSS = `.nav a[href="/admin"], .flash, .toast, .skip-link { display: none !important; }`;

/** Opens the first issue whose title contains `text`. */
const openIssue = (text) => async (page) => {
  await page.goto(`${BASE}/issues`, { waitUntil: "networkidle0" });
  const href = await page.$$eval(".issue-card h3 a", (links, wanted) => links.find((a) => a.textContent.includes(wanted))?.getAttribute("href"), text);
  if (!href) throw new Error(`No open issue containing "${text}"`);
  await page.goto(`${BASE}${href}`, { waitUntil: "networkidle0" });
};

const SHOTS = {
  // One inbox for both stores.
  inbox: { go: "/inbox?view=needs_reply", viewport: { width: 1100, height: 760 } },
  // An open issue, with a similar review ready to add.
  issue: { go: openIssue("Bank sync"), viewport: { width: 1100, height: 760 }, scrollTo: "h2" },
  // A release shipped: follow-ups drafted for everyone the fix affects.
  followups: { go: "/inbox?view=followups", viewport: { width: 1100, height: 760 } },
  // Ratings raised after the follow-ups.
  wins: { go: "/inbox?view=done", viewport: { width: 1100, height: 760 } },
  // A shipped issue with the stars it won back.
  shipped: { go: "/issues?tab=shipped", viewport: { width: 860, height: 760 }, element: ".issue-card" },
  // Open issues, ranked by the stars they cost.
  issues: { go: "/issues", viewport: { width: 860, height: 900 }, element: ".issue-list" },
  // One review card that went from 1 to 5 stars.
  review: { go: "/inbox?view=done", viewport: { width: 760, height: 900 }, element: "article.review:has(.win)" },
  // The public fix log.
  fixlog: { go: async (page) => {
    await page.goto(`${BASE}/apps`, { waitUntil: "networkidle0" });
    const href = await page.$eval(".embed summary a", (a) => a.getAttribute("href"));
    await page.goto(href.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: "networkidle0" });
  }, viewport: { width: 1100, height: 760 }, clip: { x: 0, y: 0, width: 1100, height: 640 } },
};

const args = process.argv.slice(2);
const resizeOnly = args.includes("--resize");
const wanted = args.filter((arg) => !arg.startsWith("--"));
const names = resizeOnly ? [] : wanted.length ? wanted : Object.keys(SHOTS);
for (const name of names) if (!SHOTS[name]) throw new Error(`Unknown shot "${name}". Known: ${Object.keys(SHOTS).join(", ")}`);

mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
try {
  const page = await browser.newPage();
  // The app's CSP forbids inline styles, including the clean-up style this script injects.
  await page.setBypassCSP(true);
  // Signs in as the local dev account.
  await page.goto(`${BASE}/auth/github?next=/inbox`, { waitUntil: "networkidle0" });
  if (!page.url().includes("/inbox")) throw new Error("Dev sign-in failed: run the dev server with DEV_LOGIN=true.");

  for (const theme of ["light", "dark"]) {
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    for (const name of names) {
      const shot = SHOTS[name];
      await page.setViewport({ ...shot.viewport, deviceScaleFactor: 2 });
      if (typeof shot.go === "string") await page.goto(`${BASE}${shot.go}`, { waitUntil: "networkidle0" });
      else await shot.go(page);
      await page.addStyleTag({ content: CLEAN_CSS });
      await page.evaluate(() => document.fonts.ready);
      if (shot.scrollTo) await page.$eval(shot.scrollTo, (el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90));
      const file = new URL(`${name}-${theme}.webp`, OUT).pathname;
      if (shot.element) {
        const element = await page.$(shot.element);
        if (!element) throw new Error(`${name}: no element matches ${shot.element}`);
        await element.screenshot({ path: file, type: "webp", quality: 82 });
      } else {
        await page.screenshot({ path: file, type: "webp", quality: 82, ...(shot.clip ? { clip: shot.clip } : {}) });
      }
      console.log(`saved ${name}-${theme}.webp`);
    }
  }
  // Half-size copies, scaled down by the browser's high-quality resampler.
  const resized = resizeOnly
    ? readdirSync(OUT).filter((file) => /-(light|dark)\.webp$/.test(file))
    : names.flatMap((name) => [`${name}-light.webp`, `${name}-dark.webp`]);
  const blank = await browser.newPage();
  for (const file of resized) {
    const source = readFileSync(new URL(file, OUT)).toString("base64");
    const half = await blank.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/webp;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.naturalWidth / 2);
      canvas.height = Math.round(image.naturalHeight / 2);
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", 0.85).split(",")[1];
    }, source);
    writeFileSync(new URL(file.replace(".webp", "-1x.webp"), OUT), Buffer.from(half, "base64"));
    console.log(`resized ${file.replace(".webp", "-1x.webp")}`);
  }
} finally {
  await browser.close();
}
