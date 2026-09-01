/**
 * Everything that tunes scheduling for one deck. Storage owns persistence;
 * this module only defines the shape and the defaults.
 */

import { DEFAULT_PARAMS, type Params } from './params.js';

export interface FsrsConfig {
  /** The 21 FSRS-6 weights. */
  params: Params;
  /** Target recall probability at review time, 0.7..0.99. */
  desiredRetention: number;
  /** Learning steps for new cards, in minutes. Empty = graduate immediately. */
  learningSteps: number[];
  /** Relearning steps after a lapse, in minutes. Empty = no relearning. */
  relearningSteps: number[];
  /** Hard ceiling on any interval, in days. */
  maximumInterval: number;
  /** Spread due dates slightly so same-day batches do not pile up forever. */
  enableFuzz: boolean;
}

export const DEFAULT_CONFIG: FsrsConfig = Object.freeze({
  params: DEFAULT_PARAMS,
  desiredRetention: 0.9,
  learningSteps: [1, 10],
  relearningSteps: [10],
  maximumInterval: 36500,
  enableFuzz: true,
}) as FsrsConfig;

export function withDefaults(partial: Partial<FsrsConfig> | null | undefined): FsrsConfig {
  return {
    ...DEFAULT_CONFIG,
    learningSteps: [...DEFAULT_CONFIG.learningSteps],
    relearningSteps: [...DEFAULT_CONFIG.relearningSteps],
    ...(partial ?? {}),
  };
}
