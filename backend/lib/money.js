'use strict';
/**
 * Vietnamese money amounts in chat messages / transcribed speech (same rules as FinTrack apps/api/src/vn-money.ts):
 *   "50k", "50 ka", "200 ca", "50 cành", "50 nghìn" (= 50,000), "1tr2", "1 triệu 200 nghìn", "2 triệu rưỡi",
 *   "2 triệu tư" (= 2.4 million), "1,5 triệu", "1.500.000đ", "2 củ" / "2 chai" / "2 quả" (= 2 million),
 *   "3 lít" / "3 lốp" / "3 loét" / "3 sọi" / "3 xị" (= 300,000), "1 tỏi" (= 1 billion), "2 trăm" (= 200,000),
 *   "5 chục" (= 50,000), "trăm mốt" (= 110,000), "chục rưỡi" (= 15,000), "nửa củ" (= 500,000),
 *   "năm mươi nghìn", "hai trăm rưỡi", "một triệu hai"…
 * Slang units that are also nouns ("3 lít xăng" = 3 litres of petrol, "2 chai nước" = 2 bottles of water, "2 củ khoai"
 * = 2 potatoes, "5 cành hoa" = 5 flowers) are money only when no noun follows: end of text, punctuation, a number,
 * "rưỡi", "rồi", "nhé"…
 *
 * Used to: (1) quickly drop messages without money (no AI call spent), (2) normalise amounts the AI returns as
 * strings, (3) check the AI's amount against the numbers in the message (guards against made-up numbers), (4) format.
 */

const THOUSAND = 1e3;
const MILLION = 1e6;
const BILLION = 1e9;

/**
 * Units that follow a number. Unaccented forms that clash with common words are left out: "ti" (ti vi = TV), "cu",
 * "xi" (xi măng = cement), "canh" (canh chua = sour soup), "lop" (lớp học = class).
 */
const UNIT_WORDS = new Map([
  ['k', THOUSAND], ['ka', THOUSAND], ['ca', THOUSAND], ['cành', THOUSAND],
  ['nghìn', THOUSAND], ['ngàn', THOUSAND], ['nghin', THOUSAND], ['ngan', THOUSAND],
  ['lít', 1e5], ['lit', 1e5], ['lốp', 1e5], ['loét', 1e5], ['sọi', 1e5], ['xị', 1e5],
  ['tr', MILLION], ['triệu', MILLION], ['trieu', MILLION], ['củ', MILLION], ['chai', MILLION], ['quả', MILLION],
  ['tỷ', BILLION], ['tỉ', BILLION], ['ty', BILLION], ['tỏi', BILLION],
]);
/**
 * Also nouns / classifiers: money only when no noun follows ("hết 3 lít" = spent 300k is money, "3 lít xăng" = 3 litres
 * of petrol is not).
 */
const NOUN_UNITS = new Set(['ca', 'cành', 'lít', 'lit', 'lốp', 'loét', 'sọi', 'xị', 'củ', 'chai', 'quả', 'tỏi']);

/** "2 trăm" (= 200 thousand), "5 chục" (= 50 thousand); followed by a unit they are multipliers: "2 trăm nghìn". */
const MULT_WORDS = new Map([['trăm', 100], ['tram', 100], ['chục', 10], ['chuc', 10]]);

const CURRENCY_WORDS = new Set(['đ', 'd', 'vnd', 'vnđ', 'đồng', 'dong']);
const HALF_WORDS = new Set(['rưỡi', 'rưởi', 'ruoi']);

/** Digits spelled out as words. */
const DIGIT_WORDS = new Map([
  ['không', 0], ['khong', 0],
  ['một', 1], ['mot', 1], ['mốt', 1],
  ['hai', 2],
  ['ba', 3],
  ['bốn', 4], ['bon', 4], ['tư', 4],
  ['năm', 5], ['nam', 5], ['lăm', 5], ['lam', 5], ['nhăm', 5],
  ['sáu', 6], ['sau', 6],
  ['bảy', 7], ['bẩy', 7], ['bay', 7],
  ['tám', 8], ['tam', 8],
  ['chín', 9], ['chin', 9],
]);
/**
 * One shorthand digit after a unit: "triệu tư" = 1.4 million, "củ hai" = 1.2 million. Excludes "một" (one) and "năm"
 * (five, also "year": "2 triệu năm nay" = 2 million this year).
 */
const TAIL_WORDS = new Map([
  ['mốt', 1], ['hai', 2], ['ba', 3], ['tư', 4], ['bốn', 4], ['sáu', 6], ['bảy', 7], ['bẩy', 7], ['tám', 8], ['chín', 9],
]);
/** Words that often follow an amount (particles, prepositions, short verbs, time), unlike nouns ("xăng", "nước"). */
const AFTER_MONEY = new Set([
  'rồi', 'nhé', 'nhe', 'nha', 'nhá', 'thôi', 'ạ', 'à', 'á', 'ah', 'đó', 'đấy', 'nè', 'này', 'luôn', 'nữa', 'mà', 'hả',
  'nhỉ', 'chứ', 'vậy', 'thế', 'cơ', 'kìa', 'đâu', 'hen', 'ha', 'tiền', 'hết', 'mất', 'trả', 'chuyển', 'gửi', 'đưa', 'nạp',
  'rút', 'được', 'đc', 'xong', 'cho', 'với', 'và', 'là', 'của', 'để', 'vào', 'từ', 'bằng', 'qua', 'tại', 'ở', 'mỗi', 'còn',
  'cả', 'nhưng', 'thì', 'hay', 'hoặc', 'chẵn', 'tròn', 'hôm', 'sáng', 'trưa', 'chiều', 'tối', 'đêm', 'nay', 'mai', 'tuần',
  'tháng', 'lúc', 'khi', 'nên', 'vì', 'do', 'ok', 'oke',
]);

/** Words hinting that money is mentioned (quick filter). */
const MONEY_WORD_RE = /(^|[^\p{L}])(nghìn|ngàn|nghin|ngan|triệu|trieu|tỷ|tỉ|củ|lít|xị|trăm|chục|mươi|mười|rưỡi|đồng|vnd|vnđ)(?=$|[^\p{L}])/u;

const TOKEN_RE = /\d+(?:[.,]\d+)*|[\p{L}\p{M}]+|[$₫]/gu;

function normalizeText(text) {
  return String(text ?? '').normalize('NFC').toLowerCase();
}

function tokenize(text) {
  const s = normalizeText(text);
  const tokens = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    const t = m[0];
    const type = /^\d/.test(t) ? 'num' : t === '$' || t === '₫' ? 'sym' : 'word';
    tokens.push({ type, text: t, start: m.index, end: m.index + t.length });
  }
  return { source: s, tokens };
}

/** "1.500.000" → 1500000, "1,5" → 1.5, "1.5" → 1.5, "50.000" → 50000, "12.345,67" → 12345.67. */
function parseNumberToken(t) {
  if (/^\d+$/.test(t)) return { value: Number(t), decimal: false };
  if (/^\d{1,3}(\.\d{3})+$/.test(t) || /^\d{1,3}(,\d{3})+$/.test(t)) return { value: Number(t.replace(/[.,]/g, '')), decimal: false };
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(t)) return { value: Number(t.replace(/\./g, '').replace(',', '.')), decimal: true };
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(t)) return { value: Number(t.replace(/,/g, '')), decimal: true };
  if (/^\d+[.,]\d+$/.test(t)) return { value: Number(t.replace(',', '.')), decimal: true };
  return { value: Number(t.split(/[.,]/)[0]), decimal: false };
}

const wordAt = (tokens, j) => (tokens[j] && tokens[j].type === 'word' ? tokens[j].text : '');

/** A money phrase ends at token j: end of text, punctuation, a number, or a non-noun (AFTER_MONEY, number / unit). */
function endsPhrase(tokens, j, source) {
  const t = tokens[j];
  if (!t || t.type !== 'word') return true;
  if (j > 0 && /[,.;:!?…()\n]/.test(source.slice(tokens[j - 1].end, t.start))) return true;
  const w = t.text;
  return AFTER_MONEY.has(w) || CURRENCY_WORDS.has(w) || HALF_WORDS.has(w) || DIGIT_WORDS.has(w) || UNIT_WORDS.has(w)
    || MULT_WORDS.has(w) || w === 'mươi' || w === 'lẻ' || w === 'linh' || w === 'usd' || w === 'đô';
}

/** Money unit at token j (0 if none, including lít / chai… used as the classifier of a noun). */
function scaleAt(tokens, j, source) {
  const w = wordAt(tokens, j);
  if (!w || !UNIT_WORDS.has(w)) return 0;
  if (NOUN_UNITS.has(w) && !endsPhrase(tokens, j + 1, source)) return 0;
  return UNIT_WORDS.get(w);
}

/** Shorthand tail at token j: "rưỡi" (and a half), or a single digit ("tư", "hai"…) that ends the phrase. */
function tailAt(tokens, j, source) {
  const w = wordAt(tokens, j);
  return !!w && (HALF_WORDS.has(w) || (TAIL_WORDS.has(w) && endsPhrase(tokens, j + 1, source)));
}

/**
 * A money phrase starting at token i: numbers / spelled-out digits, mươi / chục (tens) / trăm (hundreds), units
 * (k, nghìn, lít, triệu, củ, tỷ…), tails ("rưỡi", "1tr2", "triệu tư", "trăm mốt"). implied = implicit leading number:
 * 1 ("trăm mốt", "triệu tư"), 0.5 ("nửa củ", rawStart = token index of "nửa"). null if it is not money.
 */
function readAmount(tokens, i, source, implied = null, rawStart = i) {
  let j = i;
  let total = 0;
  let group = 0;
  let digit = implied;
  let fromNumber = false;
  let lastScale = 0;
  let lastMult = 0;
  let afterHundred = false; // "trăm hai" = 120 (tens place), "trăm linh hai" = 102
  let units = false;
  let sawScale = false;
  let sawMult = false;
  let hundredOrTens = false; // saw "trăm" / "chục": money phrasing, thousands implied
  let currency = tokens[i - 1] && tokens[i - 1].text === '$' ? 'USD' : null;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === 'num') {
      if (digit !== null) break;
      if (lastScale && group === 0) {
        // After a unit: "1 triệu 200 nghìn", "1 triệu 2 trăm" (a smaller group) or "1tr2", "1 tỷ 25" (decimal part).
        const next = scaleAt(tokens, j + 1, source);
        if ((next && next < lastScale) || (MULT_WORDS.has(wordAt(tokens, j + 1)) && lastScale >= MILLION)) {
          digit = parseNumberToken(t.text).value;
          fromNumber = true;
          j++;
          continue;
        }
        if ((lastScale === MILLION || lastScale === BILLION) && /^\d{1,3}$/.test(t.text)) {
          total += (Number(t.text) / 10 ** t.text.length) * lastScale;
          j++;
        }
        break;
      }
      if (sawScale || sawMult) break;
      digit = parseNumberToken(t.text).value;
      fromNumber = true;
      j++;
      continue;
    }
    if (t.type !== 'word') {
      if (t.text === '₫' && (fromNumber || sawScale)) {
        currency = currency || 'VND';
        j++;
      }
      break;
    }
    const w = t.text;
    if (DIGIT_WORDS.has(w)) {
      if (digit !== null) break;
      if (lastScale && group === 0) {
        // After a unit: "một triệu hai trăm", "hai triệu năm trăm" (a smaller group) or the tail "triệu tư"; but not
        // "2 triệu năm nay", "2 triệu ba mẹ cho" (2 million this year, 2 million from mum and dad).
        const nw = wordAt(tokens, j + 1);
        const next = scaleAt(tokens, j + 1, source);
        const builds = MULT_WORDS.has(nw) || nw === 'mươi' || nw === 'muoi' || (next && next < lastScale);
        if (!builds && !(TAIL_WORDS.has(w) && endsPhrase(tokens, j + 1, source))) break;
      }
      digit = DIGIT_WORDS.get(w);
      j++;
      continue;
    }
    if (w === 'mươi' || (w === 'muoi' && digit !== null)) {
      group += (digit ?? 1) * 10;
      digit = null;
      lastMult = 10;
      afterHundred = false;
      sawMult = true;
      j++;
      continue;
    }
    if (w === 'mười' || w === 'muoi') {
      if (digit !== null) break;
      group += 10;
      lastMult = 10;
      afterHundred = false;
      sawMult = true;
      j++;
      continue;
    }
    if (MULT_WORDS.has(w)) {
      const m = MULT_WORDS.get(w);
      group += (digit ?? 1) * m;
      digit = null;
      lastMult = m;
      afterHundred = m === 100;
      hundredOrTens = true;
      sawMult = true;
      j++;
      continue;
    }
    if (w === 'linh' || w === 'lẻ' || w === 'le') {
      if (!group || digit !== null) break;
      units = true;
      j++;
      continue;
    }
    const s = scaleAt(tokens, j, source);
    if (s) {
      if (lastScale && s >= lastScale) break;
      const n = group + (digit ?? 0) || 1;
      total += n * s;
      group = 0;
      digit = null;
      lastScale = s;
      lastMult = 0;
      afterHundred = false;
      units = false;
      sawScale = true;
      j++;
      continue;
    }
    if (HALF_WORDS.has(w)) {
      if (group === 0 && digit === null && lastScale) total += lastScale / 2;
      else if (lastMult && digit === null) group += lastMult / 2;
      else break;
      j++;
      break; // "rưỡi" ends the phrase
    }
    if (CURRENCY_WORDS.has(w) && (fromNumber || sawScale)) {
      currency = currency || 'VND';
      j++;
      break;
    }
    if ((w === 'usd' || w === 'đô') && (fromNumber || sawScale || sawMult)) {
      currency = 'USD';
      j++;
      break;
    }
    break;
  }
  if (j === i && implied === null) return null;
  let pending = group + (digit ?? 0);
  if (afterHundred && !units && digit !== null) pending = group + digit * 10; // "trăm hai" = 120, "hai trăm mốt" = 210
  let value;
  let bare = false;
  if (sawScale) {
    value = total;
    if (pending) value += group === 0 && digit !== null ? (digit * lastScale) / 10 : (pending * lastScale) / 1000;
  } else if (sawMult) {
    // "hai trăm" = 200,000, "5 chục" = 50,000 (thousands implied); "ba mươi" is bare: the AI decides from context.
    if (hundredOrTens && currency !== 'USD') value = pending * THOUSAND;
    else {
      value = pending;
      bare = currency === null;
    }
  } else if (fromNumber) {
    value = digit;
    bare = currency === null;
  } else {
    return null; // a single spelled-out digit ("năm nay", "ba ơi") is not money
  }
  if (!(value > 0)) return null;
  return {
    next: j,
    amount: { value: Math.round(value * 100) / 100, bare, currency, raw: source.slice(tokens[rawStart].start, tokens[j - 1].end) },
  };
}

/**
 * Every amount mentioned in the text, in order of appearance.
 * bare = a number without a unit ("ăn sáng 30", breakfast 30), may mean 30,000 depending on context.
 */
function findAmounts(text) {
  const { source, tokens } = tokenize(text);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    let r = null;
    if (tok.type === 'num') r = readAmount(tokens, i, source);
    else if (tok.type === 'word') {
      const w = tok.text;
      if (w === 'nửa' && scaleAt(tokens, i + 1, source)) r = readAmount(tokens, i + 1, source, 0.5, i);
      else if (
        ((MULT_WORDS.has(w) || scaleAt(tokens, i, source)) && tailAt(tokens, i + 1, source))
        || (MULT_WORDS.get(w) === 100 && ['linh', 'lẻ'].includes(wordAt(tokens, i + 1)) && DIGIT_WORDS.has(wordAt(tokens, i + 2)))
      ) r = readAmount(tokens, i, source, 1);
      else if (DIGIT_WORDS.has(w) || w === 'mười' || w === 'muoi') r = readAmount(tokens, i, source);
    }
    if (r) {
      out.push(r.amount);
      i = r.next - 1;
    }
  }
  return out;
}

/**
 * Does the message mention money (digits, money words, or phrasings like "năm cành", "nửa củ")? Lenient on purpose:
 * an extra AI call beats a missed entry.
 */
function hasMoneyMention(text) {
  const t = normalizeText(text);
  return /\d/.test(t) || MONEY_WORD_RE.test(t) || findAmounts(t).some((a) => !a.bare);
}

/**
 * A money value (number, or string like "50k", "1.500.000đ") → positive number, or null.
 * A string must contain exactly one amount.
 */
function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > 60) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : null;
  }
  const found = findAmounts(s);
  if (found.length !== 1) return null;
  return found[0].value > 0 ? found[0].value : null;
}

/** Amount of an entry (action) returned by the FinTrack assistant (number or string), or null. */
function amountOf(action) {
  const v = action && action.amount;
  return parseMoney(typeof v === 'number' ? v : String(v ?? ''));
}

function currencyDecimals(currency) {
  const c = String(currency || 'VND').toUpperCase();
  return c === 'VND' || c === 'JPY' || c === 'KRW' ? 0 : 2;
}

function groupDigits(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** 50000 → "50.000đ"; 12.5 USD → "12,5 USD". */
function formatMoney(amount, currency = 'VND') {
  const cur = String(currency || 'VND').toUpperCase();
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (currencyDecimals(cur) === 0) {
    const int = groupDigits(String(Math.round(abs)));
    return cur === 'VND' ? `${sign}${int}đ` : `${sign}${int} ${cur}`;
  }
  const fixed = abs.toFixed(2).replace(/\.?0+$/, '');
  const [i, d] = fixed.split('.');
  return `${sign}${groupDigits(i)}${d ? `,${d}` : ''} ${cur}`;
}

/**
 * Does the AI's amount match the message? Accepted: equal to one of the numbers in the message, a bare number × 1000
 * ("ăn sáng 30" → 30,000), the sum of the amounts with units, or a number × a small bare multiplier ("2 người, mỗi
 * người 50k" = 2 people, 50k each). No number in the message (hard-to-read speech) → nothing to check → counts as a
 * match.
 */
function amountMatchesText(amount, candidates) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.value > 0) : [];
  if (!list.length) return true;
  const a = Number(amount);
  if (!(a > 0)) return false;
  const near = (x, y) => Math.abs(x - y) <= Math.max(0.5, y * 0.001);
  const values = new Set();
  for (const c of list) {
    values.add(c.value);
    if (c.bare) values.add(c.value * THOUSAND);
  }
  for (const v of values) if (near(a, v)) return true;
  const multipliers = list.filter((c) => c.bare && Number.isInteger(c.value) && c.value >= 2 && c.value <= 50).map((c) => c.value);
  for (const v of values) for (const m of multipliers) if (near(a, v * m)) return true;
  const priced = list.filter((c) => !c.bare).map((c) => c.value);
  if (priced.length > 1 && near(a, priced.reduce((s, v) => s + v, 0))) return true;
  return false;
}

module.exports = {
  findAmounts,
  hasMoneyMention,
  parseMoney,
  amountOf,
  formatMoney,
  amountMatchesText,
  // for tests
};
