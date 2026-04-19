// Hud — per-viewport HUD overlay drawn with DOM elements positioned over
// each split-screen viewport. Cheap, easy to style, no Three.js text mess.

import type { SplitScreen } from './SplitScreen';
import type { RaceSim } from './RaceSim';

export class Hud {
  layer: HTMLElement;
  split: SplitScreen;
  divs: HTMLDivElement[] = [];
  // Per-viewport disconnect overlay, keyed by car index in split.cars.
  private disconnectDivs: HTMLDivElement[] = [];
  private joinUrl: string | null = null;

  constructor(layer: HTMLElement, split: SplitScreen) {
    this.layer = layer;
    this.split = split;
    this.layer.innerHTML = '';
    for (let i = 0; i < this.split.cameras.length; i++) {
      const div = document.createElement('div');
      div.className = 'viewport-hud';
      div.innerHTML = `
        <div class="name"></div>
        <div class="lap"></div>
        <div class="place"></div>
        <div class="speed"></div>
        <div class="drift" style="display:none;color:#ff0;font-weight:bold;font-size:1.5em">DRIFT</div>
      `;
      this.layer.appendChild(div);
      this.divs.push(div);

      // Disconnect overlay — hidden by default.
      const dc = document.createElement('div');
      dc.className = 'viewport-disconnect hidden';
      dc.innerHTML = `
        <canvas class="viewport-disconnect-qr" width="160" height="160"></canvas>
        <div class="viewport-disconnect-text">DISCONNECTED</div>
        <div class="viewport-disconnect-hint">Scan to rejoin</div>
      `;
      this.layer.appendChild(dc);
      this.disconnectDivs.push(dc);
    }
  }

  setJoinUrl(url: string): void {
    this.joinUrl = url;
  }

  // Show the disconnect overlay on a specific car's viewport.
  setDisconnected(carId: number, disconnected: boolean, clientId?: string): void {
    const idx = this.split.cars.findIndex((c) => c.carId === carId);
    if (idx < 0) return;
    const dc = this.disconnectDivs[idx];
    if (!dc) return;
    dc.classList.toggle('hidden', !disconnected);
    if (disconnected) this.renderQR(dc, clientId);
  }

  private renderQR(dc: HTMLDivElement, clientId?: string): void {
    if (!this.joinUrl) return;
    // Append ?rejoin=<clientId> so the controller reconnects with the same
    // identity and the relay re-associates it with the existing player slot.
    const url = clientId
      ? this.joinUrl + '?rejoin=' + encodeURIComponent(clientId)
      : this.joinUrl;
    const canvas = dc.querySelector('.viewport-disconnect-qr') as HTMLCanvasElement | null;
    if (!canvas || canvas.dataset.rendered === url) return;
    canvas.dataset.rendered = url;
    fetch(`/api/qr?text=${encodeURIComponent(url)}`)
      .then((r) => r.json())
      .then((qr: { size: number; modules: number[] }) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        const scale = Math.floor(Math.min(w, h) / qr.size);
        const offset = Math.floor((w - scale * qr.size) / 2);
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'black';
        for (let row = 0; row < qr.size; row++) {
          for (let col = 0; col < qr.size; col++) {
            if (qr.modules[row * qr.size + col]) {
              ctx.fillRect(offset + col * scale, offset + row * scale, scale, scale);
            }
          }
        }
      })
      .catch(() => { /* QR fetch failed — overlay still shows text */ });
  }

  update(sim: RaceSim): void {
    const layouts = this.split.cssLayouts();
    const totalLaps = sim.totalLaps;

    // Compute live placement: sort by lap, then last checkpoint, then -distance to next.
    const sorted = sim.cars
      .slice()
      .sort((a, b) => {
        if (a.lap !== b.lap) return b.lap - a.lap;
        return b.lastCheckpointIndex - a.lastCheckpointIndex;
      });
    const placeByCarId = new Map<number, number>();
    sorted.forEach((c, i) => placeByCarId.set(c.carId, i + 1));

    for (let i = 0; i < this.split.cars.length; i++) {
      const car = this.split.cars[i];
      const v = layouts[i];
      const div = this.divs[i];
      div.style.left = v.x + 'px';
      div.style.top = v.y + 'px';

      // Position the disconnect overlay to cover this viewport.
      const dc = this.disconnectDivs[i];
      if (dc) {
        dc.style.left = v.x + 'px';
        dc.style.top = v.y + 'px';
        dc.style.width = v.w + 'px';
        dc.style.height = v.h + 'px';
      }

      const lap = Math.max(1, Math.min(totalLaps, car.lap));
      const place = placeByCarId.get(car.carId) || 1;
      const kmh = (car.speed * 3.6).toFixed(0);

      div.querySelector('.name')!.textContent = car.name;
      div.querySelector('.lap')!.textContent = `LAP ${lap}/${totalLaps}`;
      div.querySelector('.place')!.textContent = `P${place}/${sim.cars.length}`;
      div.querySelector('.speed')!.textContent = `${kmh} km/h`;
      const driftEl = div.querySelector('.drift') as HTMLElement | null;
      if (driftEl) driftEl.style.display = car.isDrifting ? 'block' : 'none';
    }
  }
}
