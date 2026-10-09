import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(project, 'work', 'tests');
await mkdir(temporary, { recursive: true });
const output = path.join(temporary, 'delivery-time.cjs');
await build({ entryPoints: [path.join(project, 'src', 'delivery-time.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { default: module } = await import(pathToFileURL(output).href);
const { parseDeliveryTime, formatDeliveryTime, defaultDeliveryTime, deliveryResultUrl } = module;
const now = Date.parse('2026-01-01T00:00:00Z');

assert.equal(parseDeliveryTime('2026-02-12T09:30', 'America/Los_Angeles', now), '2026-02-12T17:30:00.000Z');
assert.equal(parseDeliveryTime('2026-09-30T09:30', 'America/Los_Angeles', now), '2026-09-30T16:30:00.000Z');
assert.equal(parseDeliveryTime('2026-09-30T09:30', 'Asia/Shanghai', now), '2026-09-30T01:30:00.000Z');
assert.equal(parseDeliveryTime('2026-09-30T02:30', 'Asia/Shanghai', now), '2026-09-29T18:30:00.000Z');
assert.throws(() => parseDeliveryTime('2026-03-08T02:30', 'America/Los_Angeles', now), /不存在/);
assert.throws(() => parseDeliveryTime('2026-11-01T01:30', 'America/Los_Angeles', now), /出现两次/);
assert.equal(parseDeliveryTime('2026-11-01T02:30', 'America/Los_Angeles', now), '2026-11-01T10:30:00.000Z');
assert.equal(parseDeliveryTime('2026-03-08T03:30', 'America/Los_Angeles', now), '2026-03-08T10:30:00.000Z');
assert.throws(() => parseDeliveryTime('2026-02-29T10:30', 'Asia/Shanghai', now), /不正确/);
assert.equal(parseDeliveryTime('2028-02-29T10:30', 'Asia/Shanghai', now), '2028-02-29T02:30:00.000Z');
for (const value of ['2026-13-01T09:00', '2026-09-31T09:00', '2026-09-30T24:00', '2026-09-30T09:60']) {
  assert.throws(() => parseDeliveryTime(value, 'Asia/Shanghai', now), /不正确/);
}
for (const value of ['2026-09-30 09:30', '2026-09-30T09:30Z', '2026-09-30T09:30+08:00', '2026-09-30T09:30:00']) {
  assert.throws(() => parseDeliveryTime(value, 'Asia/Shanghai', now), /完整/);
}
assert.throws(() => parseDeliveryTime('2026-09-30T09:30', '', now), /时区/);
assert.throws(() => parseDeliveryTime('2026-09-30T09:30', 'UTC', now), /时区/);
assert.throws(() => parseDeliveryTime('2026-01-01T08:00', 'Asia/Shanghai', now), /晚于现在/);
// Reusing timezone formatters must not reuse an earlier future-time verdict.
const sameSelection = '2026-09-30T09:30';
const sameInstant = Date.parse('2026-09-30T01:30:00Z');
assert.equal(parseDeliveryTime(sameSelection, 'Asia/Shanghai', sameInstant - 1), '2026-09-30T01:30:00.000Z');
assert.throws(() => parseDeliveryTime(sameSelection, 'Asia/Shanghai', sameInstant), /晚于现在/);
assert.throws(() => parseDeliveryTime(sameSelection, 'Asia/Shanghai', sameInstant + 1), /晚于现在/);
assert.equal(defaultDeliveryTime('America/Los_Angeles', Date.parse('2026-09-30T06:30:00Z')), '2026-09-30T00:30');
assert.equal(defaultDeliveryTime('Asia/Shanghai', Date.parse('2026-09-30T06:30:00Z')), '2026-09-30T15:30');
assert.equal(formatDeliveryTime('2026-09-30T01:30:00Z', 'Asia/Shanghai'), '2026-09-30 09:30 · Asia/Shanghai');
assert.equal(deliveryResultUrl('https://x.com/zwzw3888/status/123456'), 'https://x.com/zwzw3888/status/123456');
for (const url of ['javascript:alert(1)', 'https://evil.test/zwzw3888/status/123', 'https://x.com.evil.test/a/status/1', 'https://x.com@evil.test/a/status/1', 'https://evil@x.com/a/status/1', 'https://x.com/a']) {
  assert.equal(deliveryResultUrl(url), null);
}
console.log('通过：显式时区换算、DST 重复/不存在时刻、无效日期、过去时间和结果链接校验');
