import test from 'node:test';
import assert from 'node:assert/strict';

import { runRow, thresholdEvents } from '../tools/db-upload.js';

const run = {
  meta: {
    elr: 'ECM1',
    track: '1100',
    trainType: 'class 700',
    position: 'coach 5',
    initialMileageMi: 12.5,
    mileageDirection: -1,
    startedAt: '2025-04-01T08:00:00.000Z',
  },
  acceleration: [
    { t: 0, vertical: 9.81, lateral: 0, longitudinal: 0 },
    { t: 0.01, vertical: 9.82, lateral: 0, longitudinal: 0 },
  ],
  gnss: [{ t: 0, lat: 52.1, lon: -0.5, speed: 30 }],
  markers: [],
};

test('runRow maps the journey information onto the runs table', () => {
  const row = runRow(run);
  assert.equal(row.id, '2025-04-01T08:00:00.000Z');
  assert.equal(row.elr, 'ECM1');
  assert.equal(row.track, '1100');
  assert.equal(row.initial_mileage_mi, 12.5);
  assert.equal(row.mileage_direction, -1);
  assert.equal(row.samples, 2);
  assert.equal(row.fixes, 1);
  assert.deepEqual(row.markers, []);
});

test('runRow accepts an explicit identifier and tolerates missing metadata', () => {
  const row = runRow({ acceleration: [], gnss: [] }, 'custom-id');
  assert.equal(row.id, 'custom-id');
  assert.equal(row.elr, '');
  assert.equal(row.initial_mileage_mi, 0);
  assert.equal(row.mileage_direction, 1);
});

test('a run too short to be processed uploads without events', () => {
  assert.deepEqual(thresholdEvents({ acceleration: [], gnss: [] }), []);
});
