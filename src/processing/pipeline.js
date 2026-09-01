import {
  bandpass,
  interpolateAt,
  percentile,
  resample,
  rms,
  uniformGrid,
} from './signal.js';
import {
  cumulativeDistance,
  estimateSpeed,
  toKilometricPoint,
} from './localisation.js';
import { detectThresholds, DEFAULT_THRESHOLDS } from './thresholds.js';

/**
 * Post-processing pipeline for a recorded run, implementing the six steps of
 * the data correction process of the report (§3.1, Figure 3):
 *
 *   1. synchronise the acceleration and location data
 *   2. interpolate the missing location points
 *   3. resample to an exact frequency
 *   4. filter the data
 *   5. convert to the space domain (0.25 m)
 *   6. detect the exceeded thresholds
 *
 * Only raw data is stored while recording (report §2.2), so all of this runs
 * afterwards, either in the browser or in a batch tool.
 */

/** Default processing options, aligned with the report. */
export const DEFAULT_OPTIONS = {
  /** Exact frequency the time-domain data is resampled to, in Hz. */
  resampleHz: 100,
  /** Lower cut-off of the band-pass filter, in Hz (0 disables it). */
  filterLowHz: 0.4,
  /** Upper cut-off of the band-pass filter, in Hz (0 disables it). */
  filterHighHz: 10,
  /** Butterworth filter order. */
  filterOrder: 4,
  /** Spatial sampling step, in metres (0.25 m as used by measurement trains). */
  spatialStepM: 0.25,
  /** Longest GNSS gap that is simply interpolated, in seconds. */
  maxGnssGapS: 3,
  /** Kilometric point at the start of the run, in km. */
  initialKpKm: 0,
  /** +1 when the kilometric point increases along the run, -1 otherwise. */
  kpDirection: 1,
  /** Threshold levels used by the detection step. */
  thresholds: DEFAULT_THRESHOLDS,
};

/**
 * @typedef {Object} AccelerationSample
 * @property {number} t timestamp in seconds since the start of the run
 * @property {number} vertical vertical acceleration (AVC) in m/s²
 * @property {number} lateral lateral acceleration (ATC) in m/s²
 * @property {number} longitudinal longitudinal acceleration (ALC) in m/s²
 */

/**
 * Run the complete pipeline on a raw recording.
 *
 * @param {{acceleration: AccelerationSample[], gnss: import('./localisation.js').GnssSample[], meta?: Object}} run
 * @param {Partial<typeof DEFAULT_OPTIONS>} [userOptions]
 * @returns {Object} processed run: time domain, space domain, events and statistics
 */
export function processRun(run, userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  const acceleration = [...(run.acceleration ?? [])].sort((a, b) => a.t - b.t);
  const gnss = [...(run.gnss ?? [])].sort((a, b) => a.t - b.t);
  if (acceleration.length < 2) {
    throw new Error('at least two acceleration samples are required');
  }

  // Steps 1 & 2 - synchronise the two data sources on the acceleration
  // timestamps and interpolate the missing location points.
  const rawTimes = acceleration.map((s) => s.t);
  const gnssTimes = gnss.map((s) => s.t);
  const located = {
    lat: interpolateAt(gnssTimes, gnss.map((s) => s.lat), rawTimes),
    lon: interpolateAt(gnssTimes, gnss.map((s) => s.lon), rawTimes),
    altitude: interpolateAt(
      gnssTimes,
      gnss.map((s) => (typeof s.altitude === 'number' ? s.altitude : null)),
      rawTimes,
    ),
  };

  // Step 3 - resample onto an exact frequency: smartphone timestamps drift.
  const dt = 1 / options.resampleHz;
  const resampled = resample(
    rawTimes,
    {
      vertical: acceleration.map((s) => s.vertical),
      lateral: acceleration.map((s) => s.lateral),
      longitudinal: acceleration.map((s) => s.longitudinal),
      lat: located.lat,
      lon: located.lon,
      altitude: located.altitude,
    },
    dt,
  );
  const times = resampled.x;

  // Step 4 - filtering. Filtering the raw signal is what makes the carbody
  // accelerations comparable between runs and devices (report §3.2).
  const filtered = {};
  for (const channel of ['vertical', 'lateral', 'longitudinal']) {
    filtered[channel] = bandpass(
      resampled.channels[channel],
      options.resampleHz,
      options.filterLowHz,
      options.filterHighHz,
      options.filterOrder,
    );
  }

  // Localisation: speed and travelled distance, with inertial gap filling.
  const { speed, source } = estimateSpeed(times, filtered.longitudinal, gnss, {
    maxGapS: options.maxGnssGapS,
  });
  const distance = cumulativeDistance(times, speed);
  const kp = toKilometricPoint(distance, options.initialKpKm, options.kpDirection);

  const timeDomain = {
    time: times,
    ...filtered,
    speed,
    speedSource: source,
    distance,
    kp,
    lat: resampled.channels.lat,
    lon: resampled.channels.lon,
    altitude: resampled.channels.altitude,
  };

  // Step 5 - conversion to the space domain at a fixed spatial step.
  const spaceDomain = toSpaceDomain(timeDomain, options.spatialStepM);

  // Step 6 - threshold detection.
  const events = detectThresholds(spaceDomain, { levels: options.thresholds });

  return {
    meta: { ...(run.meta ?? {}), options },
    timeDomain,
    spaceDomain,
    events,
    statistics: computeStatistics(timeDomain),
  };
}

/**
 * Resample the filtered time-domain data onto a fixed spatial step so that the
 * result can be compared with the data produced by measurement trains
 * (report §3.1).
 *
 * @param {Object} timeDomain output of the time-domain steps
 * @param {number} stepM spatial step in metres
 * @returns {{distance:number[], channels:Object<string,number[]>, kp:number[], lat:Array<number|null>, lon:Array<number|null>, step:number}}
 */
export function toSpaceDomain(timeDomain, stepM) {
  const { distance } = timeDomain;
  const total = distance[distance.length - 1];
  if (!(total > stepM)) {
    // The run is shorter than one spatial sample: nothing to convert.
    return {
      distance: [0],
      channels: { vertical: [0], lateral: [0], longitudinal: [0] },
      kp: [timeDomain.kp[0]],
      lat: [timeDomain.lat[0]],
      lon: [timeDomain.lon[0]],
      step: stepM,
    };
  }
  const grid = uniformGrid(0, total, stepM);
  const channels = {};
  for (const channel of ['vertical', 'lateral', 'longitudinal']) {
    channels[channel] = interpolateAt(distance, timeDomain[channel], grid);
  }
  return {
    distance: grid,
    channels,
    kp: interpolateAt(distance, timeDomain.kp, grid),
    lat: interpolateAt(distance, timeDomain.lat, grid),
    lon: interpolateAt(distance, timeDomain.lon, grid),
    speed: interpolateAt(distance, timeDomain.speed, grid),
    step: stepM,
  };
}

/**
 * Statistical indicators used to compare devices and positions in the report
 * (RMS, C95 and peak values, chapters 5 and 6).
 *
 * @param {Object} timeDomain
 * @returns {Object<string, {rms:number, c95:number, max:number, min:number}>}
 */
export function computeStatistics(timeDomain) {
  const stats = {};
  for (const channel of ['vertical', 'lateral', 'longitudinal']) {
    const values = timeDomain[channel];
    stats[channel] = {
      rms: rms(values),
      c95: percentile(values.map(Math.abs), 95),
      max: Math.max(...values),
      min: Math.min(...values),
    };
  }
  const speeds = timeDomain.speed;
  stats.speed = {
    meanKmh: (speeds.reduce((a, b) => a + b, 0) / speeds.length) * 3.6,
    maxKmh: Math.max(...speeds) * 3.6,
  };
  stats.distanceM = timeDomain.distance[timeDomain.distance.length - 1];
  stats.durationS = timeDomain.time[timeDomain.time.length - 1] - timeDomain.time[0];
  return stats;
}
