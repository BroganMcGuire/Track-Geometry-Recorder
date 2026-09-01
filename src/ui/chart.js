/**
 * Minimal rolling strip chart drawn on a canvas.
 *
 * Complex visualisation increases the memory usage of the phone and lowers the
 * achievable sampling rate (report §2.3), so the display is deliberately kept
 * to a fixed-size ring buffer with one line per chart.
 */
export class StripChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{capacity?: number, range?: number, colour?: string, label?: string}} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.capacity = options.capacity ?? 600;
    this.range = options.range ?? 4;
    this.colour = options.colour ?? '#2f81f7';
    this.label = options.label ?? '';
    this.values = new Float32Array(this.capacity);
    this.count = 0;
    this.head = 0;
    this._dirty = false;
    this._frame = null;
  }

  /** @param {number} value */
  push(value) {
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this._dirty = true;
    this._schedule();
  }

  /** Clear the buffer. */
  reset() {
    this.count = 0;
    this.head = 0;
    this._dirty = true;
    this._schedule();
  }

  _schedule() {
    if (this._frame !== null) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      if (this._dirty) this.draw();
    });
  }

  /** Redraw the chart. */
  draw() {
    this._dirty = false;
    const { canvas, context } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    // Grid and zero line.
    context.strokeStyle = '#2a3038';
    context.lineWidth = 1;
    context.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = (height * i) / 4;
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.stroke();

    if (this.count > 1) {
      const scale = height / 2 / this.range;
      context.strokeStyle = this.colour;
      context.lineWidth = 1.5;
      context.beginPath();
      const start = (this.head - this.count + this.capacity) % this.capacity;
      for (let i = 0; i < this.count; i++) {
        const value = this.values[(start + i) % this.capacity];
        const x = (i / (this.capacity - 1)) * width;
        const y = height / 2 - Math.max(-this.range, Math.min(this.range, value)) * scale;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }

    if (this.label) {
      context.fillStyle = '#8b949e';
      context.font = '12px system-ui, sans-serif';
      context.fillText(`${this.label}  ±${this.range} m/s²`, 6, 14);
    }
  }
}
