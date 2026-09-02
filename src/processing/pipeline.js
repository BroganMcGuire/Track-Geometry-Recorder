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
  metresToMiles,
  toMileage,
} from './localisation.js';
import { mileageDistanceM } from './mileage.js';
import { DEFAULT_MAX_DISTANCE_M, mileageFromAnchor } from './network-model.js';
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
  /** Mileage at the start of the run, in miles. */
  initialMileageMi: 0,
  /** +1 when the mileage increases along the run, -1 otherwise. */
  mileageDirection: 1,
  /** ELR of the run, when it was entered on the start screen. */
  elr: null,
  /** Track ID (TRID) of the run, when it was entered on the start screen. */
  track: null,
  /**
   * Network model (`src/processing/network-model.js`) built from the Network
   * Rail network model. When it is provided, the ELR, the track IDs and the
   * mileage are read from the GNSS fixes instead of the values entered on the
   * start screen.
   */
  network: null,
  /** Farthest a fix may be from a line to be located on it, in metres. */
  maxNetworkDistanceM: DEFAULT_MAX_DISTANCE_M,
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
  // The network model itself is a large object; only the settings are reported.
  const { network: _network, ...reportedOptions } = options;
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
  const location = locateRun(times, distance, gnss, options);
  const mileage = location.mileage;

  const timeDomain = {
    time: times,
    ...filtered,
    speed,
    speedSource: source,
    distance,
    mileage,
    lat: resampled.channels.lat,
    lon: resampled.channels.lon,
    altitude: resampled.channels.altitude,
  };

  // Step 5 - conversion to the space domain at a fixed spatial step.
  const spaceDomain = toSpaceDomain(timeDomain, options.spatialStepM);

  // Step 6 - threshold detection. Each exceedance is reported with the ELR, the
  // track and the mileage the maintenance team works with.
  const events = detectThresholds(spaceDomain, { levels: options.thresholds }).map((event) => ({
    ...event,
    elr: location.elr,
    track: location.track,
  }));

  return {
    meta: { ...(run.meta ?? {}), options: reportedOptions },
    location: {
      elr: location.elr,
      track: location.track,
      tracks: location.tracks,
      source: location.source,
      initialMileageMi: mileage[0],
      mileageDirection: location.mileageDirection,
      residualM: location.residualM,
      anchor: location.anchor,
    },
    timeDomain,
    spaceDomain,
    events,
    statistics: computeStatistics(timeDomain),
  };
}

/**
 * Turn the curvilinear distance into a mileage, and name the line the run was
 * recorded on.
 *
 * When a network model is available, the GNSS fixes are located on it: the ELR,
 * the mileage of the first located fix and the direction of the mileage are
 * read from the Network Rail data instead of being typed by the operator, and
 * the mileage of every sample is obtained by carrying the integrated distance
 * from that anchor. Without a model — or for a run recorded outside its
 * coverage — the initial mileage and direction of the start screen are used.
 *
 * @param {number[]} times timestamps in seconds
 * @param {number[]} distance curvilinear distance in metres
 * @param {import('./localisation.js').GnssSample[]} gnss GNSS fixes
 * @param {typeof DEFAULT_OPTIONS} options
 * @returns {{mileage:number[], elr:string|null, track:string|null, tracks:string[], source:string, mileageDirection:number, residualM:number|null, anchor:Object|null}}
 */
function locateRun(times, distance, gnss, options) {
  const anchor = options.network
    ? options.network.anchor(gnss, { maxDistanceM: options.maxNetworkDistanceM })
    : null;

  if (anchor) {
    // The direction is only read from the model when the run actually moved.
    const mileageDirection = anchor.mileageDirection ?? options.mileageDirection;
    const anchorDistance = interpolateAt(times, distance, [anchor.t])[0] ?? 0;
    const mileage = distance.map((d) =>
      mileageFromAnchor(anchor.mileage, d - anchorDistance, mileageDirection),
    );
    // The track entered on the start screen wins, as long as the model knows it
    // at that mileage; the guess is only made when a single track matches.
    const known = options.track && anchor.tracks.includes(options.track);
    return {
      mileage,
      elr: anchor.elr,
      track: known ? options.track : anchor.tracks.length === 1 ? anchor.tracks[0] : null,
      tracks: anchor.tracks,
      source: 'network-model',
      mileageDirection,
      residualM: anchorResidualM(times, mileage, anchor),
      anchor,
    };
  }

  return {
    mileage: toMileage(distance, options.initialMileageMi, options.mileageDirection),
    elr: options.elr ?? null,
    track: options.track ?? null,
    tracks: [],
    source: 'journey-information',
    mileageDirection: options.mileageDirection,
    residualM: null,
    anchor: null,
  };
}

/**
 * How far the anchored mileage drifts from the mileages the model gives for the
 * located fixes, in metres.
 *
 * The mileage of the run is carried from a single anchor, which assumes that
 * the whole recording stays on one ELR and runs in one direction. A run that
 * crosses onto another ELR, or that reverses, drifts away from the model; the
 * residual is reported so that such a run can be spotted and split.
 *
 * @param {number[]} times timestamps in seconds
 * @param {number[]} mileage anchored mileage per sample
 * @param {Object} anchor result of `NetworkModel.anchor`
 * @returns {number|null} largest deviation in metres, null without located fixes
 */
function anchorResidualM(times, mileage, anchor) {
  const points = anchor.points ?? [];
  if (points.length === 0) return null;
  const expected = interpolateAt(times, mileage, points.map((p) => p.t));
  let worst = 0;
  for (let i = 0; i < points.length; i++) {
    if (expected[i] === null) continue;
    worst = Math.max(worst, Math.abs(mileageDistanceM(points[i].mileage, expected[i])));
  }
  return worst;
}

/**
 * Resample the filtered time-domain data onto a fixed spatial step so that the
 * result can be compared with the data produced by measurement trains
 * (report §3.1).
 *
 * @param {Object} timeDomain output of the time-domain steps
 * @param {number} stepM spatial step in metres
 * @returns {{distance:number[], channels:Object<string,number[]>, mileage:number[], lat:Array<number|null>, lon:Array<number|null>, step:number}}
 */
export function toSpaceDomain(timeDomain, stepM) {
  const { distance } = timeDomain;
  const total = distance[distance.length - 1];
  if (!(total > stepM)) {
    // The run is shorter than one spatial sample: nothing to convert.
    return {
      distance: [0],
      channels: { vertical: [0], lateral: [0], longitudinal: [0] },
      mileage: [timeDomain.mileage[0]],
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
    mileage: interpolateAt(distance, timeDomain.mileage, grid),
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
  const metresPerSecondToMph = 3600 / 1609.344;
  stats.speed = {
    meanMph: (speeds.reduce((a, b) => a + b, 0) / speeds.length) * metresPerSecondToMph,
    maxMph: Math.max(...speeds) * metresPerSecondToMph,
  };
  stats.distanceM = timeDomain.distance[timeDomain.distance.length - 1];
  stats.distanceMi = metresToMiles(stats.distanceM);
  stats.durationS = timeDomain.time[timeDomain.time.length - 1] - timeDomain.time[0];
  return stats;
}
