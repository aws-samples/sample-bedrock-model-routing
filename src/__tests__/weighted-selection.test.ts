/**
 * Unit tests for weighted-selection utility
 */

import {
  weightedRandomSelect,
  createWeightedItem,
  WeightedItem
} from '../utils/weighted-selection';

describe('weighted-selection', () => {
  describe('createWeightedItem', () => {
    it('should create a weighted item', () => {
      const item = createWeightedItem('test', 100);
      expect(item).toEqual({ item: 'test', weight: 100 });
    });

    it('should create weighted item with zero weight', () => {
      const item = createWeightedItem('test', 0);
      expect(item).toEqual({ item: 'test', weight: 0 });
    });

    it('should work with different types', () => {
      const numItem = createWeightedItem(42, 50);
      expect(numItem).toEqual({ item: 42, weight: 50 });

      const objItem = createWeightedItem({ id: 1 }, 75);
      expect(objItem).toEqual({ item: { id: 1 }, weight: 75 });
    });
  });

  describe('weightedRandomSelect', () => {
    it('should return null for empty array', () => {
      const result = weightedRandomSelect([]);
      expect(result).toBeNull();
    });

    it('should return the single item when only one is available', () => {
      const items: WeightedItem<string>[] = [{ item: 'only', weight: 100 }];
      const result = weightedRandomSelect(items);
      expect(result).toBe('only');
    });

    it('should return null when total weight is zero', () => {
      const items: WeightedItem<string>[] = [
        { item: 'a', weight: 0 },
        { item: 'b', weight: 0 }
      ];
      const result = weightedRandomSelect(items);
      expect(result).toBeNull();
    });

    it('should return null when total weight is negative', () => {
      const items: WeightedItem<string>[] = [
        { item: 'a', weight: -10 },
        { item: 'b', weight: 5 }
      ];
      const result = weightedRandomSelect(items);
      expect(result).toBeNull();
    });

    it('should always select highest weight item when it dominates', () => {
      const items: WeightedItem<string>[] = [
        { item: 'dominant', weight: 10000 },
        { item: 'tiny', weight: 1 }
      ];
      
      // Run multiple times - dominant should be selected almost always
      const results: string[] = [];
      for (let i = 0; i < 100; i++) {
        const result = weightedRandomSelect(items);
        if (result) results.push(result);
      }
      
      const dominantCount = results.filter(r => r === 'dominant').length;
      expect(dominantCount).toBeGreaterThan(95); // Should be >95% of the time
    });

    it('should roughly respect weight distribution', () => {
      // Mock Math.random to test different scenarios
      const items: WeightedItem<string>[] = [
        { item: 'a', weight: 50 },
        { item: 'b', weight: 50 }
      ];

      // With random = 0, should select first item
      jest.spyOn(Math, 'random').mockReturnValue(0);
      expect(weightedRandomSelect(items)).toBe('a');

      // With random = 0.5, should be at the boundary
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      expect(weightedRandomSelect(items)).toBe('a');

      // With random = 0.51, should select second item
      jest.spyOn(Math, 'random').mockReturnValue(0.51);
      expect(weightedRandomSelect(items)).toBe('b');

      jest.restoreAllMocks();
    });

    it('should select items based on weight ratios', () => {
      const items: WeightedItem<string>[] = [
        { item: 'a', weight: 70 },
        { item: 'b', weight: 20 },
        { item: 'c', weight: 10 }
      ];

      // random value 0.6 out of total weight 100 = 60, should hit 'a' (0-70)
      jest.spyOn(Math, 'random').mockReturnValue(0.6);
      expect(weightedRandomSelect(items)).toBe('a');

      // random value 0.75 out of total weight 100 = 75, should hit 'b' (70-90)
      jest.spyOn(Math, 'random').mockReturnValue(0.75);
      expect(weightedRandomSelect(items)).toBe('b');

      // random value 0.95 out of total weight 100 = 95, should hit 'c' (90-100)
      jest.spyOn(Math, 'random').mockReturnValue(0.95);
      expect(weightedRandomSelect(items)).toBe('c');

      jest.restoreAllMocks();
    });
  });

});
