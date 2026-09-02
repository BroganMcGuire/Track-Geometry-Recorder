/**
 * Network Rail network model: ELR, track ID (TRID) and mileage.
 *
 * The reference data comes from the Infrastructure Network Model extracts that
 * Network Rail published under the Open Government Licence v3.0 and that are
 * mirrored in https://github.com/openraildata/network-rail-gis:
 *
 * - *VectorWaymarks* (`NetworkWaymarks.shp`) — one point per waymark, with the
 *   `ELR` it belongs to and its `WAYMARK_VALUE` mileage. The waymarks are the
 *   quarter-mile posts of the network, so they give a dense mileage reference
 *   along every ELR.
 * - *VectorLinks* (`NetworkLinks.shp` / `AttributionTable.csv`) — the track
 *   centre lines, categorised by `ELR` and `TRID` with the mileage range
 *   (`L_M_FROM`, `L_M_TO`) that each track covers.
 *
 * `tools/build-network-model.js` turns those shapefiles into the compact JSON
 * file loaded here (the shapefiles themselves are far too large to ship with
 * the application, and they are British National Grid, not WGS84).
 *
 * The model answers the two questions the maintenance team asks of a run: on
 * which ELR and track was it recorded, and at which mileage is a defect.
 * Mileages are handled in decimal miles internally and converted to the
 * miles-and-yards notation of the network model for display (see mileage.js).
 */

import { milesAndYardsToMiles, METRES_PER_MILE } from './mileage.js';

/** Size of a cell of the lookup grid, in degrees of latitude (about 1.1 km). */
const CELL_DEGREES = 0.01;

/** Default distance beyond which a fix is not considered to be on a line. */
export const DEFAULT_MAX_DISTANCE_M = 250;

/** Location of the reference file built by `tools/build-network-model.js`. */
export const DEFAULT_MODEL_URL = 'data/network-model.json';

/**
 * @typedef {Object} NetworkLocation
 * @property {string} elr Engineer's Line Reference, e.g. `ECM1`
 * @property {number} mileage mileage in decimal miles
 * @property {number} distanceM distance from the point to the ELR, in metres
 * @property {string[]} tracks track IDs (TRID) covering that mileage
 */

export class NetworkModel {
  /**
   * @param {Object} data content of the reference file
   */
  constructor(data) {
    const elrs = data?.elrs ?? {};
    /** @type {Map<string, {waymarks: Array<{mileage:number, lat:number, lon:number}>, tracks: Array<{trid:string, from:number, to:number}>}>} */
    this.elrs = new Map();
    /** @type {Map<string, Array<[string, number]>>} grid cell -> [elr, waymark index] */
    this.grid = new Map();
    this.attribution = data?.attribution ?? '';
    this.generatedAt = data?.generatedAt ?? null;

    for (const [elr, entry] of Object.entries(elrs)) {
      const waymarks = (entry.waymarks ?? [])
        .map(([value, lat, lon]) => ({ mileage: milesAndYardsToMiles(value), lat, lon }))
        .filter((w) => Number.isFinite(w.mileage) && Number.isFinite(w.lat) && Number.isFinite(w.lon))
        .sort((a, b) => a.mileage - b.mileage);
      const tracks = (entry.tracks ?? [])
        .map(([trid, from, to]) => ({
          trid: String(trid),
          from: milesAndYardsToMiles(Math.min(from, to)),
          to: milesAndYardsToMiles(Math.max(from, to)),
        }))
        .filter((t) => Number.isFinite(t.from) && Number.isFinite(t.to));
      if (waymarks.length === 0 && tracks.length === 0) continue;
      this.elrs.set(elr, { waymarks, tracks });
      waymarks.forEach((waymark, index) => {
        const key = cellKey(waymark.lat, waymark.lon);
        const bucket = this.grid.get(key);
        if (bucket) bucket.push([elr, index]);
        else this.grid.set(key, [[elr, index]]);
      });
    }
  }

  /** @returns {string[]} the ELRs known to the model, sorted. */
  elrList() {
    return [...this.elrs.keys()].sort();
  }

  /**
   * Track IDs (TRID) recorded at a given mileage of an ELR.
   *
   * Several tracks share the same mileage — a mileage identifies a position
   * along the ELR, not a track — so the whole list is returned and the operator
   * picks the one the run was made on.
   *
   * @param {string} elr
   * @param {number} mileage mileage in decimal miles
   * @returns {string[]} sorted track IDs
   */
  tracksAt(elr, mileage) {
    const entry = this.elrs.get(elr);
    if (!entry || !Number.isFinite(mileage)) return [];
    const tracks = entry.tracks
      .filter((t) => mileage >= t.from - 1e-9 && mileage <= t.to + 1e-9)
      .map((t) => t.trid);
    return [...new Set(tracks)].sort();
  }

  /**
   * Locate a WGS84 position on the network.
   *
   * The position is projected onto the segments joining consecutive waymarks of
   * the same ELR; the mileage is interpolated along the closest segment. When
   * no line is found within `maxDistanceM`, `null` is returned — a run recorded
   * off the network, or outside the coverage of the reference file, keeps the
   * mileage integrated from the speed.
   *
   * @param {number} lat latitude in degrees
   * @param {number} lon longitude in degrees
   * @param {{maxDistanceM?: number, elr?: string}} [options]
   * @returns {NetworkLocation|null}
   */
  locate(lat, lon, options = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const maxDistanceM = options.maxDistanceM ?? DEFAULT_MAX_DISTANCE_M;
    const candidates = this._candidates(lat, lon, maxDistanceM, options.elr);
    if (candidates.length === 0) return null;

    const projection = localProjection(lat, lon);
    let best = null;
    for (const [elr, index] of candidates) {
      const waymarks = this.elrs.get(elr).waymarks;
      const point = projection(waymarks[index].lat, waymarks[index].lon);
      const direct = Math.hypot(point.x, point.y);
      if (!best || direct < best.distanceM) {
        best = { elr, mileage: waymarks[index].mileage, distanceM: direct };
      }
      // Interpolate along the two segments the waymark belongs to.
      for (const neighbour of [index - 1, index + 1]) {
        if (neighbour < 0 || neighbour >= waymarks.length) continue;
        const other = projection(waymarks[neighbour].lat, waymarks[neighbour].lon);
        const projected = projectOnSegment(point, other);
        if (projected === null) continue;
        const mileage =
          waymarks[index].mileage +
          projected.ratio * (waymarks[neighbour].mileage - waymarks[index].mileage);
        if (!best || projected.distanceM < best.distanceM) {
          best = { elr, mileage, distanceM: projected.distanceM };
        }
      }
    }
    if (!best || best.distanceM > maxDistanceM) return null;
    return { ...best, tracks: this.tracksAt(best.elr, best.mileage) };
  }

  /**
   * Journey information for a whole run: the ELR it was recorded on, the
   * mileage of its first located fix and the direction in which the mileage
   * runs. This is exactly what the operator would otherwise type on the start
   * screen, and what the pipeline needs to turn the integrated distance into a
   * mileage.
   *
   * @param {import('./localisation.js').GnssSample[]} gnss GNSS fixes of the run
   * @param {{maxDistanceM?: number}} [options]
   * @returns {{elr:string, mileage:number, t:number, mileageDirection:number, tracks:string[], located:number, fixes:number}|null}
   */
  anchor(gnss, options = {}) {
    const maxDistanceM = options.maxDistanceM ?? DEFAULT_MAX_DISTANCE_M;
    const samples = (gnss ?? []).filter(
      (fix) => Number.isFinite(fix?.lat) && Number.isFinite(fix?.lon),
    );
    if (samples.length === 0) return null;

    // First pass: which ELR do the fixes belong to? Closer fixes weigh more, so
    // that a run on one line is not attributed to a parallel one.
    const scores = new Map();
    const located = [];
    for (const fix of samples) {
      const hit = this.locate(fix.lat, fix.lon, { maxDistanceM });
      if (!hit) continue;
      located.push({ fix, hit });
      scores.set(hit.elr, (scores.get(hit.elr) ?? 0) + 1 / (1 + hit.distanceM));
    }
    if (located.length === 0) return null;
    let elr = null;
    let bestScore = -Infinity;
    for (const [candidate, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        elr = candidate;
      }
    }

    // Second pass: mileages of the fixes on the chosen ELR only, so that the
    // direction is not polluted by the fixes attributed to another line.
    const onElr = [];
    for (const { fix } of located) {
      const hit = this.locate(fix.lat, fix.lon, { maxDistanceM, elr });
      if (hit) onElr.push({ t: fix.t, mileage: hit.mileage, tracks: hit.tracks });
    }
    if (onElr.length === 0) return null;
    onElr.sort((a, b) => a.t - b.t);
    const first = onElr[0];
    const last = onElr[onElr.length - 1];
    const mileageDirection = last.mileage < first.mileage ? -1 : 1;
    // A run stays on the same track, so the candidates are the tracks present
    // at every located fix; at a junction that intersection can be empty and
    // the tracks of the first fix are used instead.
    let tracks = onElr.reduce(
      (common, point) => common.filter((trid) => point.tracks.includes(trid)),
      [...first.tracks],
    );
    if (tracks.length === 0) tracks = [...first.tracks];

    return {
      elr,
      mileage: first.mileage,
      t: first.t,
      mileageDirection,
      tracks,
      located: onElr.length,
      fixes: samples.length,
    };
  }

  /**
   * Waymarks of an ELR, in mileage order.
   * @param {string} elr
   * @returns {Array<{mileage:number, lat:number, lon:number}>}
   */
  waymarks(elr) {
    return this.elrs.get(elr)?.waymarks ?? [];
  }

  /** Number of waymarks held by the model. */
  get size() {
    let total = 0;
    for (const entry of this.elrs.values()) total += entry.waymarks.length;
    return total;
  }

  _candidates(lat, lon, maxDistanceM, elr) {
    const radiusCells = Math.max(
      1,
      Math.ceil(maxDistanceM / (CELL_DEGREES * METRES_PER_DEGREE_LAT)),
    );
    const latCell = Math.floor(lat / CELL_DEGREES);
    const lonCell = Math.floor(lon / cellLongitudeDegrees(lat));
    const out = [];
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const bucket = this.grid.get(`${latCell + dy}:${lonCell + dx}`);
        if (!bucket) continue;
        for (const candidate of bucket) {
          if (elr && candidate[0] !== elr) continue;
          out.push(candidate);
        }
      }
    }
    return out;
  }
}

/**
 * Load the reference file produced by `tools/build-network-model.js`.
 *
 * The file is optional: without it the application keeps working with the ELR,
 * track and initial mileage typed on the start screen.
 *
 * @param {string} [url]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<NetworkModel|null>}
 */
export async function loadNetworkModel(url = DEFAULT_MODEL_URL, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    return new NetworkModel(await response.json());
  } catch {
    return null;
  }
}

/** Metres in a degree of latitude, close enough for a lookup grid. */
const METRES_PER_DEGREE_LAT = 111320;

function cellLongitudeDegrees(lat) {
  // Keep the cells roughly square so that the search radius stays isotropic.
  const scale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return CELL_DEGREES / scale;
}

function cellKey(lat, lon) {
  return `${Math.floor(lat / CELL_DEGREES)}:${Math.floor(lon / cellLongitudeDegrees(lat))}`;
}

/**
 * Local flat projection in metres, centred on the queried position; over the
 * few hundred metres involved here the distortion is negligible.
 */
function localProjection(lat0, lon0) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  return (lat, lon) => ({
    x: (lon - lon0) * METRES_PER_DEGREE_LAT * cos,
    y: (lat - lat0) * METRES_PER_DEGREE_LAT,
  });
}

/**
 * Project the origin (the queried position) onto the segment `[a, b]` given in
 * local metres, and return how far along the segment the projection falls.
 *
 * @param {{x:number, y:number}} a
 * @param {{x:number, y:number}} b
 * @returns {{ratio:number, distanceM:number}|null}
 */
function projectOnSegment(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return null;
  // The queried position is the origin of the local projection.
  let ratio = (-a.x * dx - a.y * dy) / lengthSq;
  ratio = Math.min(1, Math.max(0, ratio));
  const px = a.x + ratio * dx;
  const py = a.y + ratio * dy;
  return { ratio, distanceM: Math.hypot(px, py) };
}

/**
 * Mileage of a distance travelled from an anchor point, following the
 * direction of the mileage of the ELR.
 *
 * @param {number} anchorMileage mileage at the anchor, in decimal miles
 * @param {number} distanceM distance travelled from the anchor, in metres
 * @param {number} direction +1 when the mileage increases along the run
 * @returns {number} mileage in decimal miles
 */
export function mileageFromAnchor(anchorMileage, distanceM, direction = 1) {
  const sign = direction < 0 ? -1 : 1;
  return anchorMileage + (sign * distanceM) / METRES_PER_MILE;
}
