import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { routeRecallByAge } from '../lib/routing.ts';

describe('routeRecallByAge', () => {
  it('routes fork when the turn end lies inside the window', () => {
    assert.equal(routeRecallByAge({ turn: 5, endTime: 990000, newestTurn: 5, now: 1000000, recentWindowMs: 20000 }), 'fork');
  });

  it('routes fork exactly at the window boundary (<=)', () => {
    assert.equal(routeRecallByAge({ turn: 5, endTime: 980000, newestTurn: 5, now: 1000000, recentWindowMs: 20000 }), 'fork');
  });

  it('routes subagent just outside the window', () => {
    assert.equal(routeRecallByAge({ turn: 5, endTime: 979999, newestTurn: 5, now: 1000000, recentWindowMs: 20000 }), 'subagent');
  });

  it('routes subagent for a far older turn', () => {
    assert.equal(routeRecallByAge({ turn: 2, endTime: 500000, newestTurn: 8, now: 1000000, recentWindowMs: 20000 }), 'subagent');
  });

  it('no timestamp: newest and newest-2 stay fork, newest-3 goes subagent', () => {
    const base = { endTime: undefined, newestTurn: 8, now: 1000000, recentWindowMs: 20000 } as const;
    assert.equal(routeRecallByAge({ ...base, turn: 8 }), 'fork');
    assert.equal(routeRecallByAge({ ...base, turn: 6 }), 'fork');
    assert.equal(routeRecallByAge({ ...base, turn: 5 }), 'subagent');
  });

  it('no timestamp and unknown newest (0) still forks', () => {
    assert.equal(routeRecallByAge({ turn: 1, endTime: undefined, newestTurn: 0, now: 1000000, recentWindowMs: 20000 }), 'fork');
  });
});