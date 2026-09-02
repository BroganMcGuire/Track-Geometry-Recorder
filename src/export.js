/**
 * Export of the raw and processed data.
 *
 * The recording produces two datasheets — one for the accelerometer and one for
 * the GNSS receiver — exactly as described in the report (§3.1); they are
 * synchronised afterwards through their timestamps. The CSV builders are pure
 * functions so that they can be reused and tested outside of the browser.
 */

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Build a CSV document from a list of rows.
 * @param {string[]} header
 * @param {Array<Array<*>>} rows
 * @returns {string}
 */
export function toCsv(header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return lines.join('\n') + '\n';
}

function round(value, digits = 6) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '';
  return Number(value.toFixed(digits));
}

/**
 * Raw acceleration datasheet.
 * @param {Object} run
 * @returns {string}
 */
export function accelerationCsv(run) {
  return toCsv(
    ['t_s', 'avc_ms2', 'atc_ms2', 'alc_ms2', 'raw_x', 'raw_y', 'raw_z'],
    run.acceleration.map((s) => [
      round(s.t, 4),
      round(s.vertical),
      round(s.lateral),
      round(s.longitudinal),
      round(s.x),
      round(s.y),
      round(s.z),
    ]),
  );
}

/**
 * Raw location datasheet.
 * @param {Object} run
 * @returns {string}
 */
export function gnssCsv(run) {
  return toCsv(
    ['t_s', 'latitude', 'longitude', 'altitude_m', 'speed_ms', 'heading_deg', 'accuracy_m'],
    run.gnss.map((s) => [
      round(s.t, 4),
      round(s.lat, 8),
      round(s.lon, 8),
      round(s.altitude, 2),
      round(s.speed, 3),
      round(s.heading, 2),
      round(s.accuracy, 2),
    ]),
  );
}

/**
 * Markers registered during the run (switch, bridge, tunnel, ...).
 * @param {Object} run
 * @returns {string}
 */
export function markersCsv(run) {
  return toCsv(
    ['t_s', 'type', 'latitude', 'longitude'],
    (run.markers ?? []).map((m) => [round(m.t, 3), m.type, round(m.lat, 8), round(m.lon, 8)]),
  );
}

/**
 * Processed data in the space domain, at the fixed spatial step.
 * @param {Object} processed output of `processRun`
 * @returns {string}
 */
export function spaceDomainCsv(processed) {
  const { distance, channels, mileage, lat, lon } = processed.spaceDomain;
  const rows = distance.map((d, i) => [
    round(d, 3),
    round(mileage?.[i], 6),
    round(channels.vertical[i]),
    round(channels.lateral[i]),
    round(channels.longitudinal[i]),
    round(lat?.[i], 8),
    round(lon?.[i], 8),
  ]);
  return toCsv(
    ['distance_m', 'mileage_mi', 'avc_ms2', 'atc_ms2', 'alc_ms2', 'latitude', 'longitude'],
    rows,
  );
}

/**
 * List of exceeded thresholds, i.e. the deliverable for the maintenance team.
 * @param {Object} processed output of `processRun`
 * @returns {string}
 */
export function eventsCsv(processed) {
  return toCsv(
    ['channel', 'level', 'value_ms2', 'limit_ms2', 'mileage_mi', 'distance_m', 'length_m', 'latitude', 'longitude'],
    processed.events.map((e) => [
      e.channel,
      e.level,
      round(e.value, 3),
      round(e.limit, 3),
      round(e.mileage, 6),
      round(e.distance, 2),
      round(e.lengthM, 2),
      round(e.lat, 8),
      round(e.lon, 8),
    ]),
  );
}

/**
 * Trigger a file download in the browser.
 * @param {string} filename
 * @param {string} content
 * @param {string} [mime]
 */
export function download(filename, content, mime = 'text/csv') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Build a file name prefix from the journey information.
 * @param {Object} summary
 * @returns {string}
 */
export function filePrefix(summary) {
  const date = (summary.startedAt ?? '').replace(/[:.]/g, '-');
  const elr = summary.elr ? `elr${summary.elr}` : 'run';
  const track = summary.track ? `-track${summary.track}` : '';
  return `${elr}${track}-${date}`;
}
