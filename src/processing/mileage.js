/**
 * Network Rail mileages.
 *
 * The Infrastructure Network Model published by Network Rail (the datasets of
 * https://github.com/openraildata/network-rail-gis, Open Government Licence
 * v3.0) stores every mileage — `L_M_FROM`, `L_M_TO` on the links and reference
 * lines, `WAYMARK_VALUE` on the waymarks — as a single decimal number written
 * in *miles and yards*: the integer part is the number of miles from the datum
 * of the ELR and the four decimals are the yards within that mile, from 0000 to
 * 1759. A quarter-mile waymark therefore reads `.0440`, a half-mile one `.0880`
 * and a three-quarter-mile one `.1320`.
 *
 * The rest of the application works in decimal miles, so this module holds the
 * conversions between the two notations and the parsing and formatting of the
 * values shown to the user.
 */

/** Yards in a mile. */
export const YARDS_PER_MILE = 1760;

/** Length of an international yard in metres. */
export const METRES_PER_YARD = 0.9144;

/** Length of a statute mile in metres (1760 yards). */
export const METRES_PER_MILE = YARDS_PER_MILE * METRES_PER_YARD;

/** Yards in a chain, the other unit used on the network (80 chains a mile). */
export const YARDS_PER_CHAIN = 22;

/**
 * Convert a mileage written in the Network Rail miles-and-yards notation into
 * decimal miles.
 *
 * Reference lines are extended before the datum of their ELR, so the value can
 * be negative; the yards are then counted backwards as well (`-1.0880` is one
 * mile and 880 yards before the datum).
 *
 * @param {number} value mileage as stored in the network model, e.g. 326.0638
 * @returns {number} mileage in decimal miles, e.g. 326.3625
 */
export function milesAndYardsToMiles(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NaN;
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value);
  const miles = Math.floor(absolute);
  // The yards are stored as four decimals; rounding removes the noise of the
  // binary representation of the shapefile values.
  const yards = Math.round((absolute - miles) * 10000);
  return sign * (miles + yards / YARDS_PER_MILE);
}

/**
 * Convert decimal miles into the Network Rail miles-and-yards notation.
 *
 * @param {number} miles mileage in decimal miles
 * @returns {number} mileage in the `M.YYYY` notation of the network model
 */
export function milesToMilesAndYards(miles) {
  if (typeof miles !== 'number' || !Number.isFinite(miles)) return NaN;
  const sign = miles < 0 ? -1 : 1;
  const absolute = Math.abs(miles);
  let whole = Math.floor(absolute);
  let yards = Math.round((absolute - whole) * YARDS_PER_MILE);
  if (yards >= YARDS_PER_MILE) {
    // 1759.6 yards rounds to a full mile.
    whole += 1;
    yards = 0;
  }
  return sign * (whole + yards / 10000);
}

/**
 * Split a mileage into its miles, yards and chains components.
 *
 * @param {number} miles mileage in decimal miles
 * @returns {{sign:number, miles:number, yards:number, chains:number}}
 */
export function splitMileage(miles) {
  const sign = miles < 0 ? -1 : 1;
  const absolute = Math.abs(miles);
  let whole = Math.floor(absolute);
  let yards = Math.round((absolute - whole) * YARDS_PER_MILE);
  if (yards >= YARDS_PER_MILE) {
    whole += 1;
    yards = 0;
  }
  return { sign, miles: whole, yards, chains: yards / YARDS_PER_CHAIN };
}

/**
 * Format a mileage the way it is written on the network, e.g. `326m 0638y`.
 *
 * @param {number} miles mileage in decimal miles
 * @returns {string}
 */
export function formatMileage(miles) {
  if (typeof miles !== 'number' || !Number.isFinite(miles)) return '–';
  const parts = splitMileage(miles);
  const prefix = parts.sign < 0 ? '-' : '';
  return `${prefix}${parts.miles}m ${String(parts.yards).padStart(4, '0')}y`;
}

/**
 * Parse a mileage entered by the user.
 *
 * Both notations are accepted: plain decimal miles (`326.3625`), the network
 * model notation (`326.0638`, when it is followed by the `m`/`y` units or when
 * `milesAndYards` is set) and the spoken form `326m 638y` / `326 miles 638
 * yards` / `326.0638my`.
 *
 * @param {string|number} text value entered by the user
 * @param {{milesAndYards?: boolean}} [options] how a bare decimal is read
 * @returns {number|null} mileage in decimal miles, or null when unparsable
 */
export function parseMileage(text, options = {}) {
  if (typeof text === 'number') {
    return options.milesAndYards ? milesAndYardsToMiles(text) : text;
  }
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return null;

  // "326m 638y", "326 miles 638 yards", "326 m 638 yd"
  const spoken = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*(?:m|miles?)\s*(\d+(?:\.\d+)?)\s*(?:y|yds?|yards?)$/);
  if (spoken) {
    const miles = Number(spoken[1]);
    const yards = Number(spoken[2]);
    if (!Number.isFinite(miles) || !Number.isFinite(yards)) return null;
    const sign = miles < 0 ? -1 : 1;
    return sign * (Math.abs(miles) + yards / YARDS_PER_MILE);
  }

  // "326.0638my" or "326.0638 miles and yards"
  const tagged = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*(?:my|m\+y|miles?\s*(?:and|&)\s*yards?)$/);
  if (tagged) return milesAndYardsToMiles(Number(tagged[1]));

  const plain = Number(trimmed.replace(/\s*(?:mi|miles?)$/, ''));
  if (!Number.isFinite(plain)) return null;
  return options.milesAndYards ? milesAndYardsToMiles(plain) : plain;
}

/**
 * Distance in metres between two mileages of the same ELR.
 *
 * @param {number} fromMiles
 * @param {number} toMiles
 * @returns {number} distance in metres (signed, like the mileage difference)
 */
export function mileageDistanceM(fromMiles, toMiles) {
  return (toMiles - fromMiles) * METRES_PER_MILE;
}
