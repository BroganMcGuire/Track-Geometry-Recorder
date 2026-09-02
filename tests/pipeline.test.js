import test from 'node:test';
import assert from 'node:assert/strict';

import { processRun, toSpaceDomain } from '../src/processing/pipeline.js';
import { detectThresholds } from '../src/processing/thresholds.js';
import {
  cumulativeDistance,
  estimateSpeed,
  toMileage,
} from '../src/processing/localisation.js';

/**
 * Build a synthetic run: a train at a constant speed with a single vertical
 * defect, an irregular accelerometer sampling rate and a GNSS outage.
 */
function syntheticRun({
  durationS = 60,
  nominalHz = 100,
  speedMs = 25,
  defectAtS = 30,
  defectAmplitude = 4,
  gnssGap = null,
} = {}) {
  const acceleration = [];
  let t = 0;
  let i = 0;
  while (t < durationS) {
    // Irregular sampling, as observed on smartphones.
    const jitter = 1 + 0.15 * Math.sin(i / 7);
    t += jitter / nominalHz;
    i++;
    const noise = 0.2 * Math.sin(2 * Math.PI * 3 * t);
    // Single defect modelled as a short bump whose energy lies in the band of
    // interest (a few Hz).
    const defect = defectAmplitude * Math.exp(-(((t - defectAtS) / 0.08) ** 2));
    acceleration.push({
      t,
      vertical: 9.81 + noise + defect,
      lateral: 0.1 * Math.sin(2 * Math.PI * 1.5 * t),
      longitudinal: 0,
    });
  }

  const gnss = [];
  for (let s = 0; s <= durationS; s++) {
    if (gnssGap && s > gnssGap[0] && s < gnssGap[1]) continue;
    gnss.push({
      t: s,
      lat: 48 + (speedMs * s) / 111320,
      lon: 2,
      speed: speedMs,
      accuracy: 5,
    });
  }
  return { acceleration, gnss, meta: { line: '001', track: 1 } };
}

test('the pipeline resamples to the requested exact frequency', () => {
  const result = processRun(syntheticRun({ durationS: 10 }), { resampleHz: 100 });
  const time = result.timeDomain.time;
  for (let i = 1; i < time.length; i++) {
    assert.ok(Math.abs(time[i] - time[i - 1] - 0.01) < 1e-9);
  }
});

test('filtering removes gravity from the vertical channel', () => {
  const result = processRun(syntheticRun({ durationS: 30, defectAtS: 999 }));
  const mid = result.timeDomain.vertical.slice(500, 2000);
  const mean = mid.reduce((a, b) => a + b, 0) / mid.length;
  assert.ok(Math.abs(mean) < 0.05, `gravity not removed, mean = ${mean}`);
});

test('the space domain uses a 0.25 m step and covers the whole run', () => {
  const run = syntheticRun({ durationS: 40, speedMs: 25 });
  const result = processRun(run);
  const d = result.spaceDomain.distance;
  assert.equal(result.spaceDomain.step, 0.25);
  assert.ok(Math.abs(d[1] - d[0] - 0.25) < 1e-9);
  // 40 s at 25 m/s is close to 1000 m.
  assert.ok(Math.abs(d[d.length - 1] - 1000) < 20, `length ${d[d.length - 1]}`);
});

test('a defect is detected and located at the right mileage', () => {
  const run = syntheticRun({ durationS: 60, speedMs: 25, defectAtS: 30 });
  const result = processRun(run, { initialMileageMi: 100 });
  const vertical = result.events.filter((e) => e.channel === 'vertical');
  assert.ok(vertical.length >= 1, 'the vertical defect was not detected');
  const worst = vertical.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
  // 30 s at 25 m/s = 750 m after the start, i.e. mile 100.466.
  assert.ok(Math.abs(worst.distance - 750) < 15, `located at ${worst.distance} m`);
  assert.ok(Math.abs(worst.mileage - 100.466) < 0.01, `mileage ${worst.mileage}`);
  assert.ok(worst.lat !== null);
  assert.equal(typeof worst.level, 'string');
});

test('a quiet run raises no threshold event', () => {
  const run = syntheticRun({ durationS: 30, defectAtS: 999 });
  const result = processRun(run);
  assert.equal(result.events.length, 0);
});

test('the mileage can decrease along the run', () => {
  const mileage = toMileage([0, 1609.344, 3218.688], 100, -1);
  assert.deepEqual(mileage, [100, 99, 98]);
});

test('the speed is interpolated inside short GNSS gaps', () => {
  const times = [0, 1, 2, 3];
  const { speed, source } = estimateSpeed(times, [0, 0, 0, 0], [
    { t: 0, lat: 48, lon: 2, speed: 20 },
    { t: 3, lat: 48, lon: 2, speed: 26 },
  ], { maxGapS: 5 });
  assert.deepEqual(speed.map((v) => Number(v.toFixed(3))), [20, 22, 24, 26]);
  assert.ok(source.every((s) => s === 'gnss'));
});

test('the longitudinal acceleration fills a long GNSS outage', () => {
  const times = [];
  const longitudinal = [];
  for (let i = 0; i <= 200; i++) {
    times.push(i / 10);
    // Constant acceleration of 0.5 m/s² during the outage.
    longitudinal.push(i / 10 > 2 && i / 10 < 18 ? 0.5 : 0);
  }
  const gnss = [
    { t: 0, lat: 48, lon: 2, speed: 20 },
    { t: 2, lat: 48, lon: 2, speed: 20 },
    { t: 18, lat: 48, lon: 2, speed: 28 },
    { t: 20, lat: 48, lon: 2, speed: 28 },
  ];
  const { speed, source } = estimateSpeed(times, longitudinal, gnss, { maxGapS: 3 });
  const at10s = speed[100];
  // Halfway through the outage the speed should be about 24 m/s.
  assert.ok(Math.abs(at10s - 24) < 0.6, `speed at 10 s = ${at10s}`);
  assert.equal(source[100], 'inertial');
  assert.equal(source[5], 'gnss');
});

test('estimateSpeed falls back to pure integration without any GNSS fix', () => {
  const times = [0, 1, 2];
  const { speed, source } = estimateSpeed(times, [1, 1, 1], []);
  assert.deepEqual(speed, [0, 1, 2]);
  assert.ok(source.every((s) => s === 'inertial'));
});

test('cumulativeDistance integrates the speed', () => {
  const d = cumulativeDistance([0, 1, 2], [10, 10, 20]);
  assert.deepEqual(d, [0, 10, 25]);
});

test('detectThresholds reports one event per exceedance with its peak', () => {
  const spaceDomain = {
    distance: [0, 0.25, 0.5, 0.75, 1, 1.25],
    channels: {
      vertical: [0, 2.2, 3.4, 0.1, 0, 0],
      lateral: [0, 0, 0, 0, 0, 0],
    },
    mileage: [10, 10.00016, 10.00031, 10.00047, 10.00062, 10.00078],
    lat: [48, 48, 48, 48, 48, 48],
    lon: [2, 2, 2, 2, 2, 2],
  };
  const events = detectThresholds(spaceDomain);
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, 'vertical');
  assert.equal(events[0].value, 3.4);
  assert.equal(events[0].level, 'immediate action');
  assert.equal(events[0].distance, 0.5);
  assert.ok(Math.abs(events[0].lengthM - 0.5) < 1e-9);
});

test('detectThresholds handles an exceedance still open at the end', () => {
  const events = detectThresholds({
    distance: [0, 0.25],
    channels: { vertical: [0, -3.5] },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].value, -3.5);
});

test('toSpaceDomain degrades gracefully on a run shorter than one step', () => {
  const timeDomain = {
    time: [0, 0.01],
    distance: [0, 0.01],
    vertical: [0, 0],
    lateral: [0, 0],
    longitudinal: [0, 0],
    mileage: [1, 1],
    lat: [48, 48],
    lon: [2, 2],
    speed: [1, 1],
  };
  const space = toSpaceDomain(timeDomain, 0.25);
  assert.equal(space.distance.length, 1);
});

test('processRun rejects a recording without enough samples', () => {
  assert.throws(() => processRun({ acceleration: [], gnss: [] }));
});

test('statistics report RMS, C95 and speed', () => {
  const result = processRun(syntheticRun({ durationS: 20, defectAtS: 999 }));
  assert.ok(result.statistics.vertical.rms > 0);
  assert.ok(result.statistics.vertical.c95 > 0);
  assert.ok(Math.abs(result.statistics.speed.meanMph - 55.9) < 1);
});
