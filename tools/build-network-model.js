#!/usr/bin/env node
/**
 * Build the ELR / track ID / mileage reference file used by the application
 * from the Network Rail network model.
 *
 * The source datasets are the Infrastructure Network Model extracts published
 * by Network Rail under the Open Government Licence v3.0 and mirrored in
 * https://github.com/openraildata/network-rail-gis:
 *
 *   network-model/VectorWaymarks/NetworkWaymarks.shp   ELR + WAYMARK_VALUE
 *   network-model/VectorLinks/NetworkLinks.shp         ELR + TRID + mileages
 *
 * They are ESRI shapefiles in British National Grid and much too large to ship
 * with a progressive web app, so they are converted once into a compact JSON
 * file (WGS84, only the fields the application needs):
 *
 *   { "elrs": { "ECM1": { "waymarks": [[mileage, lat, lon], …],
 *                         "tracks":   [[trid, from, to], …] } } }
 *
 * Mileages keep the miles-and-yards notation of the network model; the
 * application converts them with `src/processing/mileage.js`.
 *
 * Usage:
 *   node tools/build-network-model.js                     # downloads the data
 *   node tools/build-network-model.js <checkout> [output]
 *
 * The default output is `data/network-model.json`, which the application loads
 * at start-up if it is present.
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { osgb36ToWgs84, readDbf, readShp } from './shapefile.js';

const ATTRIBUTION =
  'Network Rail Infrastructure Network Model, published under the Open Government ' +
  'Licence v3.0 via https://github.com/openraildata/network-rail-gis';

/** Files of the network-rail-gis repository the reference file is built from. */
export const SOURCE_FILES = [
  'network-model/VectorWaymarks/NetworkWaymarks.shp',
  'network-model/VectorWaymarks/NetworkWaymarks.dbf',
  'network-model/VectorLinks/NetworkLinks.dbf',
];

/** Where the source files are downloaded from when no local checkout is given. */
export const SOURCE_BASE_URL =
  'https://raw.githubusercontent.com/openraildata/network-rail-gis/main/';

/**
 * Download the source datasets, so that the reference file can be built without
 * cloning the whole repository.
 *
 * @param {string} [root] directory the files are written to
 * @returns {Promise<string>} the directory holding the downloaded datasets
 */
export async function downloadSources(root) {
  const target = root ?? (await mkdtemp(join(tmpdir(), 'network-rail-gis-')));
  for (const file of SOURCE_FILES) {
    const path = join(target, file);
    mkdirSync(dirname(path), { recursive: true });
    const response = await fetch(new URL(file, SOURCE_BASE_URL));
    if (!response.ok) throw new Error(`could not download ${file}: HTTP ${response.status}`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
  return target;
}

/**
 * Read the waymarks: one point per waymark, carrying the ELR it belongs to and
 * its mileage. They are the mileage reference of the model.
 *
 * @param {string} root checkout of the network-rail-gis repository
 * @returns {Map<string, Array<[number, number, number]>>} ELR -> [mileage, lat, lon]
 */
export function readWaymarks(root) {
  const base = join(root, 'network-model', 'VectorWaymarks', 'NetworkWaymarks');
  const rows = readDbf(`${base}.dbf`);
  const shapes = readShp(`${base}.shp`);
  const out = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const shape = shapes[i];
    if (!row || !shape || shape.points.length === 0) continue;
    const elr = (row.ELR ?? '').trim();
    // The dBASE header truncates the field name to ten characters.
    const mileage = Number(row.WAYMARK_VA ?? row.WAYMARK_VALUE);
    if (!elr || !Number.isFinite(mileage)) continue;
    const [easting, northing] = shape.points[0];
    const { lat, lon } = osgb36ToWgs84(easting, northing);
    const list = out.get(elr) ?? [];
    list.push([round(mileage, 4), round(lat, 6), round(lon, 6)]);
    out.set(elr, list);
  }
  for (const list of out.values()) list.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * Read the track IDs of the links: which TRID exists on which ELR, and over
 * which mileage range. A mileage identifies a position along the ELR, not a
 * track, so the application offers the list to the operator instead of guessing
 * which of the parallel tracks the run was made on.
 *
 * @param {string} root checkout of the network-rail-gis repository
 * @returns {Map<string, Array<[string, number, number]>>} ELR -> [trid, from, to]
 */
export function readTracks(root) {
  const base = join(root, 'network-model', 'VectorLinks', 'NetworkLinks');
  const rows = readDbf(`${base}.dbf`);
  const out = new Map();
  for (const row of rows) {
    if (!row) continue;
    const elr = (row.ELR ?? '').trim();
    const trid = (row.TRID ?? '').trim();
    const from = Number(row.L_M_FROM);
    const to = Number(row.L_M_TO);
    if (!elr || !trid || !Number.isFinite(from) || !Number.isFinite(to)) continue;
    const list = out.get(elr) ?? [];
    list.push([trid, round(Math.min(from, to), 4), round(Math.max(from, to), 4)]);
    out.set(elr, list);
  }
  for (const [elr, list] of out) out.set(elr, mergeTracks(list));
  return out;
}

/**
 * Merge the consecutive links of a track into a single mileage range, so that
 * the reference file stays small.
 *
 * @param {Array<[string, number, number]>} links
 * @returns {Array<[string, number, number]>}
 */
export function mergeTracks(links) {
  const byTrid = new Map();
  for (const [trid, from, to] of links) {
    const list = byTrid.get(trid) ?? [];
    list.push([from, to]);
    byTrid.set(trid, list);
  }
  const out = [];
  for (const [trid, ranges] of byTrid) {
    ranges.sort((a, b) => a[0] - b[0]);
    let current = null;
    for (const [from, to] of ranges) {
      // The mileages are in miles and yards; a tenth of a mile of tolerance
      // bridges the gaps between two links of the same track.
      if (current && from <= current[2] + 0.02) {
        current[2] = Math.max(current[2], to);
        continue;
      }
      current = [trid, from, to];
      out.push(current);
    }
  }
  return out.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
}

/**
 * Build the reference file from a checkout of the network-rail-gis repository.
 *
 * @param {string} root
 * @returns {Object} content of the reference file
 */
export function buildNetworkModel(root) {
  const waymarks = readWaymarks(root);
  const tracks = readTracks(root);
  const elrs = {};
  for (const elr of new Set([...waymarks.keys(), ...tracks.keys()])) {
    elrs[elr] = {
      waymarks: waymarks.get(elr) ?? [],
      tracks: tracks.get(elr) ?? [],
    };
  }
  return {
    attribution: ATTRIBUTION,
    generatedAt: new Date().toISOString(),
    elrs,
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Command line entry point; the functions above stay importable for testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const local = args[0] && !args[0].endsWith('.json') ? args.shift() : null;
  const output = args[0] ?? join('data', 'network-model.json');
  if (local && !existsSync(join(local, 'network-model'))) {
    process.stderr.write(`${local} does not contain a network-model directory\n`);
    process.exitCode = 1;
  } else {
    if (!local) {
      process.stdout.write(`Downloading the network model from ${SOURCE_BASE_URL}…\n`);
    }
    const root = local ?? (await downloadSources());
    const model = buildNetworkModel(root);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(model));
    const elrs = Object.keys(model.elrs).length;
    const waymarks = Object.values(model.elrs).reduce((n, e) => n + e.waymarks.length, 0);
    process.stdout.write(`${output}: ${elrs} ELRs, ${waymarks} waymarks\n`);
  }
}
