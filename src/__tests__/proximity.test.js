import { describe, it, expect } from 'vitest';
import {
  EARSHOT_RADIUS_PX,
  pctToPixels,
  pixelDistance,
  proximityStrength,
  isWithinEarshot
} from '../utils/collision';

describe('Proximity Detection', () => {
  describe('pixelDistance', () => {
    it('returns 0 for identical positions', () => {
      const person = { x: 50, y: 50 };
      const distance = pixelDistance(person, person, 800, 600);
      expect(distance).toBe(0);
    });

    it('calculates correct distance for known positions', () => {
      const personA = { x: 0, y: 0 };
      const personB = { x: 100, y: 0 };
      // 100% of 800px width = 800px distance
      const distance = pixelDistance(personA, personB, 800, 600);
      expect(distance).toBe(800);
    });

    it('handles diagonal distance correctly', () => {
      const personA = { x: 0, y: 0 };
      const personB = { x: 100, y: 100 };
      // Diagonal: sqrt(800^2 + 600^2) = sqrt(640000 + 360000) = sqrt(1000000) = 1000
      const distance = pixelDistance(personA, personB, 800, 600);
      expect(distance).toBe(1000);
    });
  });

  describe('isWithinEarshot', () => {
    it('returns true for distance of 0 (identical positions)', () => {
      expect(isWithinEarshot(0)).toBe(true);
    });

    it('returns true for distance of 60px (within earshot)', () => {
      expect(isWithinEarshot(60)).toBe(true);
    });

    it('returns true for exactly 100px (inclusive boundary)', () => {
      expect(isWithinEarshot(100)).toBe(true);
    });

    it('returns false for distance of 101px (outside earshot)', () => {
      expect(isWithinEarshot(101)).toBe(false);
    });

    it('returns false for distances greater than 100px', () => {
      expect(isWithinEarshot(150)).toBe(false);
      expect(isWithinEarshot(200)).toBe(false);
    });
  });

  describe('proximityStrength', () => {
    it('returns 100% at distance 0', () => {
      expect(proximityStrength(0)).toBe(100);
    });

    it('returns 0% at or beyond earshot radius', () => {
      expect(proximityStrength(100)).toBe(0);
      expect(proximityStrength(101)).toBe(0);
      expect(proximityStrength(200)).toBe(0);
    });

    it('calculates correct strength at midpoint (50px)', () => {
      // At 50px: 100 * (1 - 50/100) = 50%
      expect(proximityStrength(50)).toBe(50);
    });

    it('calculates correct strength at 25px', () => {
      // At 25px: 100 * (1 - 25/100) = 75%
      expect(proximityStrength(25)).toBe(75);
    });

    it('calculates correct strength at 75px', () => {
      // At 75px: 100 * (1 - 75/100) = 25%
      expect(proximityStrength(75)).toBe(25);
    });

    it('stays within 0-100% range for all inputs', () => {
      for (let d = -10; d <= 150; d += 5) {
        const strength = proximityStrength(d);
        expect(strength).toBeGreaterThanOrEqual(0);
        expect(strength).toBeLessThanOrEqual(100);
      }
    });

    it('handles negative distances gracefully (returns 100%)', () => {
      expect(proximityStrength(-10)).toBe(100);
      expect(proximityStrength(-100)).toBe(100);
    });
  });

  describe('pctToPixels', () => {
    it('converts 0% to 0 pixels', () => {
      expect(pctToPixels(0, 0, 800, 600)).toEqual({ x: 0, y: 0 });
    });

    it('converts 100% to full dimensions', () => {
      expect(pctToPixels(100, 100, 800, 600)).toEqual({ x: 800, y: 600 });
    });

    it('converts 50% to half dimensions', () => {
      expect(pctToPixels(50, 50, 800, 600)).toEqual({ x: 400, y: 300 });
    });

    it('handles different floor dimensions', () => {
      expect(pctToPixels(25, 75, 1000, 800)).toEqual({ x: 250, y: 600 });
    });
  });
});
