import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function chromePath() {
  return process.env.CHROME_PATH ?? CHROME_CANDIDATES.find((p) => existsSync(p));
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONTEXT_OPTS = {
  userAgent: UA,
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
  timezoneId: 'Asia/Ho_Chi_Minh',
};

export function launchContext({ headless = true, userDataDir = path.resolve('.ig-profile') } = {}) {
  const executablePath = chromePath();
  if (!executablePath) throw new Error('Không tìm thấy Chrome/Edge. Đặt CHROME_PATH=<đường dẫn binary>.');
  return chromium.launchPersistentContext(userDataDir, { ...CONTEXT_OPTS, headless, executablePath });
}

async function dismissLoginWall(page) {
  const closer = page.locator('[aria-label="Close"], [role="dialog"] button:has-text("Close")').first();
  if (await closer.isVisible({ timeout: 1500 }).catch(() => false)) {
    await closer.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

// "[144 likes, 0 comments - ]uadochoiha on October 28, 2026: "<caption>". "
function parseOgDesc(desc = '') {
  const date = desc.match(new RegExp(`(${MONTHS})\\s+(\\d{1,2}),\\s+(\\d{4})`));
  const quoted = desc.match(/:\s*"([\s\S]*)"[\s.]*$/);
  return {
    caption: (quoted ? quoted[1] : desc).trim(),
    postedAt: date ? `${date[1]} ${date[2]}, ${date[3]}` : null,
    likes: desc.match(/([\d.,]+[km]?)\s*likes?/i)?.[1] ?? null,
    comments: desc.match(/([\d.,]+)\s*comments?/i)?.[1] ?? null,
    authorHint: desc.match(/-\s*([A-Za-z0-9._]+)\s+on\s/)?.[1] ?? null,
  };
}

// "235k" | "1.200" | "350,000" | "1,5tr" -> 235000 | 1200 | 350000 | 1500000
function parseAmount(str) {
  const t = str.replace(/\s/g, '');
  const one = t.match(/^(\d+)([.,])(\d+)$/);
  if (one) return one[3].length === 3 ? Number(one[1] + one[3]) : Number(`${one[1]}.${one[3]}`);
  return Number(t.replace(/[.,]/g, ''));
}

function toVnd(raw) {
  const m = raw.match(/^(\d[\d.,]*)\s*(k|nghìn|tr|triệu|đ|vnd)?$/i);
  if (!m) return null;
  const amount = parseAmount(m[1]);
  if (!Number.isFinite(amount) || amount === 0) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'nghìn') return Math.round(amount * 1000);
  if (unit === 'tr' || unit === 'triệu') return Math.round(amount * 1_000_000);
  return Math.round(amount);
}

const PRICE_LABEL = /\b(?:price|pr|giá)\s*[:\-–=]?\s*(\d[\d.,]*\s*(?:k|nghìn|tr|triệu|đ|vnd)?)/i;
// đơn vị "m" bị cố ý loại vì dễ nhầm với "60*40cm"
const PRICE_TOKEN_G = /(?:\d[\d.,]*\s*(?:k|nghìn|tr|triệu|vnd|đ)\b|\d{1,3}(?:[.,]\d{3})+)\b/gi;

function extractPrices(caption) {
  const list = [...caption.matchAll(PRICE_TOKEN_G)]
    .map((m) => ({ raw: m[0].replace(/\s+/g, ' ').trim(), vnd: toVnd(m[0].trim()) }))
    .filter((p) => p.vnd);
  const labeled = caption.match(PRICE_LABEL)?.[1]?.replace(/\s+/g, ' ').trim();
  const primary = list.find((p) => labeled?.startsWith(p.raw)) ?? list[0] ?? null;
  return { list, priceRaw: primary?.raw ?? null, priceVnd: primary?.vnd ?? null };
}

export async function scrapePost(context, url, { compress = false } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page
      .waitForSelector('meta[property="og:description"], meta[property="og:title"], article', {
        timeout: 20_000,
      })
      .catch(() => {});
    await dismissLoginWall(page);
    await page.waitForTimeout(700);

    const data = await page.evaluate(async (doCompress) => {
      const meta = (sel) => document.querySelector(sel)?.getAttribute('content') ?? null;
      const root = document.querySelector('main') || document.body;
      // media của bài đang xem = ul đầu tiên chứa ._aagu; các grid khác ("More posts") đứng sau
      const first = root.querySelector('._aagu');
      const scope = first?.closest('ul') || first;
      const nodes = scope ? scope.querySelectorAll('img') : root.querySelectorAll('img');
      const seen = new Set();
      const imgs = [];
      for (const el of nodes) {
        const src = el.currentSrc || el.src || '';
        if (!/scontent|fbcdn/.test(src)) continue;
        const key = src.split('?')[0];
        if (seen.has(key)) continue;
        seen.add(key);
        imgs.push({ src, alt: el.alt || '' });
      }
      // Nén y hệt admin UI: tối đa 700px, JPEG 78% -> data URL
      let imageDataUrl = '';
      if (doCompress && imgs[0]) {
        try {
          const blob = await (await fetch(imgs[0].src)).blob();
          const bmp = await createImageBitmap(blob);
          const k = Math.min(1, 700 / Math.max(bmp.width, bmp.height));
          const c = document.createElement('canvas');
          c.width = Math.round(bmp.width * k);
          c.height = Math.round(bmp.height * k);
          c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          imageDataUrl = c.toDataURL('image/jpeg', 0.78);
        } catch {}
      }
      return {
        ogDesc: meta('meta[property="og:description"]'),
        ogImage: meta('meta[property="og:image"]'),
        ogUrl: meta('meta[property="og:url"]'),
        imgs: imgs.slice(0, 20),
        imageDataUrl,
      };
    }, compress);

    if (process.env.IG_DEBUG) console.error(JSON.stringify(data.ogDesc));

    const og = parseOgDesc(data.ogDesc || '');
    const { list: prices, priceRaw, priceVnd } = extractPrices(og.caption);
    const author =
      data.ogUrl?.match(/instagram\.com\/([^/]+)\/(?:p|reel|tv)\//)?.[1] ?? og.authorHint;

    return {
      url: data.ogUrl || url,
      shortcode: url.match(/\/(?:p|reel|tv)\/([^/?#]+)/)?.[1] ?? null,
      author,
      priceRaw,
      priceVnd,
      allPrices: prices.map((p) => p.raw),
      description: og.caption,
      firstImage: data.imgs[0]?.src ?? data.ogImage,
      allImages: data.imgs.map((i) => i.src),
      imageDataUrl: data.imageDataUrl || undefined,
      postedAt: og.postedAt,
      likes: og.likes,
      comments: og.comments,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// Lấy shortcode các bài trong grid trang profile.
// Chưa đăng nhập thì Instagram chỉ tải tối đa ~12 bài; có phiên (xem sync.js --login) sẽ cuộn được sâu hơn.
export async function discoverPosts(context, profileUrl, { limit = 50, maxScrolls = 30, waitMs = 1200 } = {}) {
  const page = await context.newPage();
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page
      .waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { timeout: 20_000 })
      .catch(() => {});
    await dismissLoginWall(page);

    const codes = new Set();
    const grab = () =>
      page.$$eval('a[href*="/p/"], a[href*="/reel/"]', (as) =>
        as.map((a) => a.href.match(/\/(?:p|reel)\/([^/?#]+)/)?.[1]).filter(Boolean),
      );
    let stable = 0;
    for (let i = 0; i <= maxScrolls && codes.size < limit; i++) {
      for (const c of await grab()) codes.add(c);
      if (codes.size >= limit) break;
      const before = codes.size;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(waitMs);
      stable = codes.size === before ? stable + 1 : 0;
      if (stable >= 4) break; // grid hết tải (gặp tường đăng nhập)
    }
    return [...codes].slice(0, limit);
  } finally {
    await page.close().catch(() => {});
  }
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const cols = ['url', 'shortcode', 'author', 'priceRaw', 'priceVnd', 'allPrices', 'postedAt', 'likes', 'comments', 'description', 'firstImage'];
  return [
    cols.join(','),
    ...rows.map((r) =>
      cols
        .map((c) => (c === 'allPrices' ? csvCell(r[c]?.join(' | ')) : csvCell(r[c])))
        .join(','),
    ),
  ].join('\r\n');
}

async function readUrls(args) {
  const inFileIdx = args.indexOf('--in');
  if (inFileIdx !== -1) {
    const raw = await readFile(args[inFileIdx + 1], 'utf8');
    return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  return args.filter((a) => /^https?:\/\//.test(a));
}

const outDir = path.resolve('data');

export async function scrapePosts(context, urls, { compress = false, minDelay = 1500, jitter = 1500 } = {}) {
  const results = [];
  for (const [i, url] of urls.entries()) {
    process.stdout.write(`[${i + 1}/${urls.length}] ${url} ... `);
    try {
      const r = await scrapePost(context, url, { compress });
      results.push({ ...r, ok: true });
      console.log(r.priceRaw ? `giá ${r.priceRaw}` : 'không thấy giá');
    } catch (err) {
      results.push({ url, ok: false, error: String(err.message ?? err) });
      console.log(`LỖI: ${err.message}`);
    }
    if (i < urls.length - 1) await new Promise((r) => setTimeout(r, minDelay + Math.random() * jitter));
  }
  return results;
}

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const args = process.argv.slice(2);
  const urls = await readUrls(args);
  if (!urls.length) {
    console.error('Dùng: node scrape.js <url1> <url2> ... | node scrape.js --in links.txt');
    process.exit(1);
  }

  const context = await launchContext({ headless: !args.includes('--headed') });
  const results = await scrapePosts(context, urls, { compress: args.includes('--compress') });

  if (args.includes('--save-images')) {
    const imgDir = path.join(outDir, 'imgs');
    await mkdir(imgDir, { recursive: true });
    for (const r of results) {
      if (!r.firstImage) continue;
      const ext = (r.firstImage.match(/\.(jpg|jpeg|png|webp)/i)?.[1] ?? 'jpg').toLowerCase();
      const res = await context.request.get(r.firstImage, { timeout: 30_000 }).catch(() => null);
      if (!res?.ok()) {
        console.error(`  ảnh ${r.shortcode}: HTTP ${res?.status() ?? 'ERR'}`);
        continue;
      }
      const file = path.join(imgDir, `${r.shortcode}_1.${ext}`);
      await writeFile(file, await res.body());
      r.firstImageFile = file;
    }
  }

  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  await writeFile(path.join(outDir, `ig-${stamp}.json`), JSON.stringify(results, null, 2), 'utf8');
  await writeFile(path.join(outDir, `ig-${stamp}.csv`), toCsv(results), 'utf8');
  await context.close();

  const ok = results.filter((r) => r.ok && r.priceRaw).length;
  console.log(`\nXong: ${results.length} bài, ${ok} bài tách được giá -> ${outDir}`);
}
