// Hud — per-viewport HUD overlay drawn with DOM elements positioned over
// each split-screen viewport. Cheap, easy to style, no Three.js text mess.

import type { SplitScreen } from './SplitScreen';
import type { RaceSim } from './RaceSim';

export class Hud {
  layer: HTMLElement;
  split: SplitScreen;
  divs: HTMLDivElement[] = [];

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
      `;
      this.layer.appendChild(div);
      this.divs.push(div);
    }
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

      const lap = Math.max(1, Math.min(totalLaps, car.lap));
      const place = placeByCarId.get(car.carId) || 1;
      const kmh = (car.speed * 3.6).toFixed(0);

      div.querySelector('.name')!.textContent = car.name;
      div.querySelector('.lap')!.textContent = `LAP ${lap}/${totalLaps}`;
      div.querySelector('.place')!.textContent = `P${place}/${sim.cars.length}`;
      div.querySelector('.speed')!.textContent = `${kmh} km/h`;
    }
  }
}
