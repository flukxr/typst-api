// Timing helpers for tests that drive long-lived processes.
import { writeFileSync } from "node:fs";

/**
 * Await `promise`, failing with `message` after `ms`. The timer is always
 * cleared, so a settled race never keeps the test process alive.
 */
export async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rewrite a watched Typst file until the returned stop function is called. A
 * single edit can land before the watcher has settled after its initial
 * compile and be missed; repeating it makes recompilation deterministic.
 */
export function keepEditing(path, content, everyMs = 400) {
  let revision = 0;
  const write = () => {
    revision += 1;
    writeFileSync(path, `${content}\n\n// revision ${revision}\n`);
  };
  write();
  const timer = setInterval(write, everyMs);
  return () => clearInterval(timer);
}
