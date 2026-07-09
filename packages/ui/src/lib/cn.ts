import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * className combiner: clsx conditional join + tailwind-merge dedupe. The
 * last-wins merge on conflicting utilities is what lets restyled components
 * layer token classes over a primitive's base variant classes safely.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
