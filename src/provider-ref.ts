// ─── provider-ref ──────────────────────────────────────────────────────
// Resolve a launch target by id or name without side effects. Names are not
// unique in the cc-switch DB, so callers must surface ambiguity instead of
// silently picking the lowest id.

import { queryProviderById, queryProviderMatches } from "./db.js";

export type ProviderRef = { id?: string | null; name?: string | null };

export function resolveProviderRef(ref: ProviderRef, appType: string):
  | { ok: true; row: any }
  | { ok: false; error: "notFound"; ref: ProviderRef }
  | { ok: false; error: "ambiguous"; matches: any[] } {
  if (ref?.id) {
    const row = queryProviderById(ref.id, appType);
    return row ? { ok: true, row } : { ok: false, error: "notFound", ref };
  }
  const matches = queryProviderMatches(ref?.name || "", appType);
  if (matches.length === 1) return { ok: true, row: matches[0] };
  if (matches.length === 0) return { ok: false, error: "notFound", ref };
  return { ok: false, error: "ambiguous", matches };
}

export function formatAmbiguousProvider(
  name: string,
  appType: string,
  matches: any[],
  cmd: string,
  hint = `switch --id <providerId> ${cmd} [args...]`,
): string {
  const lines = [`✗ Provider name "${name}" is ambiguous (${appType}) — ${matches.length} matches:`];
  for (const m of matches) lines.push(`    ${m.id}  ${m.name}`);
  lines.push(`  Re-run with: ${hint}`);
  lines.push(`  (or rename one provider in cc-switch)`);
  return lines.join("\n");
}
