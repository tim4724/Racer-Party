import { describe, expect, test } from 'bun:test';
import { MSG, ROOM_STATE, PLAYER_COLORS, RELAY_URL } from '@shared/protocol';

describe('protocol constants', () => {
  test('RELAY_URL points at the production relay', () => {
    expect(RELAY_URL).toBe('wss://ws.couch-games.com');
  });

  test('MSG namespace contains expected message types', () => {
    expect(MSG.HELLO).toBe('hello');
    expect(MSG.INPUT).toBe('input');
    expect(MSG.WELCOME).toBe('welcome');
    expect(MSG.RACE_START).toBe('race_start');
    expect(MSG.RACE_END).toBe('race_end');
    expect(MSG.LAP_UPDATE).toBe('lap_update');
    expect(MSG.PING).toBe('ping');
    expect(MSG.PONG).toBe('pong');
  });

  test('ROOM_STATE has the four expected states', () => {
    const got = (Object.values(ROOM_STATE) as string[]).sort();
    expect(got).toEqual(['countdown', 'finished', 'lobby', 'racing']);
  });

  test('PLAYER_COLORS has 4 distinct entries', () => {
    expect(PLAYER_COLORS.length).toBe(4);
    expect(new Set(PLAYER_COLORS).size).toBe(4);
    for (const c of PLAYER_COLORS) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test('MSG values are unique', () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });

  test('MSG.ERROR exists for display rejection of late joiners', () => {
    expect(MSG.ERROR).toBe('error');
  });

  test('MSG.PAUSE_GAME / RESUME_GAME / RETURN_TO_LOBBY exist', () => {
    expect(MSG.PAUSE_GAME).toBe('pause_game');
    expect(MSG.RESUME_GAME).toBe('resume_game');
    expect(MSG.RETURN_TO_LOBBY).toBe('return_to_lobby');
  });
});
