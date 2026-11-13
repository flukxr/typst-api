import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CAPABILITY_REGISTRY as GENERATED_REGISTRY } from "./registry.generated.js";
import type { VerifiedCapabilityRegistry } from "./types.js";

/**
 * Load the capability registry from a data file.
 *
 * The committed `data/capabilities.seed.json` ships in the package tarball and
 * is preferred at runtime so a new Typst release can be covered by a data-only
 * update (no code release). When the file is absent, unreadable, or fails the
 * structural checks below, the compiled registry remains the deterministic
 * fallback. The full schema is validated at build time (`npm run validate:data`);
 * this loader only performs the checks required to select a usable verified
 * registry. Results are loaded once per process and cached by the module.
 */
export function loadCapabilityRegistry(
  seedPath?: string,
): VerifiedCapabilityRegistry {
  if (seedPath === undefined) return GENERATED_REGISTRY;
  try {
    const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as unknown;
    return isVerifiedRegistry(parsed) ? parsed : GENERATED_REGISTRY;
  } catch {
    return GENERATED_REGISTRY;
  }
}

function isVerifiedRegistry(
  value: unknown,
): value is VerifiedCapabilityRegistry {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "verified") return false;
  if (
    candidate.features === null ||
    typeof candidate.features !== "object" ||
    Array.isArray(candidate.features)
  ) {
    return false;
  }
  if (
    candidate.verification === null ||
    typeof candidate.verification !== "object" ||
    Array.isArray(candidate.verification)
  ) {
    return false;
  }
  if (typeof candidate.checkedAt !== "string") return false;
  if (typeof candidate.warning !== "string") return false;
  return true;
}

/**
 * The packaged seed path, overridable through the environment for consumers
 * that bundle their own registry data.
 */
const DEFAULT_SEED_PATH = fileURLToPath(
  new URL("../../data/capabilities.seed.json", import.meta.url),
);

/**
 * The runtime registry used by capabilities resolution and version gates. It
 * prefers the shipped `data/capabilities.seed.json` and falls back to the
 * compiled registry when that file is unavailable or invalid.
 */
export const CAPABILITY_REGISTRY: VerifiedCapabilityRegistry =
  loadCapabilityRegistry(
    process.env.TYPST_API_CAPABILITY_REGISTRY ?? DEFAULT_SEED_PATH,
  );

export type CapabilityName = keyof typeof GENERATED_REGISTRY.features;
