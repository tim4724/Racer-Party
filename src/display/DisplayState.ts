// Global mutable state for the display side, kept out of DisplayGame to make
// it easy to inspect from helpers and tests.

import type { Player } from './DisplayConnection';

export class DisplayState {
  // Map<clientId, Player>
  players = new Map<string, Player>();
  // Insertion order (mirrors join order; used to assign cars to viewports).
  playerOrder: string[] = [];
  // The room code returned by Party-Sockets after `create`.
  roomCode: string | null = null;
  // The full join URL, e.g. http://192.168.1.10:4000/ABCD
  joinUrl: string | null = null;
  // Override for the LAN IP base URL (fetched from /api/baseurl on localhost).
  baseUrlOverride: string | null = null;
}
