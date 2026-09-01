/**
 * Generic signal-processing helpers used by the post-processing pipeline.
 *
 * Everything here is dependency free so that the exact same code runs in the
 * browser (post-processing screen) and in Node (unit tests / batch tooling).
 */

/**
 * Linear interpolation of a series sampled at `xs` onto the positions `targets`.
 * Values outside the source range are clamped to the first/last known value,
 * which matches the behaviour expected when a GNSS fix is missing at the very
 * beginning or the very end of a run.
 *
 * @param {number[]} xs increasing source positions
 * @param {Array<number|null>} ys source values (same length as `xs`)
 * @param {number[]} targets positions to interpolate at
 * @returns {Array<number|null>} interpolated values
 */
export function interpolateAt(xs, ys, targets) {
  const cleanX = [];
  const cleanY = [];
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y === null || y === undefined || Number.isNaN(y)) continue;
    cleanX.push(xs[i]);
    cleanY.push(y);
  }
  if (cleanX.length === 0) return targets.map(() => null);
  if (cleanX.length === 1) return targets.map(() => cleanY[0]);

  const out = new Array(targets.length);
  let i = 0;
  for (let k = 0; k < targets.length; k++) {
    const t = targets[k];
    if (t <= cleanX[0]) {
      out[k] = cleanY[0];
      continue;
    }
    if (t >= cleanX[cleanX.length - 1]) {
      out[k] = cleanY[cleanY.length - 1];
      continue;
    }
    while (i < cleanX.length - 2 && cleanX[i + 1] < t) i++;
    while (i > 0 && cleanX[i] > t) i--;
    const x0 = cleanX[i];
    const x1 = cleanX[i + 1];
    const ratio = x1 === x0 ? 0 : (t - x0) / (x1 - x0);
    out[k] = cleanY[i] + ratio * (cleanY[i + 1] - cleanY[i]);
  }
  return out;
}

/**
 * Build a uniform grid of positions covering [start, end] with the given step.
 *
 * @param {number} start
 * @param {number} end
 * @param {number} step
 * @returns {number[]}
 */
export function uniformGrid(start, end, step) {
  if (!(step > 0)) throw new Error('step must be > 0');
  const grid = [];
  const count = Math.floor((end - start) / step + 1e-9);
  for (let i = 0; i <= count; i++) grid.push(start + i * step);
  return grid;
}

/**
 * Resample a set of channels onto a uniform grid.
 *
 * Smartphone sensors do not deliver samples at an exact frequency and their
 * timestamps drift over long runs (report §3.1), so a resampling step is
 * mandatory before any filter is applied.
 *
 * @param {number[]} xs source positions (time in seconds, or distance in metres)
 * @param {Object<string, Array<number|null>>} channels named channels to resample
 * @param {number} step target step (1/fs, or the spatial step)
 * @returns {{x: number[], channels: Object<string, Array<number|null>>}}
 */
export function resample(xs, channels, step) {
  if (xs.length === 0) return { x: [], channels: {} };
  const grid = uniformGrid(xs[0], xs[xs.length - 1], step);
  const out = {};
  for (const [name, values] of Object.entries(channels)) {
    out[name] = interpolateAt(xs, values, grid);
  }
  return { x: grid, channels: out };
}

/**
 * Second-order section (biquad) coefficients, normalised so that a0 === 1.
 * @typedef {{b0:number, b1:number, b2:number, a1:number, a2:number}} Biquad
 */

/**
 * Design the cascade of biquads implementing a Butterworth low-pass filter.
 *
 * @param {number} cutoffHz -3 dB cut-off frequency
 * @param {number} fs sampling frequency
 * @param {number} order filter order (rounded up to the next even number)
 * @returns {Biquad[]}
 */
export function designLowpass(cutoffHz, fs, order = 4) {
  return designButterworth(cutoffHz, fs, order, 'low');
}

/**
 * Design the cascade of biquads implementing a Butterworth high-pass filter.
 *
 * @param {number} cutoffHz -3 dB cut-off frequency
 * @param {number} fs sampling frequency
 * @param {number} order filter order (rounded up to the next even number)
 * @returns {Biquad[]}
 */
export function designHighpass(cutoffHz, fs, order = 4) {
  return designButterworth(cutoffHz, fs, order, 'high');
}

function designButterworth(cutoffHz, fs, order, type) {
  const nyquist = fs / 2;
  if (!(cutoffHz > 0) || cutoffHz >= nyquist) {
    throw new Error(`cut-off ${cutoffHz} Hz must be within (0, ${nyquist}) Hz`);
  }
  const sections = Math.max(1, Math.ceil(order / 2));
  const omega = (2 * Math.PI * cutoffHz) / fs;
  const cosW = Math.cos(omega);
  const sinW = Math.sin(omega);
  const biquads = [];
  for (let k = 0; k < sections; k++) {
    // Butterworth pole angles set the Q factor of each second-order section.
    const poleAngle = (Math.PI * (2 * k + 1)) / (4 * sections);
    const q = 1 / (2 * Math.sin(poleAngle));
    const alpha = sinW / (2 * q);
    const a0 = 1 + alpha;
    if (type === 'low') {
      biquads.push({
        b0: (1 - cosW) / 2 / a0,
        b1: (1 - cosW) / a0,
        b2: (1 - cosW) / 2 / a0,
        a1: (-2 * cosW) / a0,
        a2: (1 - alpha) / a0,
      });
    } else {
      biquads.push({
        b0: (1 + cosW) / 2 / a0,
        b1: -(1 + cosW) / a0,
        b2: (1 + cosW) / 2 / a0,
        a1: (-2 * cosW) / a0,
        a2: (1 - alpha) / a0,
      });
    }
  }
  return biquads;
}

function applyBiquads(input, biquads) {
  let signal = input;
  for (const s of biquads) {
    const out = new Array(signal.length);
    // Initialise the delay lines in the steady state matching the first sample,
    // otherwise a low cut-off high-pass rings for several seconds at the start
    // of every run.
    const x0Init = signal.length > 0 ? signal[0] : 0;
    const dcGain = (s.b0 + s.b1 + s.b2) / (1 + s.a1 + s.a2);
    let x1 = x0Init;
    let x2 = x0Init;
    let y1 = x0Init * dcGain;
    let y2 = y1;
    for (let i = 0; i < signal.length; i++) {
      const x0 = signal[i];
      const y0 = s.b0 * x0 + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    signal = out;
  }
  return signal;
}

/**
 * Zero-phase filtering (forward then backward pass). Preserving the position of
 * the peaks matters because maintenance teams locate defects from them
 * (report §4).
 *
 * @param {number[]} signal
 * @param {Biquad[]} biquads
 * @returns {number[]}
 */
export function filtfilt(signal, biquads) {
  if (signal.length === 0) return [];
  // Reflect-pad both ends to limit the start-up transient of the filter.
  const pad = Math.min(signal.length - 1, 6 * biquads.length + 10);
  const padded = [];
  for (let i = pad; i > 0; i--) padded.push(2 * signal[0] - signal[i]);
  for (const v of signal) padded.push(v);
  const n = signal.length;
  for (let i = 1; i <= pad; i++) padded.push(2 * signal[n - 1] - signal[n - 1 - i]);

  const forward = applyBiquads(padded, biquads);
  const backward = applyBiquads(forward.slice().reverse(), biquads).reverse();
  return backward.slice(pad, pad + n);
}

/**
 * Band-pass a signal with a zero-phase Butterworth filter.
 *
 * EN 14363 assesses carbody accelerations in a limited band; both cut-offs are
 * configurable so that other national rules can be applied (report §3.2).
 *
 * @param {number[]} signal
 * @param {number} fs sampling frequency
 * @param {number} lowHz lower cut-off, use 0 to disable the high-pass
 * @param {number} highHz upper cut-off, use 0/Infinity to disable the low-pass
 * @param {number} order
 * @returns {number[]}
 */
export function bandpass(signal, fs, lowHz, highHz, order = 4) {
  let out = signal;
  if (lowHz > 0) out = filtfilt(out, designHighpass(lowHz, fs, order));
  if (highHz > 0 && Number.isFinite(highHz)) {
    out = filtfilt(out, designLowpass(highHz, fs, order));
  }
  return out;
}

/**
 * Root mean square of a series.
 * @param {number[]} values
 * @returns {number}
 */
export function rms(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

/**
 * Percentile (linear interpolation between ranks) of a series, e.g. the C95
 * indicator used throughout the report.
 *
 * @param {number[]} values
 * @param {number} p percentile in [0, 100]
 * @returns {number}
 */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = ((sorted.length - 1) * p) / 100;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (rank - low) * (sorted[high] - sorted[low]);
}

const EARTH_RADIUS_M = 6371008.8;

/**
 * Great-circle distance between two WGS84 positions, in metres.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}
