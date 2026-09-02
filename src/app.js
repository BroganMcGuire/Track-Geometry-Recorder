import { Recorder } from './recorder.js';
import { StripChart } from './ui/chart.js';
import { deleteRun, listRuns, loadRun, saveRun, summarise } from './storage.js';
import { processRun } from './processing/pipeline.js';
import { metresToMiles } from './processing/localisation.js';
import {
  accelerationCsv,
  download,
  eventsCsv,
  filePrefix,
  gnssCsv,
  markersCsv,
  spaceDomainCsv,
} from './export.js';

/**
 * Application controller: wires the three screens (setup, measurement, runs)
 * described in the report (§2.2) to the recorder, the storage and the
 * post-processing pipeline.
 */

/** Conversion from metres per second to miles per hour. */
const MPS_TO_MPH = 3600 / 1609.344;

const screens = {
  setup: document.getElementById('screen-setup'),
  measure: document.getElementById('screen-measure'),
  runs: document.getElementById('screen-runs'),
};

const charts = {
  vertical: new StripChart(document.getElementById('chart-vertical'), {
    label: 'AVC vertical',
    colour: '#2f81f7',
  }),
  lateral: new StripChart(document.getElementById('chart-lateral'), {
    label: 'ATC lateral',
    colour: '#3fb950',
  }),
  longitudinal: new StripChart(document.getElementById('chart-longitudinal'), {
    label: 'ALC longitudinal',
    colour: '#d29922',
  }),
};

const state = {
  recorder: null,
  meta: null,
  timer: null,
  selectedRunId: null,
  selectedRun: null,
  processed: null,
  // Gravity is only removed for the live display; the stored data stays raw.
  bias: { vertical: 9.81, lateral: 0, longitudinal: 0 },
  lastFix: null,
};

function showScreen(name) {
  for (const [key, element] of Object.entries(screens)) {
    element.hidden = key !== name;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.screen === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (name === 'runs') refreshRunList();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showScreen(tab.dataset.screen));
});

/* ------------------------------------------------------------------ setup */

function describeCapabilities() {
  const list = document.getElementById('capabilities');
  const items = [
    ['Motion sensors', typeof DeviceMotionEvent !== 'undefined'],
    ['Orientation sensors', typeof DeviceOrientationEvent !== 'undefined'],
    ['Location service', 'geolocation' in navigator],
    ['Local storage of runs', 'indexedDB' in window],
    ['Screen wake lock', 'wakeLock' in navigator],
  ];
  list.replaceChildren(
    ...items.map(([label, available]) => {
      const li = document.createElement('li');
      li.textContent = `${label}: `;
      const status = document.createElement('span');
      status.textContent = available ? 'available' : 'not available';
      if (available) status.className = 'ok';
      li.appendChild(status);
      return li;
    }),
  );
}

document.getElementById('journey-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('setup-error');
  error.textContent = '';
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const axes = {
    vertical: data.verticalAxis,
    lateral: data.lateralAxis,
    longitudinal: data.longitudinalAxis,
  };
  const distinct = new Set(Object.values(axes));
  if (distinct.size !== 3) {
    error.textContent = 'The three vehicle axes must be mapped to three different device axes.';
    return;
  }

  state.meta = {
    elr: data.elr,
    track: data.track,
    initialMileageMi: Number(data.initialMileageMi) || 0,
    mileageDirection: Number(data.mileageDirection) || 1,
    trainType: data.trainType,
    position: data.position,
    axes,
  };

  for (const chart of Object.values(charts)) chart.reset();
  state.bias = { vertical: 9.81, lateral: 0, longitudinal: 0 };
  state.lastFix = null;

  state.recorder = new Recorder({
    onAcceleration: onAcceleration,
    onPosition: onPosition,
    onError: (err) => {
      document.getElementById('measure-error').textContent = err.message;
    },
  });
  state.recorder.setAxisMapping(axes);

  try {
    await state.recorder.start(state.meta);
  } catch (err) {
    error.textContent = err.message;
    state.recorder = null;
    return;
  }
  document.getElementById('measure-error').textContent = '';
  document.getElementById('marker-log').textContent = '';
  showScreen('measure');
  startTimer();
});

/* ------------------------------------------------------------ measurement */

function onAcceleration(sample) {
  // A slow running mean approximates the static component (gravity plus the
  // effect of ramps and curves) for display purposes only.
  for (const axis of ['vertical', 'lateral', 'longitudinal']) {
    state.bias[axis] += 0.002 * (sample[axis] - state.bias[axis]);
    charts[axis].push(sample[axis] - state.bias[axis]);
  }
}

function onPosition(fix) {
  state.lastFix = fix;
  const speedMph = typeof fix.speed === 'number' ? fix.speed * MPS_TO_MPH : null;
  document.getElementById('readout-speed').textContent =
    speedMph === null ? '–' : speedMph.toFixed(0);
  document.getElementById('position-line').textContent =
    `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}` +
    (fix.accuracy ? ` (±${fix.accuracy.toFixed(0)} m)` : '');

  if (state.meta && typeof fix.speed === 'number') {
    // Rough live mileage: the exact value is recomputed during post-processing
    // from the filtered and resampled data.
    const elapsed = fix.t;
    const mileage =
      state.meta.initialMileageMi +
      state.meta.mileageDirection * metresToMiles(fix.speed * elapsed);
    document.getElementById('readout-mileage').textContent = mileage.toFixed(3);
  }
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(() => {
    if (!state.recorder?.recording) return;
    const seconds = Math.floor(
      (state.recorder.acceleration[state.recorder.acceleration.length - 1]?.t ?? 0),
    );
    document.getElementById('readout-duration').textContent =
      `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    document.getElementById('readout-rate').textContent =
      state.recorder.effectiveRate().toFixed(0);
  }, 1000);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

document.querySelectorAll('[data-marker]').forEach((button) => {
  button.addEventListener('click', () => {
    const marker = state.recorder?.addMarker(button.dataset.marker);
    if (!marker) return;
    document.getElementById('marker-log').textContent =
      `${marker.type} registered at ${marker.t.toFixed(1)} s`;
  });
});

document.getElementById('stop-button').addEventListener('click', async () => {
  if (!state.recorder) return;
  const run = state.recorder.stop();
  stopTimer();
  state.recorder = null;
  if (run.acceleration.length < 2) {
    document.getElementById('measure-error').textContent =
      'The run was too short to be saved.';
    showScreen('setup');
    return;
  }
  state.selectedRunId = await saveRun(run);
  state.selectedRun = run;
  state.processed = null;
  showScreen('runs');
});

/* ------------------------------------------------------- runs and results */

async function refreshRunList() {
  const list = document.getElementById('run-list');
  const runs = await listRuns();
  if (runs.length === 0) {
    list.replaceChildren(Object.assign(document.createElement('li'), {
      textContent: 'No run recorded yet.',
      className: 'meta',
    }));
    document.getElementById('processing-card').hidden = true;
    return;
  }
  list.replaceChildren(
    ...runs.map(({ id, summary }) => {
      const li = document.createElement('li');
      li.dataset.id = id;
      li.setAttribute('aria-selected', String(id === state.selectedRunId));
      const title = document.createElement('strong');
      title.textContent = `ELR ${summary.elr || '?'} – track ${summary.track || '?'}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent =
        `${new Date(summary.startedAt).toLocaleString()} · ` +
        `${Math.round(summary.durationS)} s · ${summary.samples} samples · ` +
        `${summary.rateHz.toFixed(0)} Hz · ${summary.fixes} fixes`;
      li.append(title, meta);
      li.addEventListener('click', () => selectRun(id));
      return li;
    }),
  );
  if (state.selectedRunId) document.getElementById('processing-card').hidden = false;
}

async function selectRun(id) {
  const record = await loadRun(id);
  if (!record) return;
  state.selectedRunId = id;
  state.selectedRun = record.run;
  state.processed = null;
  document.getElementById('processing-result').replaceChildren();
  document.getElementById('processing-card').hidden = false;
  const form = document.getElementById('processing-form');
  refreshRunList();
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('processing-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.selectedRun) return;
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const meta = state.selectedRun.meta ?? {};
  const container = document.getElementById('processing-result');
  try {
    state.processed = processRun(state.selectedRun, {
      resampleHz: Number(data.resampleHz),
      filterLowHz: Number(data.filterLowHz),
      filterHighHz: Number(data.filterHighHz),
      spatialStepM: Number(data.spatialStepM),
      initialMileageMi: Number(meta.initialMileageMi) || 0,
      mileageDirection: Number(meta.mileageDirection) || 1,
    });
  } catch (error) {
    container.replaceChildren(
      Object.assign(document.createElement('p'), {
        className: 'error',
        textContent: error.message,
      }),
    );
    return;
  }
  renderResult(container, state.processed);
});

function renderResult(container, processed) {
  const stats = processed.statistics;
  const summary = document.createElement('p');
  summary.className = 'hint';
  summary.textContent =
    `${stats.distanceMi.toFixed(3)} miles in ${stats.durationS.toFixed(0)} s · ` +
    `mean ${stats.speed.meanMph.toFixed(0)} mph · max ${stats.speed.maxMph.toFixed(0)} mph`;

  const statsTable = buildTable(
    ['Channel', 'RMS', 'C95', 'Min', 'Max'],
    ['vertical', 'lateral', 'longitudinal'].map((channel) => [
      channel,
      stats[channel].rms.toFixed(3),
      stats[channel].c95.toFixed(3),
      stats[channel].min.toFixed(2),
      stats[channel].max.toFixed(2),
    ]),
  );

  const eventsTitle = document.createElement('h2');
  eventsTitle.textContent = `Exceeded thresholds (${processed.events.length})`;
  const eventsTable = buildTable(
    ['Mileage', 'Channel', 'Level', 'Value', 'Length'],
    processed.events
      .slice(0, 100)
      .map((e) => [
        e.mileage === null ? '–' : e.mileage.toFixed(3),
        e.channel,
        e.level,
        `${e.value.toFixed(2)} m/s²`,
        `${e.lengthM.toFixed(2)} m`,
      ]),
  );

  container.replaceChildren(summary, statsTable, eventsTitle, eventsTable);
}

function buildTable(header, rows) {
  const table = document.createElement('table');
  const thead = table.createTHead().insertRow();
  for (const cell of header) {
    const th = document.createElement('th');
    th.textContent = cell;
    thead.appendChild(th);
  }
  const body = table.createTBody();
  if (rows.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = header.length;
    cell.textContent = 'None';
  }
  for (const row of rows) {
    const tr = body.insertRow();
    for (const cell of row) tr.insertCell().textContent = cell;
  }
  return table;
}

document.querySelectorAll('[data-export]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!state.selectedRun) return;
    const summary = summarise(state.selectedRun);
    const prefix = filePrefix(summary);
    switch (button.dataset.export) {
      case 'raw':
        download(`${prefix}-acceleration.csv`, accelerationCsv(state.selectedRun));
        download(`${prefix}-gnss.csv`, gnssCsv(state.selectedRun));
        if (state.selectedRun.markers?.length) {
          download(`${prefix}-markers.csv`, markersCsv(state.selectedRun));
        }
        break;
      case 'processed':
        if (!state.processed) {
          document.getElementById('processing-result').textContent =
            'Process the run before exporting the results.';
          return;
        }
        download(`${prefix}-space-domain.csv`, spaceDomainCsv(state.processed));
        download(`${prefix}-thresholds.csv`, eventsCsv(state.processed));
        break;
      case 'json':
        download(
          `${prefix}-raw.json`,
          JSON.stringify(state.selectedRun),
          'application/json',
        );
        break;
      case 'delete':
        if (!confirm('Delete this run permanently?')) return;
        await deleteRun(state.selectedRunId);
        state.selectedRunId = null;
        state.selectedRun = null;
        state.processed = null;
        document.getElementById('processing-card').hidden = true;
        refreshRunList();
        break;
      default:
        break;
    }
  });
});

/* --------------------------------------------------------------- startup */

describeCapabilities();
showScreen('setup');

window.addEventListener('beforeunload', (event) => {
  if (state.recorder?.recording) {
    event.preventDefault();
    event.returnValue = '';
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is a convenience; the app works without it.
    });
  });
}
