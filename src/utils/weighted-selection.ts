/**
 * Weighted random selection utilities for model selection
 */

/**
 * Item interface for weighted selection
 */
export interface WeightedItem<T> {
  item: T;
  weight: number;
}

/**
 * Performs weighted random selection from a list of items
 * @param items Array of weighted items
 * @returns Selected item, or null if no items available
 */
export function weightedRandomSelect<T>(items: WeightedItem<T>[]): T | null {
  if (items.length === 0) {
    return null;
  }

  // Calculate total weight
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  
  if (totalWeight <= 0) {
    return null;
  }

  // Generate random number between 0 and totalWeight
  const randomValue = Math.random() * totalWeight;
  
  // Find the selected item
  let currentWeight = 0;
  for (const item of items) {
    currentWeight += item.weight;
    if (randomValue <= currentWeight) {
      return item.item;
    }
  }

  // Fallback to last item (should not happen with proper weights)
  return items[items.length - 1]?.item ?? null;
}


/**
 * Creates a weighted item
 * @param item The item
 * @param weight The weight
 * @returns WeightedItem
 */
export function createWeightedItem<T>(item: T, weight: number): WeightedItem<T> {
  return { item, weight };
} 