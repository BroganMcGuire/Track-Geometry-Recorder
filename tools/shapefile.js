/**
 * Minimal readers for the ESRI shapefile format, enough for the Network Rail
 * network model datasets (point and polyline layers plus their dBASE table),
 * and the conversion from British National Grid to WGS84 they are stored in.
 *
 * The datasets of https://github.com/openraildata/network-rail-gis are ESRI
 * shapefiles in EPSG:27700 (OSGB36 / British National Grid); the application
 * works with the WGS84 coordinates reported by the phone, so the reference file
 * is built once with the transformation below.
 */
import { readFileSync } from 'node:fs';

/**
 * Read the attribute table of a shapefile (`.dbf`, dBASE III).
 *
 * @param {string} path
 * @returns {Array<Object<string,string>>} one object per record, values as text
 */
export function readDbf(path) {
  const buffer = readFileSync(path);
  const records = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);

  const fields = [];
  for (let offset = 32; offset < headerLength - 1 && buffer[offset] !== 0x0d; offset += 32) {
    const name = buffer
      .subarray(offset, offset + 11)
      .toString('latin1')
      .replace(/\0.*$/, '');
    fields.push({ name, length: buffer[offset + 16] });
  }

  const out = [];
  for (let i = 0; i < records; i++) {
    // The first byte of a record is the deletion flag.
    let offset = headerLength + i * recordLength + 1;
    if (buffer[headerLength + i * recordLength] === 0x2a) {
      out.push(null); // deleted record, kept so that the indices stay aligned
      continue;
    }
    const row = {};
    for (const field of fields) {
      row[field.name] = buffer.subarray(offset, offset + field.length).toString('latin1').trim();
      offset += field.length;
    }
    out.push(row);
  }
  return out;
}

/**
 * Read the geometries of a shapefile (`.shp`).
 *
 * Only the shape types used by the network model are decoded: point (1),
 * polyline (3) and their measured variants (21, 23).
 *
 * @param {string} path
 * @returns {Array<{type:number, points:Array<[number,number]>}>}
 */
export function readShp(path) {
  const buffer = readFileSync(path);
  const fileLength = buffer.readInt32BE(24) * 2;
  const shapes = [];
  let offset = 100;
  while (offset + 8 <= fileLength) {
    const contentLength = buffer.readInt32BE(offset + 4) * 2;
    const type = buffer.readInt32LE(offset + 8);
    const body = offset + 12;
    if (type === 1 || type === 21) {
      shapes.push({ type, points: [[buffer.readDoubleLE(body), buffer.readDoubleLE(body + 8)]] });
    } else if (type === 3 || type === 23) {
      // box (32 bytes), number of parts, number of points, part indices, points
      const numPoints = buffer.readInt32LE(body + 36);
      const numParts = buffer.readInt32LE(body + 32);
      const pointsAt = body + 40 + numParts * 4;
      const points = [];
      for (let i = 0; i < numPoints; i++) {
        points.push([
          buffer.readDoubleLE(pointsAt + i * 16),
          buffer.readDoubleLE(pointsAt + i * 16 + 8),
        ]);
      }
      shapes.push({ type, points });
    } else {
      shapes.push({ type, points: [] }); // null shape or unsupported type
    }
    offset += 8 + contentLength;
  }
  return shapes;
}

/* ------------------------------------------------ British National Grid */

const AIRY_1830 = { a: 6377563.396, b: 6356256.909 };
const GRS80 = { a: 6378137.0, b: 6356752.3141 };
const NATIONAL_GRID = {
  f0: 0.9996012717,
  lat0: (49 * Math.PI) / 180,
  lon0: (-2 * Math.PI) / 180,
  e0: 400000,
  n0: -100000,
};

/**
 * Convert an OSGB36 easting/northing into WGS84 latitude/longitude.
 *
 * The inverse Transverse Mercator projection gives OSGB36 coordinates on the
 * Airy 1830 ellipsoid; a Helmert transformation then brings them onto WGS84.
 * The residual error of the Helmert parameters is a few metres, well below the
 * accuracy of a smartphone GNSS fix.
 *
 * @param {number} easting metres
 * @param {number} northing metres
 * @returns {{lat:number, lon:number}} degrees
 */
export function osgb36ToWgs84(easting, northing) {
  const { a, b } = AIRY_1830;
  const { f0, lat0, lon0, e0, n0 } = NATIONAL_GRID;
  const eSquared = (a * a - b * b) / (a * a);
  const n = (a - b) / (a + b);

  let lat = lat0;
  let m = 0;
  do {
    lat = (northing - n0 - m) / (a * f0) + lat;
    const dLat = lat - lat0;
    const sLat = lat + lat0;
    m =
      b *
      f0 *
      ((1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * dLat -
        (3 * n + 3 * n * n + (21 / 8) * n * n * n) * Math.sin(dLat) * Math.cos(sLat) +
        ((15 / 8) * n * n + (15 / 8) * n * n * n) * Math.sin(2 * dLat) * Math.cos(2 * sLat) -
        (35 / 24) * n * n * n * Math.sin(3 * dLat) * Math.cos(3 * sLat));
  } while (Math.abs(northing - n0 - m) >= 0.00001);

  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const tanLat = Math.tan(lat);
  const nu = (a * f0) / Math.sqrt(1 - eSquared * sinLat * sinLat);
  const rho = (a * f0 * (1 - eSquared)) / (1 - eSquared * sinLat * sinLat) ** 1.5;
  const eta2 = nu / rho - 1;

  const tan2 = tanLat * tanLat;
  const tan4 = tan2 * tan2;
  const tan6 = tan4 * tan2;
  const sec = 1 / cosLat;
  const vii = tanLat / (2 * rho * nu);
  const viii = (tanLat / (24 * rho * nu ** 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const ix = (tanLat / (720 * rho * nu ** 5)) * (61 + 90 * tan2 + 45 * tan4);
  const x = sec / nu;
  const xi = (sec / (6 * nu ** 3)) * (nu / rho + 2 * tan2);
  const xii = (sec / (120 * nu ** 5)) * (5 + 28 * tan2 + 24 * tan4);
  const xiia = (sec / (5040 * nu ** 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const de = easting - e0;
  const latitude = lat - vii * de ** 2 + viii * de ** 4 - ix * de ** 6;
  const longitude = lon0 + x * de - xi * de ** 3 + xii * de ** 5 - xiia * de ** 7;

  return helmertOsgb36ToWgs84(latitude, longitude);
}

/** OSGB36 to WGS84 Helmert parameters (Ordnance Survey, metres / arc-seconds / ppm). */
const HELMERT = { tx: 446.448, ty: -125.157, tz: 542.06, rx: 0.1502, ry: 0.247, rz: 0.8421, s: -20.4894 };

function helmertOsgb36ToWgs84(latRad, lonRad) {
  const from = AIRY_1830;
  const to = GRS80;
  const e2From = (from.a * from.a - from.b * from.b) / (from.a * from.a);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const nu = from.a / Math.sqrt(1 - e2From * sinLat * sinLat);

  const x1 = nu * cosLat * Math.cos(lonRad);
  const y1 = nu * cosLat * Math.sin(lonRad);
  const z1 = (1 - e2From) * nu * sinLat;

  const arcSecond = Math.PI / (180 * 3600);
  const rx = HELMERT.rx * arcSecond;
  const ry = HELMERT.ry * arcSecond;
  const rz = HELMERT.rz * arcSecond;
  const s = HELMERT.s / 1e6;

  const x2 = HELMERT.tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = HELMERT.ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = HELMERT.tz - ry * x1 + rx * y1 + (1 + s) * z1;

  const e2To = (to.a * to.a - to.b * to.b) / (to.a * to.a);
  const p = Math.hypot(x2, y2);
  let lat = Math.atan2(z2, p * (1 - e2To));
  for (let i = 0; i < 10; i++) {
    const nu2 = to.a / Math.sqrt(1 - e2To * Math.sin(lat) ** 2);
    lat = Math.atan2(z2 + e2To * nu2 * Math.sin(lat), p);
  }
  return { lat: (lat * 180) / Math.PI, lon: (Math.atan2(y2, x2) * 180) / Math.PI };
}
