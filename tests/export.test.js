import test from 'node:test';
import assert from 'node:assert/strict';

import {
  accelerationCsv,
  eventsCsv,
  filePrefix,
  gnssCsv,
  markersCsv,
  spaceDomainCsv,
  toCsv,
} from '../src/export.js';
import { summarise } from '../src/storage.js';

const run = {
  meta: { elr: 'ECM1', track: '1100', startedAt: '2025-04-01T08:00:00.000Z', initialMileageMi: 12 },
  acceleration: [
    { t: 0, vertical: 9.81, lateral: 0.1, longitudinal: -0.2, x: 0.1, y: -0.2, z: 9.81 },
    { t: 0.01, vertical: 9.9, lateral: 0.2, longitudinal: -0.1, x: 0.2, y: -0.1, z: 9.9 },
  ],
  gnss: [
    { t: 0, lat: 48.1, lon: 2.2, altitude: 120, speed: 25, heading: 90, accuracy: 4 },
  ],
  markers: [{ t: 1.5, type: 'tunnel, north', lat: 48.1, lon: 2.2 }],
};

test('toCsv escapes separators and quotes', () => {
  const csv = toCsv(['a', 'b'], [['x,y', 'he said "hi"']]);
  assert.equal(csv, 'a,b\n"x,y","he said ""hi"""\n');
});

test('the raw datasheets contain one line per sample', () => {
  const accel = accelerationCsv(run).trim().split('\n');
  assert.equal(accel.length, 3);
  assert.equal(accel[0], 't_s,avc_ms2,atc_ms2,alc_ms2,raw_x,raw_y,raw_z');
  const gnss = gnssCsv(run).trim().split('\n');
  assert.equal(gnss.length, 2);
  assert.ok(gnss[1].startsWith('0,48.1,2.2,120,25'));
});

test('markers are exported with quoting', () => {
  assert.ok(markersCsv(run).includes('"tunnel, north"'));
});

test('empty and missing values become empty cells', () => {
  const csv = gnssCsv({ gnss: [{ t: 1, lat: 1, lon: 2, altitude: null, speed: null }] });
  assert.equal(csv.trim().split('\n')[1], '1,1,2,,,,');
});

test('processed exports follow the space-domain grid', () => {
  const processed = {
    location: { elr: 'ECM1', track: '1100' },
    spaceDomain: {
      distance: [0, 0.25],
      mileage: [12, 12.00016],
      channels: { vertical: [0, 1], lateral: [0, 0], longitudinal: [0, 0] },
      lat: [48, 48],
      lon: [2, 2],
    },
    events: [
      {
        channel: 'vertical',
        level: 'intervention',
        value: 2.6,
        limit: 2.5,
        mileage: 12.0003,
        distance: 0.5,
        lengthM: 0.5,
        lat: 48,
        lon: 2,
      },
    ],
  };
  const space = spaceDomainCsv(processed).trim().split('\n');
  assert.equal(space.length, 3);
  // The ELR, the track and the mileage written as on the network.
  assert.ok(space[1].startsWith('0,ECM1,1100,12,12m 0000y'));
  const events = eventsCsv(processed).trim().split('\n');
  assert.equal(events.length, 2);
  assert.ok(events[1].startsWith('ECM1,1100,vertical,intervention,2.6,2.5'));
  assert.ok(events[1].includes('12m 0001y'));
});

test('summarise reports the effective sampling rate', () => {
  const summary = summarise(run);
  assert.equal(summary.samples, 2);
  assert.equal(summary.fixes, 1);
  assert.equal(summary.markers, 1);
  assert.equal(Math.round(summary.rateHz), 100);
});

test('filePrefix builds a file-system safe name', () => {
  const prefix = filePrefix(summarise(run));
  assert.equal(prefix, 'elrECM1-track1100-2025-04-01T08-00-00-000Z');
  assert.ok(!/[:.]/.test(prefix.replace(/^elr/, '')));
});
