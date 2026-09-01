/**
 * Threshold detection (last step of the data correction process, report §3.1).
 *
 * The report explains that SNCF Réseau uses internal standards for the limit
 * values; those are not public, so the limits below are exposed as a plain
 * configuration object that each infrastructure manager can replace with its
 * own rules. The default values are the EN 14363 carbody acceleration limits
 * for the running behaviour assessment, which are a reasonable public baseline.
 */

/**
 * @typedef {Object} ThresholdLevel
 * @property {string} name level name reported to the maintenance team
 * @property {number} vertical limit on the vertical acceleration in m/s²
 * @property {number} lateral limit on the lateral acceleration in m/s²
 */

/** @type {ThresholdLevel[]} */
export const DEFAULT_THRESHOLDS = [
  { name: 'monitoring', vertical: 2.0, lateral: 1.5 },
  { name: 'intervention', vertical: 2.5, lateral: 2.0 },
  { name: 'immediate action', vertical: 3.0, lateral: 2.5 },
];

/**
 * @typedef {Object} ThresholdEvent
 * @property {string} channel channel name ('vertical' | 'lateral' | ...)
 * @property {string} level name of the highest exceeded level
 * @property {number} value signed peak value in m/s²
 * @property {number} limit limit that was exceeded
 * @property {number} distance curvilinear distance of the peak in metres
 * @property {number|null} kp kilometric point of the peak
 * @property {number|null} lat latitude of the peak
 * @property {number|null} lon longitude of the peak
 * @property {number} lengthM length of the exceedance in metres
 */

/**
 * Detect the sections where a channel exceeds a limit and report one event per
 * contiguous exceedance, keyed on its peak value.
 *
 * @param {Object} spaceDomain result of `toSpaceDomain`
 * @param {number[]} spaceDomain.distance distance grid in metres
 * @param {Object<string, number[]>} spaceDomain.channels filtered channels
 * @param {Array<number|null>} [spaceDomain.kp] kilometric point per sample
 * @param {Array<number|null>} [spaceDomain.lat]
 * @param {Array<number|null>} [spaceDomain.lon]
 * @param {Object} [options]
 * @param {ThresholdLevel[]} [options.levels] threshold levels, ascending
 * @param {Object<string,string>} [options.channelLimits] maps a channel name to
 *        the threshold property to use ('vertical' or 'lateral')
 * @returns {ThresholdEvent[]}
 */
export function detectThresholds(spaceDomain, options = {}) {
  const levels = options.levels ?? DEFAULT_THRESHOLDS;
  const channelLimits = options.channelLimits ?? {
    vertical: 'vertical',
    lateral: 'lateral',
  };
  const events = [];
  const { distance, channels } = spaceDomain;

  for (const [channel, limitKey] of Object.entries(channelLimits)) {
    const values = channels[channel];
    if (!values) continue;
    const lowest = Math.min(...levels.map((l) => l[limitKey]));
    let open = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const magnitude = Math.abs(v);
      if (magnitude > lowest) {
        if (!open) open = { start: i, peakIndex: i, peak: v };
        else if (magnitude > Math.abs(open.peak)) {
          open.peak = v;
          open.peakIndex = i;
        }
      } else if (open) {
        events.push(buildEvent(open, i - 1, channel, limitKey, levels, spaceDomain));
        open = null;
      }
    }
    if (open) {
      events.push(
        buildEvent(open, values.length - 1, channel, limitKey, levels, spaceDomain),
      );
    }
  }
  events.sort((a, b) => a.distance - b.distance);
  return events;
}

function buildEvent(open, endIndex, channel, limitKey, levels, spaceDomain) {
  const magnitude = Math.abs(open.peak);
  let level = levels[0];
  for (const candidate of levels) {
    if (magnitude > candidate[limitKey]) level = candidate;
  }
  const i = open.peakIndex;
  const { distance } = spaceDomain;
  const step = distance.length > 1 ? distance[1] - distance[0] : 0;
  return {
    channel,
    level: level.name,
    value: open.peak,
    limit: level[limitKey],
    distance: distance[i],
    kp: spaceDomain.kp ? spaceDomain.kp[i] : null,
    lat: spaceDomain.lat ? spaceDomain.lat[i] : null,
    lon: spaceDomain.lon ? spaceDomain.lon[i] : null,
    lengthM: (endIndex - open.start + 1) * step,
  };
}
