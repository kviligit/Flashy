/**
 * FSRS-6 parameters and their valid ranges.
 *
 * The 21 weights are what the optimiser tunes against a user's review
 * history. Until then the defaults — taken from the reference
 * implementation (open-spaced-repetition/fsrs-rs) — are used, which are
 * fitted against a very large public review dataset.
 */

export type Params = readonly number[];

/** Number of weights in FSRS-6. */
export const PARAM_COUNT = 21;

/** Default decay, i.e. `w[20]`. */
export const FSRS6_DEFAULT_DECAY = 0.1542;

export const DEFAULT_PARAMS: Params = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
  0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, FSRS6_DEFAULT_DECAY,
]);

/** Stability, in days, is clamped to this range. */
export const S_MIN = 0.001;
export const S_MAX = 36500;
/** Difficulty is clamped to this range. */
export const D_MIN = 1;
export const D_MAX = 10;
/** Upper bound on the four initial-stability weights. */
export const INIT_S_MAX = 100;

/**
 * Per-weight `[min, max]`. Mirrors the reference clipper, with the two
 * short-term weights (17, 18) given their fixed ceiling of 2 — the
 * reference tightens that during training based on the relearning-step
 * count, which only matters while fitting, not while scheduling.
 */
export const PARAM_BOUNDS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [S_MIN, INIT_S_MAX],
  [S_MIN, INIT_S_MAX],
  [S_MIN, INIT_S_MAX],
  [S_MIN, INIT_S_MAX],
  [D_MIN, D_MAX],
  [0.001, 4.0],
  [0.001, 4.0],
  [0.001, 0.75],
  [0.0, 4.5],
  [0.0, 0.8],
  [0.001, 3.5],
  [0.001, 5.0],
  [0.001, 0.25],
  [0.001, 0.9],
  [0.0, 4.0],
  [0.0, 1.0],
  [1.0, 6.0],
  [0.0, 2.0],
  [0.0, 2.0],
  [0.01, 0.8],
  [0.1, 0.8],
] as ReadonlyArray<readonly [number, number]>);

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp every weight into its valid range. Does not mutate the input. */
export function clipParams(params: Params): number[] {
  return PARAM_BOUNDS.map(([lo, hi], i) => clamp(params[i] ?? DEFAULT_PARAMS[i]!, lo, hi));
}

export interface ParamProblem {
  index: number;
  message: string;
}

/**
 * Check a user-supplied parameter list. Returns the problems found; an
 * empty array means the list is usable as-is.
 */
export function validateParams(params: Params): ParamProblem[] {
  const problems: ParamProblem[] = [];
  if (params.length !== PARAM_COUNT) {
    problems.push({ index: -1, message: `expected ${PARAM_COUNT} parameters, got ${params.length}` });
    return problems;
  }
  for (const [i, w] of params.entries()) {
    const [lo, hi] = PARAM_BOUNDS[i]!;
    if (!Number.isFinite(w)) problems.push({ index: i, message: `w[${i}] is not a finite number` });
    else if (w < lo || w > hi) {
      problems.push({ index: i, message: `w[${i}] = ${w} is outside [${lo}, ${hi}]` });
    }
  }
  return problems;
}

/**
 * Accept anything and return a usable parameter list: the input when it is
 * valid, the input clipped when it is merely out of range, or the defaults
 * when it is the wrong shape.
 */
export function coerceParams(params: Params | null | undefined): number[] {
  if (!params || params.length !== PARAM_COUNT) return [...DEFAULT_PARAMS];
  if (params.some((w) => !Number.isFinite(w))) return [...DEFAULT_PARAMS];
  return clipParams(params);
}
