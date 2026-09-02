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
 * @param {Object} [location] `location` block of the processed run, so that the
 *        run and its events are stored with the same ELR, track and mileage
 * @returns {Object}
 */
export function runRow(run, id, location = null) {
  const summary = summarise(run);
  const meta = run.meta ?? {};
  const fromNetwork = location?.source === 'network-model' ? location : null;
  return {
    id: id ?? summary.startedAt,
    elr: fromNetwork?.elr ?? meta.elr ?? '',
    track: fromNetwork?.track ?? meta.track ?? null,
    train_type: meta.trainType ?? null,
    position_in_train: meta.position ?? null,
    initial_mileage_mi: fromNetwork
      ? fromNetwork.initialMileageMi
      : Number(meta.initialMileageMi) || 0,
    mileage_direction: fromNetwork?.mileageDirection ?? (Number(meta.mileageDirection) || 1),
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
  // The run is post-processed once, so that the journey information stored with
  // it and the events cannot contradict each other.
  const processed = processForUpload(run, network);
  const row = runRow(run, id, processed.location);
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
    for (const event of processed.events) {
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
 * Post-process a run; a run that is too short to be processed is uploaded
 * without any event and keeps the journey information it was recorded with.
 *
 * @param {Object} run
 * @param {import('../src/processing/network-model.js').NetworkModel} [network]
 *        network model used to read the ELR, track and mileage from the fixes
 * @returns {{events: Array<Object>, location: Object|null}}
 */
export function processForUpload(run, network = null) {
  const meta = run.meta ?? {};
  try {
    const processed = processRun(run, {
      initialMileageMi: Number(meta.initialMileageMi) || 0,
      mileageDirection: Number(meta.mileageDirection) || 1,
      elr: meta.elr || null,
      track: meta.track || null,
      network: network ?? null,
    });
    return { events: processed.events, location: processed.location ?? null };
  } catch {
    return { events: [], location: null };
  }
}

/**
 * Exceeded thresholds of a run.
 *
 * @param {Object} run
 * @param {import('../src/processing/network-model.js').NetworkModel} [network]
 * @returns {Array<Object>}
 */
export function thresholdEvents(run, network = null) {
  return processForUpload(run, network).events;
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
