// The background schedulers, apart from the screens they belong to.
//
// App calls both hooks on every start, whatever screen is showing -- which used
// to make RecipesScreen and EvalsScreen part of the first bundle just so two
// hooks could exist. The decision "is anything due?" needs only the small UMD
// libraries; the screen module (which knows how to run a recipe or a suite) is
// fetched the first time something is actually due. On most starts that is
// never, and the screens stay in their own lazy chunks.
import { useEffect } from 'react';
import { pushToast } from './components/Toasts';
// recipes.js first: evals.js reads its scheduling rule (nextRun) off the global.
import './recipes.js';
import './evals.js';

const recipesLib: typeof import('./recipes.js') = (globalThis as any).FreeAI4URecipes;
const evals: typeof import('./evals.js') = (globalThis as any).FreeAI4UEvals;

/** While the app runs: once a minute, run whatever recipes are due (recipes.js nextRun). */
export function useRecipeScheduler() {
  useEffect(() => {
    const running = new Set<string>();
    const tick = () => {
      const now = Date.now();
      const due = recipesLib.dueRecipes(recipesLib.list(), recipesLib.lastRuns(), now)
        .filter((recipe) => !running.has(recipe.id));
      if (!due.length) return;
      for (const recipe of due) {
        running.add(recipe.id);
        // Stamped before the reply, so a slow model is not started twice.
        recipesLib.recordRun(recipe.id, { at: now, ok: true });
      }
      import('./screens/RecipesScreen')
        .then(({ runRecipeInBackground }) => {
          for (const recipe of due) {
            runRecipeInBackground(recipe, {}, now).finally(() => running.delete(recipe.id));
          }
        })
        .catch((e: unknown) => {
          due.forEach((recipe) => running.delete(recipe.id));
          pushToast('error', `Scheduled recipes could not start: ${String((e as Error)?.message || e)}`);
        });
    };
    const first = setTimeout(tick, 5000);
    const timer = setInterval(tick, 60000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);
}

/** While the app runs: once a minute, run the eval suite if its schedule is due (evals.js nextEvalRun). */
export function useEvalScheduler() {
  useEffect(() => {
    let starting = false;
    const tick = () => {
      if (starting) return;
      const schedule = evals.readSchedule();
      const now = Date.now();
      const next = evals.nextEvalRun(schedule, schedule.lastRunAt, now);
      if (next == null || next > now) return;
      starting = true;
      import('./screens/EvalsScreen')
        .then(({ suiteRunning, runScheduledEvals }) => {
          if (suiteRunning()) return; // a run is in progress; the next tick picks it up
          // Stamped before the replies, so a slow suite is not started twice.
          evals.writeSchedule({ ...schedule, lastRunAt: now });
          runScheduledEvals(schedule, now).catch((e: unknown) => pushToast('error', `Scheduled evals failed: ${String((e as Error)?.message || e)}`));
        })
        .catch((e: unknown) => pushToast('error', `Scheduled evals failed: ${String((e as Error)?.message || e)}`))
        .finally(() => { starting = false; });
    };
    const first = setTimeout(tick, 5000);
    const timer = setInterval(tick, 60000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);
}
