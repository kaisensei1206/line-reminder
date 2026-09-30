import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calendarText, parseTaipei } from '../src/voice.js';

test('台灣時間轉換', () => {
  assert.equal(new Date(parseTaipei('2026-10-07T10:00')).toISOString(), '2026-10-07T02:00:00.000Z');
  assert.ok(Number.isNaN(parseTaipei('下週三')));
});

test('日曆：2026/9/30 星期三的「下週三」是 10/7', () => {
  const now = Date.parse('2026-09-30T08:00:00Z'); // 台灣 16:00
  const cal = calendarText(now);
  assert.match(cal, /現在是 2026 年 9 月 30 日 星期三 16:00/);
  assert.match(cal, /2026-10-07 星期三，下週三/);
  assert.match(cal, /2026-10-01 星期四，本週四（明天）/);
  assert.match(cal, /2026-10-05 星期一，下週一/);
});

test('日曆：星期日的「下週一」是隔天', () => {
  const now = Date.parse('2026-10-04T02:00:00Z'); // 台灣 10/4 星期日
  assert.match(calendarText(now), /2026-10-05 星期一，下週一（明天）/);
});
