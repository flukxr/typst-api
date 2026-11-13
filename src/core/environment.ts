/**
 * Environment layering shared by the client and command layers.
 *
 * A process environment is built by layering an override object on top of a
 * base environment. `"merge"` starts from the base; `"replace"` starts from an
 * empty object. On Windows, case-insensitive matching folds keys before lookup.
 */
export function applyEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  overrides: NodeJS.ProcessEnv | undefined,
  mode: "merge" | "replace",
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  if (mode === "merge") {
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) result[key] = value;
    }
  }
  if (overrides === undefined) return result;

  for (const [key, value] of Object.entries(overrides)) {
    const matchingKey =
      process.platform === "win32" ? findEnvironmentKey(result, key) : key;
    if (value === undefined) {
      if (matchingKey !== undefined) delete result[matchingKey];
      continue;
    }
    if (matchingKey !== undefined && matchingKey !== key)
      delete result[matchingKey];
    result[key] = value;
  }
  return result;
}

function findEnvironmentKey(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const folded = key.toUpperCase();
  return Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === folded,
  );
}
