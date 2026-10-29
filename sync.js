// Entry point duy nhất: tự tìm bài mới trên trang Instagram của shop -> scrape -> đẩy lên site.
//   node sync.js                  = chạy một lần, lấy tối đa 50 bài gần nhất, đẩy thật
//   node sync.js --dry            = chỉ xem sẽ đẩy gì, không ghi
//   node sync.js --login          = mở trình duyệt đăng nhập 1 lần (bắt buộc nếu muốn vượt trần 12 bài)
//   node sync.js --limit 100      = lấy bao nhiêu bài gần nhất
//   node sync.js --loop 60        = cứ 60 phút tự chạy lại một lần
//   node sync.js links.txt        = ép chạy đúng danh sách link trong file, bỏ qua bước tự tìm
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchContext, discoverPosts, scrapePosts } from './scrape.js';
import {
  listProducts,
  checkPassword,
  readPassword,
  planNew,
  pushProducts,
  shortcode,
  titleFrom,
} from './lib/store.js';

const PROFILE = process.env.IG_PROFILE || 'https://www.instagram.com/uadochoiha/';
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const loopIdx = args.indexOf('--loop');
const loopMin = loopIdx !== -1 ? Number(args[loopIdx + 1]) || 60 : 0;
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) || 50 : 50;
// tham số vị trí = file danh sách link (bỏ qua flag và tham số của --loop)
const linksFile =
  args.find((a, i) => !a.startsWith('--') && !/^\d+$/.test(a) && args[i - 1] !== '--loop') ?? null;

async function saveLog(rows) {
  const dir = path.resolve('data');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = path.join(dir, `sync-${stamp}.json`);
  await writeFile(file, JSON.stringify(rows.map(({ imageDataUrl, ...r }) => r), null, 2), 'utf8');
  return file;
}

async function runOnce() {
  console.log(`\n===== ${new Date().toLocaleString('en-GB')} =====`);
  const store = await listProducts();
  if (!Array.isArray(store.products)) throw new Error('API list lỗi: ' + JSON.stringify(store).slice(0, 200));
  const existing = store.products;
  const have = new Set(existing.map((p) => shortcode(p.link)).filter(Boolean));
  console.log(`Store đang có ${existing.length} sản phẩm.`);

  const context = await launchContext();
  try {
    const codes = linksFile
      ? (await readFile(linksFile, 'utf8'))
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map(shortcode)
          .filter(Boolean)
      : await discoverPosts(context, PROFILE, { limit });
    const source = linksFile ? `file ${linksFile}` : `grid ${new URL(PROFILE).pathname}`;
    const fresh = codes.filter((c) => !have.has(c));
    console.log(`${source}: ${codes.length} bài, ${fresh.length} bài lạ.`);
    if (!fresh.length) return 0;

    const rows = await scrapePosts(context, fresh.map((c) => `https://www.instagram.com/p/${c}/`), {
      compress: true,
    });
    console.log(`Log: ${await saveLog(rows)}`);

    const { plan, skipped } = planNew(rows.filter((r) => r.ok), existing);
    for (const r of skipped.noPrice)
      console.log(`  bỏ qua, không có giá: ${r.shortcode} — ${titleFrom(r.description).slice(0, 40)}`);
    if (!plan.length) return 0;

    console.log(`\n${plan.length} sản phẩm mới:`);
    for (const { product } of plan)
      console.log(`  ${String(product.price).padStart(7)}đ  ${product.name.slice(0, 46)}`);

    if (dry) {
      console.log('\n--dry: không ghi gì lên store.');
      return plan.length;
    }

    const password = await readPassword();
    if (!(await checkPassword(password)).ok) throw new Error('Sai mật khẩu admin');
    console.log('');
    return (await pushProducts(plan, password)).length;
  } finally {
    await context.close();
  }
}

async function main() {
  try {
    const n = await runOnce();
    console.log(n ? `${dry ? 'Sẽ đẩy' : 'Đã đẩy'} ${n} sản phẩm lên site.` : 'Không có bài mới nào.');
  } catch (err) {
    console.error('LỖI:', err.message);
    if (process.env.CI) console.error(err.stack);
    process.exitCode = 1;
  }
}

if (args.includes('--login')) {
  console.log('Mở trình duyệt để đăng nhập Instagram — chỉ cần làm một lần.');
  console.log('Đăng nhập xong thì đóng cửa sổ trình duyệt, phiên được lưu vào .ig-profile/');
  const ctx = await launchContext({ headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://www.instagram.com/accounts/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await new Promise((res) => ctx.on('close', res));
  console.log('Đã lưu phiên. Bây giờ chạy: node sync.js --limit 50');
  process.exit(0);
}

await main();

if (loopMin) {
  console.log(`\nChạy lặp mỗi ${loopMin} phút (Ctrl+C để dừng).`);
  for (;;) {
    await new Promise((r) => setTimeout(r, loopMin * 60_000));
    await main();
  }
}
