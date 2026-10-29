// Layer dùng chung: gọi backend Google Apps Script của site + map bài Instagram -> sản phẩm
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export const API_URL =
  process.env.UAD_API ||
  'https://script.google.com/macros/s/AKfycbwnhQrtUVToMRAGir4G67O2-BZVG6gHV_hINgIrbWubOgSxJS2WB15_x07XI1DFQpEn/exec';

export const shortcode = (u = '') => u.match(/\/(?:p|reel|tv)\/([^/?#]+)/)?.[1] ?? null;

export async function readPassword() {
  if (process.env.UAD_PASSWORD) return process.env.UAD_PASSWORD;
  if (existsSync('.uad-password')) return (await readFile('.uad-password', 'utf8')).trim();
  throw new Error('Thiếu mật khẩu admin: đặt UAD_PASSWORD hoặc ghi vào file .uad-password');
}

async function api(action, data = {}, post = false) {
  const res = post
    ? await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...data }),
      })
    : await fetch(`${API_URL}?action=${action}`, { redirect: 'follow' });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API trả về không phải JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
  }
}

export const listProducts = () => api('list');
export const checkPassword = (password) => api('auth', { password }, true);

// ===== map bài viết -> schema sản phẩm của site =====
const MONTHS = /^(January|February|March|April|May|June|July|August|September|October|November|December)$/;

export function titleFrom(caption = '') {
  const line = caption.split(/\n+/).map((s) => s.trim()).find(Boolean) ?? '';
  if (line.length <= 62) return line;
  const cut = line.slice(0, 62);
  return cut.slice(0, cut.lastIndexOf(' ')).trim() + '…';
}

export function descFrom(caption = '') {
  return caption
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((l, i) => i > 0 && !/^\s*(price|pr|giá)\b/i.test(l))
    .join('\n');
}

export function baseId(postedAt) {
  if (!postedAt) return Date.now();
  const [mon, rest] = [postedAt.split(' ')[0], postedAt.slice(postedAt.indexOf(' ') + 1)];
  const [day, year] = rest.replace(',', '').split(' ');
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(mon);
  if (!MONTHS.test(mon) || month < 0) return Date.now();
  return Date.UTC(Number(year), month, Number(day), 12);
}

export function toProduct(r, id) {
  return {
    id,
    name: titleFrom(r.description) || r.shortcode,
    price: r.priceVnd ?? 0,
    color: '',
    desc: descFrom(r.description),
    img: '',
    emoji: '🧸',
    link: r.url,
  };
}

// Bài đã scrape -> danh sách sản phẩm mới, bỏ qua bài đã có trên store và bài không có giá
export function planNew(rows, existing) {
  const takenLinks = new Set(existing.map((p) => shortcode(p.link)).filter(Boolean));
  const takenIds = new Set(existing.map((p) => Number(p.id)));
  const plan = [];
  const skipped = { noPrice: [], duplicate: [] };

  for (const r of rows.slice().sort((a, b) => baseId(b.postedAt) - baseId(a.postedAt))) {
    if (!r.priceVnd) {
      skipped.noPrice.push(r);
      continue;
    }
    if (takenLinks.has(r.shortcode)) {
      skipped.duplicate.push(r);
      continue;
    }
    let id = baseId(r.postedAt);
    while (takenIds.has(id)) id += 1000;
    takenIds.add(id);
    takenLinks.add(r.shortcode);
    plan.push({ row: r, product: toProduct(r, id) });
  }
  return { plan, skipped };
}

export async function pushProducts(plan, password, { delayMs = 1200 } = {}) {
  const done = [];
  for (const [i, { product, row }] of plan.entries()) {
    process.stdout.write(`[${i + 1}/${plan.length}] ${product.name.slice(0, 36)} ... `);
    const r = await api('save', { password, product: { ...product }, image: row.imageDataUrl || '' }, true);
    if (!r.ok) {
      console.log('LỖI: ' + (r.error ?? JSON.stringify(r).slice(0, 120)));
      continue;
    }
    const stale = product.link && !('link' in (r.product || {}));
    console.log(r.product?.img ? 'xong (có ảnh Drive)' : 'xong (không ảnh)' + (stale ? ' — API bản cũ, mất link!' : ''));
    done.push({ ...product, ...r.product });
    if (i < plan.length - 1) await new Promise((res) => setTimeout(res, delayMs));
  }
  return done;
}
