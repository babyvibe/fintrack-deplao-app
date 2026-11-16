'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findAmounts, parseMoney, formatMoney, hasMoneyMention, amountMatchesText } = require('../backend/lib/money');

const values = (text) => findAmounts(text).map((a) => a.value);

test('digits + thousand unit (nghìn / k)', () => {
  for (const s of ['50k', '50K', '50 k', '50 nghìn', '50 ngàn', '50 nghin', '50 ngan']) assert.deepEqual(values(s), [50000], s);
  assert.deepEqual(values('1,5k'), [1500]);
  assert.deepEqual(values('1.500k'), [1500000]);
});

test('millions: tr, triệu, củ, trailing digits and rưỡi (and a half)', () => {
  const cases = {
    '1tr': 1_000_000,
    '1tr2': 1_200_000,
    '1tr25': 1_250_000,
    '1tr250': 1_250_000,
    '1 triệu 2': 1_200_000,
    '1 triệu 200': 1_200_000,
    '1 triệu 200 nghìn': 1_200_000,
    '1tr200k': 1_200_000,
    '1 triệu 2 trăm': 1_200_000,
    '2 triệu rưỡi': 2_500_000,
    '1,5 triệu': 1_500_000,
    '1.5tr': 1_500_000,
    '2 củ': 2_000_000,
    '3 trieu': 3_000_000,
  };
  for (const [s, v] of Object.entries(cases)) assert.deepEqual(values(s), [v], s);
});

test('tỷ, lít, trăm, chục (spoken money units)', () => {
  const cases = {
    '1 tỷ': 1e9,
    '1 tỷ 2': 1.2e9,
    '1 tỷ 200 triệu': 1.2e9,
    '3 lít': 300_000,
    '3 lít rưỡi': 350_000,
    '2 trăm': 200_000,
    '2 trăm rưỡi': 250_000,
    '2 trăm nghìn': 200_000,
    '5 chục': 50_000,
    '5 chục nghìn': 50_000,
  };
  for (const [s, v] of Object.entries(cases)) assert.deepEqual(values(s), [v], s);
});

test('thousands separators, đồng unit', () => {
  assert.deepEqual(values('1.500.000'), [1_500_000]);
  assert.deepEqual(values('1,500,000'), [1_500_000]);
  assert.deepEqual(values('1.500.000đ'), [1_500_000]);
  assert.deepEqual(values('200.000 đồng'), [200_000]);
  assert.deepEqual(values('50000 vnd'), [50_000]);
  assert.deepEqual(values('12.345,67'), [12345.67]);
  assert.equal(findAmounts('1.500.000').at(0).bare, true);
  assert.equal(findAmounts('1.500.000đ').at(0).bare, false);
});

test('numbers spelled out in words (transcribed speech)', () => {
  const cases = {
    'năm mươi nghìn': 50_000,
    'hai trăm năm mươi nghìn': 250_000,
    'mười lăm nghìn': 15_000,
    'hai mươi mốt nghìn': 21_000,
    'một trăm linh năm nghìn': 105_000,
    'ba trăm rưỡi': 350_000,
    'năm chục': 50_000,
    'một triệu hai': 1_200_000,
    'một triệu hai trăm': 1_200_000,
    'một triệu rưỡi': 1_500_000,
    'hai triệu ba trăm nghìn': 2_300_000,
    'một tỷ hai trăm triệu': 1.2e9,
    'nam muoi nghin': 50_000,
  };
  for (const [s, v] of Object.entries(cases)) assert.deepEqual(values(s), [v], s);
  assert.deepEqual(findAmounts('ba mươi').map((a) => [a.value, a.bare]), [[30, true]]);
  assert.deepEqual(values('năm nay đi chợ'), [], 'a lone digit word is not an amount');
  assert.deepEqual(values('ba ơi'), []);
});

test('several amounts in one sentence, bare numbers, USD', () => {
  assert.deepEqual(values('Ăn sáng 30k, cafe 25k'), [30_000, 25_000]);
  assert.deepEqual(findAmounts('2 người ăn mỗi người 50k').map((a) => [a.value, a.bare]), [[2, true], [50_000, false]]);
  assert.deepEqual(findAmounts('$5').map((a) => [a.value, a.currency]), [[5, 'USD']]);
  assert.deepEqual(findAmounts('5 usd').map((a) => [a.value, a.currency]), [[5, 'USD']]);
  assert.deepEqual(values('mua 2 ti vi hết 10tr'), [2, 10_000_000], '"ti" without diacritics is not read as tỷ');
});

// How Vietnamese people say amounts (same examples as FinTrack apps/api/src/vn-money.test.ts).
const SLANG = [
  ['ăn bán bún 5 chục', 50_000], ['50 cành', 50_000], ['200 ca', 200_000], ['50 ka', 50_000], ['50k', 50_000],
  ['5 lít', 500_000], ['3 lốp', 300_000], ['3 loét', 300_000], ['3 sọi', 300_000], ['3 xị', 300_000],
  ['1 củ', 1_000_000], ['2 chai', 2_000_000], ['1 quả', 1_000_000], ['1 tỏi', 1_000_000_000],
  ['nửa củ', 500_000], ['nửa triệu', 500_000], ['củ rưỡi', 1_500_000], ['lít rưỡi', 150_000], ['chục rưỡi', 15_000],
  ['triệu tư', 1_400_000], ['2 triệu mốt', 2_100_000], ['2 triệu hai', 2_200_000], ['1 củ 2', 1_200_000],
  ['trăm mốt', 110_000], ['trăm hai', 120_000], ['hai trăm mốt', 210_000], ['trăm linh hai', 102_000],
  ['năm cành', 5_000], ['hai lít', 200_000], ['ba củ', 3_000_000], ['một triệu ba trăm năm mươi', 1_350_000],
  ['hết 2 củ rồi', 2_000_000], ['chuyển 3 lít cho mẹ', 300_000], ['tối qua ăn 2 trăm', 200_000],
];

test('slang: cành / ca / ka = thousand, lít / lốp / loét / sọi / xị = 100 thousand, củ / chai / quả = million, tỏi = billion', () => {
  for (const [text, amount] of SLANG) assert.deepEqual(values(text), [amount], text);
});

test('slang words are also nouns: "3 lít xăng", "2 chai nước" are quantities; "2 triệu năm nay" does not become 2.5 million', () => {
  assert.deepEqual(findAmounts('đổ 3 lít xăng hết 75k').map((a) => [a.value, a.bare]), [[3, true], [75_000, false]]);
  assert.deepEqual(values('mua 2 chai nước 30k'), [2, 30_000]);
  assert.deepEqual(values('2 củ khoai 10k'), [2, 10_000]);
  assert.deepEqual(values('5 cành hoa 100 cành'), [5, 100_000]);
  assert.deepEqual(values('1 củ tỏi tây 15k').at(-1), 15_000);
  assert.deepEqual(values('lương 2 triệu năm nay'), [2_000_000]);
  assert.deepEqual(values('2 triệu ba mẹ cho'), [2_000_000]);
  assert.deepEqual(values('hàng trăm người'), []);
  assert.deepEqual(findAmounts('2 trăm đô').map((a) => [a.value, a.currency]), [[200, 'USD']]);
  // Punctuation right after the slang word ends the phrase, so it is money.
  assert.deepEqual(values('hết 3 lít, xăng đầy bình'), [300_000]);
});

test('parseMoney: a number, or a string with exactly one amount', () => {
  assert.equal(parseMoney(50000), 50000);
  assert.equal(parseMoney('50k'), 50000);
  assert.equal(parseMoney('1.500.000đ'), 1_500_000);
  assert.equal(parseMoney(' 50000 '), 50000);
  assert.equal(parseMoney('12.5'), 12.5);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('50k 20k'), null);
  assert.equal(parseMoney(-5), null);
  assert.equal(parseMoney(0), null);
  assert.equal(parseMoney(Number.NaN), null);
  assert.equal(parseMoney(null), null);
});

test('formatMoney', () => {
  assert.equal(formatMoney(50000), '50.000đ');
  assert.equal(formatMoney(1234567, 'VND'), '1.234.567đ');
  assert.equal(formatMoney(999), '999đ');
  assert.equal(formatMoney(12.5, 'USD'), '12,5 USD');
  assert.equal(formatMoney(100, 'usd'), '100 USD');
  assert.equal(formatMoney(1000.05, 'USD'), '1.000,05 USD');
});

test('hasMoneyMention: quick filter for chit-chat messages', () => {
  assert.equal(hasMoneyMention('ok cảm ơn cả nhà'), false);
  assert.equal(hasMoneyMention('Mai đi chợ nhé'), false);
  assert.equal(hasMoneyMention('ăn sáng 30'), true);
  assert.equal(hasMoneyMention('ăn sáng hết năm chục'), true);
  assert.equal(hasMoneyMention('đổ xăng hai trăm nghìn'), true);
  assert.equal(hasMoneyMention(''), false);
  // Slang without digits passes the filter; ordinary nouns do not.
  for (const s of ['ăn trưa năm cành', 'mua áo hết nửa củ', 'đóng học hai chai', 'cafe chục rưỡi', 'tiền nhà triệu tư']) {
    assert.equal(hasMoneyMention(s), true, s);
  }
  for (const s of ['mua chai nước nhé', 'hái cành hoa', 'ca tối nay ai trực']) assert.equal(hasMoneyMention(s), false, s);
});

test('amountMatchesText: guards against amounts made up by the AI', () => {
  const c = (t) => findAmounts(t);
  assert.equal(amountMatchesText(50000, c('Ăn trưa 50k')), true);
  assert.equal(amountMatchesText(500000, c('Ăn trưa 50k')), false);
  assert.equal(amountMatchesText(30000, c('ăn sáng 30')), true, 'bare number × 1000');
  assert.equal(amountMatchesText(100000, c('2 người mỗi người 50k')), true, 'amount × bare multiplier');
  assert.equal(amountMatchesText(55000, c('30k với 25k')), true, 'sum of the amounts');
  assert.equal(amountMatchesText(70000, c('Ăn trưa')), true, 'no number to check against');
});
