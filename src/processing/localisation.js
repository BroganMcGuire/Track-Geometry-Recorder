import { haversine } from './signal.js';

/**
 * Speed and distance estimation (report §4 "On-track localisation").
 *
 * GNSS reception inside a carbody is regularly lost in tunnels, dense urban
 * areas or simply because of the treatment of the train windows. The report
 * recommends complementing the GNSS speed with an estimate derived from the
 * accelerometric data; the implementation below fills the GNSS gaps by
 * integrating the longitudinal acceleration and re-anchoring the result on the
 * next valid fix so that no drift accumulates across a gap.
 */

/**
 * @typedef {Object} GnssSample
 * @property {number} t timestamp in seconds since the start of the run
 * @property {number} lat latitude in degrees
 * @property {number} lon longitude in degrees
 * @property {number|null} [speed] speed in m/s as reported by the receiver
 * @property {number|null} [accuracy] horizontal accuracy in metres
 */

/**
 * Derive a speed for every GNSS fix, using the receiver speed when available
 * and falling back to the distance between consecutive fixes.
 *
 * @param {GnssSample[]} samples GNSS fixes sorted by time
 * @returns {Array<{t:number, speed:number}>}
 */
export function gnssSpeedSeries(samples) {
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (typeof s.speed === 'number' && Number.isFinite(s.speed) && s.speed >= 0) {
      out.push({ t: s.t, speed: s.speed });
      continue;
    }
    const prev = samples[i - 1];
    if (prev) {
      const dt = s.t - prev.t;
      if (dt > 0) {
        out.push({ t: s.t, speed: haversine(prev.lat, prev.lon, s.lat, s.lon) / dt });
      }
    }
  }
  return out;
}

/**
 * Estimate the speed on the accelerometer time base.
 *
 * Inside a GNSS gap longer than `maxGapS`, the speed is obtained by integrating
 * the longitudinal acceleration from the last valid fix. When a fix is found on
 * the far side of the gap, the accumulated integration error is spread linearly
 * over the gap so that both ends match the measured speed.
 *
 * @param {number[]} times accelerometer timestamps in seconds (increasing)
 * @param {number[]} longitudinal longitudinal acceleration in m/s², gravity removed
 * @param {GnssSample[]} gnss GNSS fixes sorted by time
 * @param {{maxGapS?: number}} [options]
 * @returns {{speed: number[], source: string[]}} speed in m/s per accelerometer sample
 */
export function estimateSpeed(times, longitudinal, gnss, options = {}) {
  const maxGapS = options.maxGapS ?? 3;
  const fixes = gnssSpeedSeries(gnss);
  const speed = new Array(times.length).fill(0);
  const source = new Array(times.length).fill('gnss');

  if (fixes.length === 0) {
    // No usable GNSS at all: integrate the longitudinal acceleration only. The
    // result is a relative speed profile and must be treated with caution.
    let v = 0;
    for (let i = 0; i < times.length; i++) {
      if (i > 0) v = Math.max(0, v + longitudinal[i] * (times[i] - times[i - 1]));
      speed[i] = v;
      source[i] = 'inertial';
    }
    return { speed, source };
  }

  let fixIndex = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    while (fixIndex < fixes.length - 1 && fixes[fixIndex + 1].t <= t) fixIndex++;
    const before = fixes[fixIndex];
    const after = fixes[fixIndex + 1];

    if (!after || t <= before.t) {
      speed[i] = before.speed;
      source[i] = 'gnss';
      continue;
    }
    const gap = after.t - before.t;
    if (gap <= maxGapS) {
      const ratio = (t - before.t) / gap;
      speed[i] = before.speed + ratio * (after.speed - before.speed);
      source[i] = 'gnss';
      continue;
    }
    // Long GNSS outage: integrate the longitudinal acceleration and correct the
    // drift linearly so that the estimate matches both surrounding fixes.
    const integrated = integrateSegment(times, longitudinal, i, before, after);
    speed[i] = Math.max(0, integrated);
    source[i] = 'inertial';
  }
  return { speed, source };
}

function integrateSegment(times, longitudinal, index, before, after) {
  // Integrate from the last sample at or before `before.t` up to `index`.
  let start = index;
  while (start > 0 && times[start - 1] >= before.t) start--;
  let v = before.speed;
  for (let k = start; k <= index; k++) {
    const dt = k === 0 ? 0 : times[k] - times[k - 1];
    v += longitudinal[k] * dt;
  }
  // Estimate the total integrated speed change over the whole gap to spread the
  // drift error proportionally to the elapsed time.
  let vEnd = before.speed;
  for (let k = start; k < times.length && times[k] <= after.t; k++) {
    const dt = k === 0 ? 0 : times[k] - times[k - 1];
    vEnd += longitudinal[k] * dt;
  }
  const drift = vEnd - after.speed;
  const ratio = (times[index] - before.t) / (after.t - before.t);
  return v - drift * ratio;
}

/**
 * Cumulative curvilinear distance obtained by integrating the speed.
 *
 * @param {number[]} times timestamps in seconds
 * @param {number[]} speed speed in m/s (same length as `times`)
 * @returns {number[]} distance in metres from the first sample
 */
export function cumulativeDistance(times, speed) {
  const out = new Array(times.length).fill(0);
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    // Trapezoidal integration of the speed.
    out[i] = out[i - 1] + ((speed[i] + speed[i - 1]) / 2) * dt;
  }
  return out;
}

/** Length of a statute mile in metres. */
export const METRES_PER_MILE = 1609.344;

/**
 * Convert a distance in metres into miles.
 *
 * @param {number} metres
 * @returns {number} distance in miles
 */
export function metresToMiles(metres) {
  return metres / METRES_PER_MILE;
}

/**
 * Convert a curvilinear distance into a mileage along the ELR.
 *
 * @param {number[]} distanceM distance travelled in metres
 * @param {number} initialMileageMi mileage at the start of the run, in miles
 * @param {number} direction +1 when the mileage increases along the run, -1 otherwise
 * @returns {number[]} mileages in miles
 */
export function toMileage(distanceM, initialMileageMi, direction = 1) {
  const sign = direction < 0 ? -1 : 1;
  return distanceM.map((d) => initialMileageMi + (sign * metresToMiles(d)));
}
