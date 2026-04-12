// ControllerHud — controller-side HUD on the game screen.
// Shows the player's name. Lap text is intentionally not rendered (the
// display is the source of truth for lap progression).

export class ControllerHud {
  private nameEl = document.getElementById('hud-name')!;

  setIdentity(name: string, color: string): void {
    this.nameEl.textContent = name;
    this.nameEl.setAttribute('style', `color:${color}`);
  }
}
