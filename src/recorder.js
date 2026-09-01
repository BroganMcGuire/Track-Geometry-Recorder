/**
 * Sensor capture (report §2 "Data collection").
 *
 * The recorder only stores raw data: filtering or post-processing the data
 * during the measurement was observed to disturb the smartphone and cause
 * lagging, data loss, or crashes (report §2.2). Everything is kept in memory as
 * flat arrays and persisted at the end of the run.
 */

/** Sensor axes as seen by the vehicle, once the phone orientation is known. */
export const AXES = {
  vertical: 'AVC',
  lateral: 'ATC',
  longitudinal: 'ALC',
};

/**
 * @typedef {Object} RecorderEvents
 * @property {(sample: Object) => void} [onAcceleration]
 * @property {(fix: Object) => void} [onPosition]
 * @property {(error: Error) => void} [onError]
 */

export class Recorder {
  /**
   * @param {RecorderEvents} [handlers]
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.recording = false;
    this.startedAt = null;
    this.acceleration = [];
    this.orientation = [];
    this.gnss = [];
    this.markers = [];
    /**
     * Mapping from the device axes (x, y, z) to the vehicle axes. The phone is
     * expected to be laid flat on the floor of the coach, screen up, with its
     * top pointing towards the front of the train; the mapping is adjusted from
     * the setup screen for other placements.
     */
    this.axisMap = { vertical: 'z', lateral: 'x', longitudinal: 'y' };
    this.axisSign = { vertical: 1, lateral: 1, longitudinal: 1 };
    this._onMotion = this._onMotion.bind(this);
    this._onOrientation = this._onOrientation.bind(this);
    this._watchId = null;
    this._wakeLock = null;
  }

  /**
   * Ask for the permissions required by iOS 13+ before a run can start.
   * @returns {Promise<boolean>} true when motion access was granted
   */
  static async requestMotionPermission() {
    const api = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null;
    if (api && typeof api.requestPermission === 'function') {
      const state = await api.requestPermission();
      return state === 'granted';
    }
    return true;
  }

  /**
   * @param {{vertical:string, lateral:string, longitudinal:string}} map
   * @param {{vertical:number, lateral:number, longitudinal:number}} [sign]
   */
  setAxisMapping(map, sign) {
    this.axisMap = { ...this.axisMap, ...map };
    if (sign) this.axisSign = { ...this.axisSign, ...sign };
  }

  /**
   * Start a measurement run.
   * @param {Object} meta journey information entered on the start screen
   */
  async start(meta) {
    if (this.recording) return;
    const granted = await Recorder.requestMotionPermission();
    if (!granted) throw new Error('motion sensor access was denied');

    this.meta = { ...meta, startedAt: new Date().toISOString() };
    this.acceleration = [];
    this.orientation = [];
    this.gnss = [];
    this.markers = [];
    this.startedAt = performance.now();
    this.recording = true;

    window.addEventListener('devicemotion', this._onMotion);
    window.addEventListener('deviceorientation', this._onOrientation);

    if (navigator.geolocation) {
      this._watchId = navigator.geolocation.watchPosition(
        (position) => this._onPosition(position),
        (error) => this.handlers.onError?.(new Error(`GNSS: ${error.message}`)),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
      );
    } else {
      this.handlers.onError?.(new Error('this device has no location service'));
    }
    await this._acquireWakeLock();
  }

  /**
   * Stop the run and return the raw recording.
   * @returns {{meta: Object, acceleration: Object[], orientation: Object[], gnss: Object[], markers: Object[]}}
   */
  stop() {
    if (!this.recording) return this.toRun();
    this.recording = false;
    window.removeEventListener('devicemotion', this._onMotion);
    window.removeEventListener('deviceorientation', this._onOrientation);
    if (this._watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(this._watchId);
      this._watchId = null;
    }
    this._releaseWakeLock();
    this.meta = { ...this.meta, stoppedAt: new Date().toISOString() };
    return this.toRun();
  }

  /** @returns {Object} the raw recording, ready to be stored or exported */
  toRun() {
    return {
      meta: this.meta ?? {},
      acceleration: this.acceleration,
      orientation: this.orientation,
      gnss: this.gnss,
      markers: this.markers,
    };
  }

  /**
   * Register a noteworthy location such as a switch, a bridge or a tunnel;
   * these help the maintenance team locate a defect precisely (report §4.1).
   * @param {string} type
   */
  addMarker(type) {
    if (!this.recording) return null;
    const last = this.gnss[this.gnss.length - 1];
    const marker = {
      t: this._elapsed(),
      type,
      lat: last?.lat ?? null,
      lon: last?.lon ?? null,
    };
    this.markers.push(marker);
    return marker;
  }

  _elapsed() {
    return (performance.now() - this.startedAt) / 1000;
  }

  _onMotion(event) {
    if (!this.recording) return;
    // `accelerationIncludingGravity` is the raw sensor output. Pre-processed
    // outputs (linear acceleration) may already have been high-pass filtered by
    // the platform, which also removes the effect of ramps and curves
    // (report §2.1), so the raw signal is stored instead.
    const a = event.accelerationIncludingGravity ?? event.acceleration;
    if (!a) return;
    const sample = {
      t: this._elapsed(),
      vertical: this._project(a, 'vertical'),
      lateral: this._project(a, 'lateral'),
      longitudinal: this._project(a, 'longitudinal'),
      x: a.x ?? 0,
      y: a.y ?? 0,
      z: a.z ?? 0,
    };
    const rotation = event.rotationRate;
    if (rotation) {
      sample.rollRate = rotation.beta ?? 0;
      sample.pitchRate = rotation.alpha ?? 0;
      sample.yawRate = rotation.gamma ?? 0;
    }
    this.acceleration.push(sample);
    this.handlers.onAcceleration?.(sample);
  }

  _project(a, axis) {
    const value = a[this.axisMap[axis]];
    return (typeof value === 'number' ? value : 0) * this.axisSign[axis];
  }

  _onOrientation(event) {
    if (!this.recording) return;
    // The angular positions of the smartphone are stored during the run so that
    // the installation can be checked afterwards (report §2.2).
    this.orientation.push({
      t: this._elapsed(),
      azimuth: event.alpha,
      pitch: event.beta,
      roll: event.gamma,
    });
  }

  _onPosition(position) {
    if (!this.recording) return;
    const c = position.coords;
    const fix = {
      t: this._elapsed(),
      timestamp: position.timestamp,
      lat: c.latitude,
      lon: c.longitude,
      altitude: c.altitude,
      speed: typeof c.speed === 'number' ? c.speed : null,
      heading: c.heading,
      accuracy: c.accuracy,
    };
    this.gnss.push(fix);
    this.handlers.onPosition?.(fix);
  }

  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this._wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (error) {
      // A denied wake lock is not fatal for the measurement.
      this.handlers.onError?.(new Error(`screen wake lock: ${error.message}`));
    }
  }

  _releaseWakeLock() {
    this._wakeLock?.release?.().catch(() => {});
    this._wakeLock = null;
  }

  /**
   * Effective acceleration sampling rate of the run, in Hz.
   * @returns {number}
   */
  effectiveRate() {
    const n = this.acceleration.length;
    if (n < 2) return 0;
    const duration = this.acceleration[n - 1].t - this.acceleration[0].t;
    return duration > 0 ? (n - 1) / duration : 0;
  }
}
