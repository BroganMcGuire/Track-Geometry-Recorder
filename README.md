# Track Geometry Recorder

A smartphone application for measuring carbody accelerations onboard trains and
locating track geometry defects, recreated from the UIC technical report
*"Use of low-cost devices for measuring acceleration onboard trains"*
(Harmotrack Sub Working Group 3, April 2025) included in this repository.

The app follows the architecture of KELI, SNCF Réseau's track-monitoring app
described in §2.2 of the report: the phone records **raw** acceleration and
location data during the run, and all filtering and analysis happens afterwards
in a post-processing step.

## What it does

**Recording (report §2 – Data collection)**

- Start screen for the journey information: ELR (e.g. `ECM1`), track (e.g.
  `1100`), initial mileage in miles, mileage direction, train type and position
  in the train.
- Configurable mapping of the device axes (x, y, z) to the vehicle axes, so that
  the vertical (AVC), lateral (ATC) and longitudinal (ALC) channels are correct
  whatever the installation.
- Measurement screen with one live graph per axis plus the current speed,
  mileage, effective sampling rate and elapsed time.
- Angular positions of the phone are recorded throughout the run.
- One-tap markers for a switch, bridge, tunnel or level crossing, which help the
  maintenance team locate a defect precisely (§4.1).
- Only raw data is stored while recording: filtering during the measurement was
  observed to disturb the phone and cause lagging, data loss or crashes (§2.2).
- Runs are stored locally (IndexedDB) and can be exported as CSV or JSON.

**Post-processing (report §3 – Data processing, Figure 3)**

The pipeline implements the six documented steps:

1. **Synchronising** the acceleration and location data through their timestamps
   (they come from two different sources with different sampling rates).
2. **Interpolating** the missing location points onto the acceleration samples.
3. **Resampling** to an exact frequency — smartphone sensors do not produce data
   at an exact rate and their timestamps drift over long runs.
4. **Filtering** with a zero-phase Butterworth band-pass; the default 0.4–10 Hz
   band follows EN 14363 for carbody accelerations and both cut-offs are
   configurable.
5. **Converting to the space domain** at a fixed spatial step of 0.25 m, to match
   the data produced by track measurement trains.
6. **Detecting exceeded thresholds** and reporting each one with its peak value,
   level, mileage and coordinates.

**On-track localisation (report §4)**

- GNSS speed is used when available, and gaps shorter than a configurable limit
  are interpolated.
- During longer outages (tunnels, dense urban areas, treated train windows), the
  speed is obtained by integrating the longitudinal acceleration from the last
  valid fix; the accumulated drift is spread linearly so that the estimate
  matches the fix found on the other side of the gap.
- Distance is integrated from the speed and converted into a mileage in miles
  using the initial mileage and the direction entered on the start screen.

## Running it

```bash
npm start          # serves the folder on http://localhost:8080
npm test           # runs the unit tests of the processing and export code
```

The app itself is a static progressive web app with no build step; `pg` is only
used by the command line database tools. Motion and location sensors require a
secure context, so on a real phone the folder must be served over HTTPS (or
through a tunnel); the app can then be installed to the home screen and works
offline.

## Supabase database

Runs are always recorded locally first (IndexedDB). To keep a shared copy of
them, a Supabase PostgreSQL database can be provisioned from `db/schema.sql`,
which creates a `runs` table (journey information plus the raw acceleration,
GNSS and marker datasheets as JSON) and a `threshold_events` table (one row per
exceedance, queryable by ELR, track and mileage).

The connection string is read from the `SUPABASE_DB_URL` environment variable
and is never stored in the repository; copy `.env.example` and fill in the
value from *Project settings → Database* in the Supabase dashboard.

```bash
export SUPABASE_DB_URL='postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres'
npm run db:setup                       # creates the tables (idempotent)
npm run db:upload -- run-raw.json      # uploads a run exported from the app
```

`db:upload` stores the raw datasheets and runs the post-processing pipeline once
so that the exceeded thresholds are stored alongside the run. TLS certificates
are verified by default; set `SUPABASE_DB_SSL=no-verify` only when connecting
through a proxy with a self-signed certificate.

## Measurement recommendations

Taken from §2.1 and §4.1 of the report:

- Attach the device to the **floor** of the coach so that it cannot slide in
  curves or under braking, and so that peaks are not damped by a seat or table.
- A GNSS sampling rate of 1 Hz is a minimum; 10 Hz is recommended (one point
  every 8 m at 300 km/h). An external Bluetooth receiver placed on a window
  greatly improves reception inside a carbody.
- Record the position of the device in the train: the measured levels depend on
  the longitudinal position along the train and along the coach (§6).
- Before a low-cost device is introduced on a network, compare it with an
  existing measurement system to check that it is reliable enough (§1.3, §5).

## Thresholds

The report states that SNCF Réseau uses internal standards for the limit values.
Those are not public, so `src/processing/thresholds.js` exposes the levels as
plain configuration with EN 14363 carbody acceleration limits as a public
baseline. Replace `DEFAULT_THRESHOLDS` with your own infrastructure manager's
rules before using the results operationally.

## Layout

```
index.html                     application shell (setup, measure, runs screens)
styles.css, icon.svg           presentation
sw.js, manifest.webmanifest    offline support and installability
src/app.js                     screen and workflow controller
src/recorder.js                sensor capture, raw data only
src/storage.js                 IndexedDB persistence of the runs
src/export.js                  CSV and JSON exports
src/ui/chart.js                lightweight rolling strip chart
src/processing/pipeline.js     the six post-processing steps
src/processing/signal.js       interpolation, resampling, Butterworth filtering
src/processing/localisation.js speed, distance and mileage estimation
src/processing/thresholds.js   threshold levels and exceedance detection
tools/serve.js                 static server for local development
tools/db.js                    Supabase connection helper (SUPABASE_DB_URL)
tools/db-setup.js              applies db/schema.sql to the Supabase database
tools/db-upload.js             uploads an exported run and its threshold events
db/schema.sql                  Supabase (PostgreSQL) schema
tests/                         unit tests (node --test)
```

## Limitations

- Accelerations measured inside a carbody do not give an exact evaluation of the
  geometry defects; they indicate the quality of the track and the impact of a
  defect (report §1).
- Smartphones cannot replace axle box or bogie measurements, which need
  high-frequency content beyond their bandwidth (§1.1).
- The speed estimation methods based on the harmonic content of axle box signals
  (§4.2) and on two measurement points (§4.3) are not implemented; they require
  sensors outside the carbody.
