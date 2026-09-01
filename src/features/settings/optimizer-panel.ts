/**
 * The "optimise parameters" control on the deck options page.
 *
 * Runs the fit against the decks that use this preset, yielding between
 * passes so the tab stays responsive.
 */

import { button, el, render } from '../../ui/dom.js';
import { toast } from '../../ui/toast.js';
import type { AppContext } from '../../app/context.js';
import type { DeckConfig } from '../../domain/types.js';
import {
  MIN_REVIEWS_TO_OPTIMIZE,
  buildSequences,
  evaluateLoss,
  optimize,
} from '../../collection/optimize.js';

export function optimizerPanel(
  ctx: AppContext,
  config: DeckConfig,
  onOptimised: (params: number[]) => void,
): HTMLElement {
  const host = el('div.col', { style: { marginTop: '4px' } });
  let running = false;
  let status = '';

  const draw = (): void => {
    render(
      host,
      el('h3', { text: 'Optimise from your review history', style: { marginBottom: '2px' } }),
      el('p.faint', {
        text: 'Fits the weights to the answers you have actually given on the decks using this preset. The result is applied to the field above; press Save to keep it.',
        style: { margin: '0' },
      }),
      el(
        'div.row',
        {},
        button(running ? 'Optimising…' : 'Optimise', () => void run(), {
          disabled: running,
          'data-action': 'optimise',
        }),
        el('span.muted', { 'data-role': 'optimise-status', text: status }),
      ),
    );
  };

  const setStatus = (text: string): void => {
    status = text;
    const node = host.querySelector('[data-role="optimise-status"]');
    if (node) node.textContent = text;
  };

  const run = async (): Promise<void> => {
    running = true;
    draw();
    setStatus('Collecting history…');

    try {
      const decks = (await ctx.db.decks.getAll()).filter((d) => d.configId === config.id);
      const deckIds = new Set(decks.map((d) => d.id));
      const logs = (await ctx.db.reviewLogs.getAll()).filter((log) =>
        deckIds.has(log.snapshot.deckId),
      );

      const sequences = buildSequences(logs);
      const baseline = evaluateLoss(config.params, sequences);

      if (baseline.count < MIN_REVIEWS_TO_OPTIMIZE) {
        running = false;
        draw();
        setStatus(
          `Only ${baseline.count} dated reviews on this preset — at least ${MIN_REVIEWS_TO_OPTIMIZE} are needed before fitting means anything.`,
        );
        return;
      }

      setStatus(`Fitting against ${baseline.count} reviews…`);

      const result = await optimize(sequences, {
        initial: config.params,
        onProgress: async (pass, passes, loss) => {
          setStatus(`Pass ${pass} of ${passes} — log loss ${loss.toFixed(4)}`);
          // Yield to the event loop so the status actually paints.
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      });

      running = false;
      draw();

      if (result.changed === 0) {
        setStatus('Your current parameters already fit this history as well as this can manage.');
        toast('No improvement found — parameters left unchanged.', 'info');
        return;
      }

      onOptimised(result.params);
      const improvement = ((1 - result.finalLoss / result.initialLoss) * 100).toFixed(1);
      setStatus(
        `Log loss ${result.initialLoss.toFixed(4)} → ${result.finalLoss.toFixed(4)} (${improvement}% better), RMSE ${result.initialRmse.toFixed(4)} → ${result.finalRmse.toFixed(4)}, over ${result.reviewsUsed} reviews.`,
      );
      toast('Parameters optimised. Press Save to keep them.', 'success');
    } catch (error) {
      running = false;
      draw();
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  draw();
  return host;
}
