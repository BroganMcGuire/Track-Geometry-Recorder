#!/usr/bin/env node
/**
 * Upload a run exported from the app (the `*-raw.json` file) to Supabase.
 *
 * Usage:
 *   SUPABASE_DB_URL='postgres://…' node tools/db-upload.js run-raw.json […]
 *
 * The raw datasheets are stored as JSON documents and the post-processing
 * pipeline is run once so that the exceeded thresholds are queryable by ELR,
 * track and mileage.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { summarise } from '../src/storage.js';
import { processRun } from '../src/processing/pipeline.js';
import { NetworkModel } from '../src/processing/network-model.js';
import { withClient } from './db.js';

/**
 * Load the network model reference file, when it has been built.
 *
 * @returns {Promise<NetworkModel|null>}
 */
export async function loadLocalNetworkModel() {
  const path = fileURLToPath(new URL('../data/network-model.json', import.meta.url));
  try {
    return new NetworkModel(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Build the `runs` row for a raw recording.
 *
 * @param {Object} run raw run as exported by the app
 * @param {string} [id] identifier to use; defaults to the start timestamp
 * @returns {Object}
 */
export function runRow(run, id) {
  const summary = summarise(run);
  const meta = run.meta ?? {};
  return {
    id: id ?? summary.startedAt,
    elr: meta.elr ?? '',
    track: meta.track ?? null,
    train_type: meta.trainType ?? null,
    position_in_train: meta.position ?? null,
    initial_mileage_mi: Number(meta.initialMileageMi) || 0,
    mileage_direction: Number(meta.mileageDirection) || 1,
    started_at: summary.startedAt,
    duration_s: summary.durationS,
    samples: summary.samples,
    fixes: summary.fixes,
    rate_hz: summary.rateHz,
    meta,
    acceleration: run.acceleration ?? [],
    gnss: run.gnss ?? [],
    markers: run.markers ?? [],
  };
}

/**
 * Insert (or replace) a run and its threshold events.
 *
 * @param {import('pg').Client} client
 * @param {Object} run raw run as exported by the app
 * @param {string} [id]
 * @param {import('../src/processing/network-model.js').NetworkModel} [network]
 * @returns {Promise<string>} the identifier of the stored run
 */
export async function uploadRun(client, run, id, network = null) {
  const row = runRow(run, id);
  await client.query('begin');
  try {
    await client.query(
      `insert into runs (id, elr, track, train_type, position_in_train,
                         initial_mileage_mi, mileage_direction, started_at,
                         duration_s, samples, fixes, rate_hz, meta,
                         acceleration, gnss, markers)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (id) do update set
         elr = excluded.elr,
         track = excluded.track,
         train_type = excluded.train_type,
         position_in_train = excluded.position_in_train,
         initial_mileage_mi = excluded.initial_mileage_mi,
         mileage_direction = excluded.mileage_direction,
         started_at = excluded.started_at,
         duration_s = excluded.duration_s,
         samples = excluded.samples,
         fixes = excluded.fixes,
         rate_hz = excluded.rate_hz,
         meta = excluded.meta,
         acceleration = excluded.acceleration,
         gnss = excluded.gnss,
         markers = excluded.markers`,
      [
        row.id,
        row.elr,
        row.track,
        row.train_type,
        row.position_in_train,
        row.initial_mileage_mi,
        row.mileage_direction,
        row.started_at,
        row.duration_s,
        row.samples,
        row.fixes,
        row.rate_hz,
        JSON.stringify(row.meta),
        JSON.stringify(row.acceleration),
        JSON.stringify(row.gnss),
        JSON.stringify(row.markers),
      ],
    );
    await client.query('delete from threshold_events where run_id = $1', [row.id]);
    for (const event of thresholdEvents(run, network)) {
      await client.query(
        `insert into threshold_events (run_id, elr, track, channel, level, value_ms2,
                                       limit_ms2, mileage_mi, distance_m, length_m,
                                       latitude, longitude)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          row.id,
          event.elr ?? row.elr ?? null,
          event.track ?? row.track ?? null,
          event.channel,
          event.level,
          event.value,
          event.limit,
          event.mileage,
          event.distance,
          event.lengthM,
          event.lat,
          event.lon,
        ],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  return row.id;
}

/**
 * Post-process a run to obtain its exceeded thresholds; a run that is too short
 * to be processed is uploaded without any event.
 *
 * @param {Object} run
 * @param {import('../src/processing/network-model.js').NetworkModel} [network]
 *        network model used to read the ELR, track and mileage from the fixes
 * @returns {Array<Object>}
 */
export function thresholdEvents(run, network = null) {
  const meta = run.meta ?? {};
  try {
    return processRun(run, {
      initialMileageMi: Number(meta.initialMileageMi) || 0,
      mileageDirection: Number(meta.mileageDirection) || 1,
      elr: meta.elr || null,
      track: meta.track || null,
      network: network ?? null,
    }).events;
  } catch {
    return [];
  }
}

// Command line entry point; the functions above stay importable for testing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write('Usage: node tools/db-upload.js <run-raw.json> […]\n');
    process.exitCode = 1;
  } else {
    const network = await loadLocalNetworkModel();
    await withClient(async (client) => {
      for (const file of files) {
        const run = JSON.parse(await readFile(file, 'utf8'));
        const id = await uploadRun(client, run, basename(file, '.json'), network);
        process.stdout.write(`Uploaded ${file} as ${id}\n`);
      }
    });
  }
}
