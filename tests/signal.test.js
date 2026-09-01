import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bandpass,
  designLowpass,
  filtfilt,
  haversine,
  interpolateAt,
  percentile,
  resample,
  rms,
  uniformGrid,
} from '../src/processing/signal.js';

test('interpolateAt fills missing points linearly', () => {
  const out = interpolateAt([0, 2], [10, 20], [0, 0.5, 1, 2]);
  assert.deepEqual(out, [10, 12.5, 15, 20]);
});

test('interpolateAt clamps outside the source range and ignores nulls', () => {
  const out = interpolateAt([0, 1, 2], [5, null, 9], [-1, 1, 3]);
  assert.deepEqual(out, [5, 7, 9]);
});

test('interpolateAt returns nulls when no value is available', () => {
  assert.deepEqual(interpolateAt([0, 1], [null, null], [0, 1]), [null, null]);
});

test('uniformGrid produces an exact step', () => {
  assert.deepEqual(uniformGrid(0, 1, 0.25), [0, 0.25, 0.5, 0.75, 1]);
  assert.throws(() => uniformGrid(0, 1, 0));
});

test('resample puts irregular samples on an exact frequency', () => {
  const xs = [0, 0.011, 0.019, 0.033];
  const { x, channels } = resample(xs, { a: [0, 1, 2, 3] }, 0.01);
  assert.deepEqual(x.map((v) => Number(v.toFixed(3))), [0, 0.01, 0.02, 0.03]);
  assert.equal(channels.a.length, 4);
  assert.ok(channels.a[3] > channels.a[2]);
});

test('a low-pass filter keeps the slow component and removes the fast one', () => {
  const fs = 200;
  const n = 2000;
  const slow = [];
  const fast = [];
  const mixed = [];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const s = Math.sin(2 * Math.PI * 1 * t);
    const f = Math.sin(2 * Math.PI * 40 * t);
    slow.push(s);
    fast.push(f);
    mixed.push(s + f);
  }
  const filtered = filtfilt(mixed, designLowpass(5, fs, 4));
  const error = filtered.map((v, i) => v - slow[i]);
  assert.ok(rms(error) < 0.05, `residual too large: ${rms(error)}`);
  assert.ok(rms(fast) > 0.5);
});

test('zero-phase filtering keeps the position of a peak', () => {
  const fs = 100;
  const signal = new Array(400).fill(0);
  for (let i = 195; i < 205; i++) signal[i] = 1;
  const filtered = bandpass(signal, fs, 0, 10, 4);
  let peakIndex = 0;
  for (let i = 0; i < filtered.length; i++) {
    if (filtered[i] > filtered[peakIndex]) peakIndex = i;
  }
  assert.ok(Math.abs(peakIndex - 199.5) <= 2, `peak moved to ${peakIndex}`);
});

test('band-pass removes a constant offset (gravity)', () => {
  const fs = 100;
  const signal = new Array(1000).fill(9.81);
  const filtered = bandpass(signal, fs, 0.4, 10, 4);
  assert.ok(Math.abs(filtered[500]) < 1e-3);
});

test('rms and percentile', () => {
  assert.equal(rms([3, 4]), Math.sqrt(12.5));
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([], 95), 0);
});

test('haversine matches a known distance', () => {
  // One degree of latitude is close to 111.2 km.
  const d = haversine(45, 3, 46, 3);
  assert.ok(Math.abs(d - 111195) < 500, `unexpected distance ${d}`);
});
