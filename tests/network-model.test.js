import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMileage,
  milesAndYardsToMiles,
  milesToMilesAndYards,
  parseMileage,
  splitMileage,
} from '../src/processing/mileage.js';
import {
  NetworkModel,
  loadNetworkModel,
  mileageFromAnchor,
} from '../src/processing/network-model.js';
import { mergeTracks } from '../tools/build-network-model.js';
import { osgb36ToWgs84 } from '../tools/shapefile.js';

/**
 * A short stretch of a fictitious ELR, built the way the reference file is:
 * waymarks every quarter of a mile (`.0440` in the miles-and-yards notation of
 * the Network Rail network model) along a meridian, so that the geometry is
 * easy to reason about.
 */
function sampleModel() {
  const waymarks = [];
  for (let i = 0; i < 9; i++) {
    // A quarter of a mile is 402.336 m, i.e. 0.0036145° of latitude.
    waymarks.push([Number((i * 0.044).toFixed(4)), 52 + i * 0.0036145, -1]);
  }
  return new NetworkModel({
    attribution: 'test',
    elrs: {
      TST1: {
        waymarks,
        tracks: [
          ['1100', 0, 2.0],
          ['1200', 0, 0.088],
          ['2100', 1.0, 2.0],
        ],
      },
      OTH1: {
        waymarks: [
          [0, 53, -1],
          [0.044, 53.0036145, -1],
        ],
        tracks: [['1100', 0, 1.0]],
      },
    },
  });
}

test('mileages are read in the miles-and-yards notation of the network model', () => {
  // 326 miles 638 yards, as stored in L_M_FROM / WAYMARK_VALUE.
  assert.equal(milesAndYardsToMiles(326.0638), 326 + 638 / 1760);
  // The quarter-mile waymarks of the network.
  assert.equal(milesAndYardsToMiles(0.044), 0.25);
  assert.equal(milesAndYardsToMiles(0.088), 0.5);
  assert.equal(milesAndYardsToMiles(0.132), 0.75);
  assert.equal(milesAndYardsToMiles(1), 1);
  // Reference lines extend before the datum of their ELR.
  assert.equal(milesAndYardsToMiles(-1.088), -1.5);
});

test('mileages are written back in the same notation', () => {
  assert.ok(Math.abs(milesToMilesAndYards(326 + 638 / 1760) - 326.0638) < 1e-9);
  assert.ok(Math.abs(milesToMilesAndYards(0.25) - 0.044) < 1e-9);
  // 1759.6 yards is a full mile once rounded.
  assert.ok(Math.abs(milesToMilesAndYards(1759.8 / 1760) - 1) < 1e-9);
  assert.equal(formatMileage(326 + 638 / 1760), '326m 0638y');
  assert.equal(formatMileage(0.25), '0m 0440y');
  assert.equal(formatMileage(-1.5), '-1m 0880y');
  assert.equal(formatMileage(null), '–');
  assert.equal(splitMileage(0.25).chains, 20);
});

test('a mileage entered by the operator is read in either notation', () => {
  assert.equal(parseMileage('326.3625'), 326.3625);
  assert.equal(parseMileage('12 miles'), 12);
  assert.equal(parseMileage('326m 638y'), 326 + 638 / 1760);
  assert.equal(parseMileage('326 miles 638 yards'), 326 + 638 / 1760);
  assert.equal(parseMileage('326.0638my'), 326 + 638 / 1760);
  assert.equal(parseMileage('326.0638', { milesAndYards: true }), 326 + 638 / 1760);
  assert.equal(parseMileage(''), null);
  assert.equal(parseMileage('not a mileage'), null);
});

test('a position is located on the nearest ELR with an interpolated mileage', () => {
  const model = sampleModel();
  // Halfway between the second and the third waymark, 0.375 miles.
  const located = model.locate(52 + 0.0036145 * 1.5, -1);
  assert.equal(located.elr, 'TST1');
  assert.ok(Math.abs(located.mileage - 0.375) < 0.01, `mileage ${located.mileage}`);
  assert.ok(located.distanceM < 1, `distance ${located.distanceM}`);
  // Track IDs are the ones recorded at that mileage; parallel tracks cannot be
  // told apart from a GNSS fix, so all of them are reported.
  assert.deepEqual(located.tracks, ['1100', '1200']);
});

test('a position away from the network is not located', () => {
  const model = sampleModel();
  assert.equal(model.locate(52.5, -1), null);
  assert.equal(model.locate(52, -1.01), null);
  // The search can be restricted to one ELR.
  assert.equal(model.locate(53.001, -1, { elr: 'TST1' }), null);
  assert.equal(model.locate(53.001, -1).elr, 'OTH1');
});

test('a run is anchored on the ELR its fixes belong to', () => {
  const model = sampleModel();
  const gnss = [
    { t: 0, lat: 52 + 0.0036145 * 2, lon: -1 },
    { t: 30, lat: 52 + 0.0036145 * 3, lon: -1 },
    { t: 60, lat: 52 + 0.0036145 * 4, lon: -1 },
  ];
  const anchor = model.anchor(gnss);
  assert.equal(anchor.elr, 'TST1');
  assert.equal(anchor.mileageDirection, 1);
  assert.ok(Math.abs(anchor.mileage - 0.5) < 0.01, `mileage ${anchor.mileage}`);
  assert.equal(anchor.t, 0);
  assert.equal(anchor.located, 3);
  // Only the track running along the whole recording is a candidate.
  assert.deepEqual(anchor.tracks, ['1100']);

  const reversed = model.anchor([...gnss].reverse().map((fix, i) => ({ ...fix, t: i * 30 })));
  assert.equal(reversed.mileageDirection, -1);
  assert.equal(model.anchor([{ t: 0, lat: 52.5, lon: -1 }]), null);
  assert.equal(model.anchor([]), null);
});

test('the mileage of a defect follows the direction of the mileage', () => {
  assert.ok(Math.abs(mileageFromAnchor(10, 1609.344, 1) - 11) < 1e-9);
  assert.ok(Math.abs(mileageFromAnchor(10, 1609.344, -1) - 9) < 1e-9);
});

test('a missing reference file leaves the application without a model', async () => {
  assert.equal(await loadNetworkModel('data/network-model.json', undefined), null);
  assert.equal(
    await loadNetworkModel('missing.json', async () => ({ ok: false, status: 404 })),
    null,
  );
  const model = await loadNetworkModel('model.json', async () => ({
    ok: true,
    json: async () => ({ elrs: { TST1: { waymarks: [[0, 52, -1]], tracks: [] } } }),
  }));
  assert.equal(model.size, 1);
});

test('consecutive links of a track are merged into one mileage range', () => {
  const merged = mergeTracks([
    ['1100', 0, 0.088],
    ['1100', 0.088, 0.176],
    ['1100', 1.0, 1.088],
    ['1200', 0, 0.044],
  ]);
  assert.deepEqual(merged, [
    ['1100', 0, 0.176],
    ['1200', 0, 0.044],
    ['1100', 1.0, 1.088],
  ]);
});

test('the network model coordinates are converted from British National Grid', () => {
  // Waymark 0 of ECM1, the datum of the East Coast Main Line at King's Cross.
  const { lat, lon } = osgb36ToWgs84(530269, 183014);
  assert.ok(Math.abs(lat - 51.531) < 0.001, `lat ${lat}`);
  assert.ok(Math.abs(lon + 0.1234) < 0.001, `lon ${lon}`);
});
