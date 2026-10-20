// ─── redact ────────────────────────────────────────────────────────────
// Output-only masking for dry-run. Values are never rewritten in place; the
// caller renders a redacted copy so the real config handed to the CLI is
// untouched.

import { isPlainObject } from "./json-utils.js";
import { isSensitiveConfigKey, isSensitiveConfigPath } from "./upward.js";

type RedactOptions = { showSecrets?: boolean };

function redactSecrets(value: any, opts: RedactOptions = {}): any {
  if (opts.showSecrets) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, opts));
  if (!isPlainObject(value)) return value;
  const out: any = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitiveConfigKey(key) ? "***" : redactSecrets(val, opts);
  }
  return out;
}

// A diff leaf carries its own key segments; mask the whole leaf when any
// segment names a credential (same rule the smart split uses).
function redactAtPath(value: any, segments: string[] | null, opts: RedactOptions = {}): any {
  if (opts.showSecrets) return value;
  const sensitive =
    Array.isArray(segments) && segments.length ? isSensitiveConfigPath("", segments) : false;
  return sensitive ? "***" : value;
}

const SECRET_ARG_FLAGS = [
  "--api-key",
  "--apikey",
  "--access-key",
  "--token",
  "--secret",
  "--password",
  "--passwd",
  "--auth",
  "--bearer",
];

function redactArgv(args: string[], opts: RedactOptions = {}): string[] {
  if (opts.showSecrets) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    if (eq > 0 && SECRET_ARG_FLAGS.includes(a.slice(0, eq).toLowerCase())) {
      out.push(`${a.slice(0, eq)}=***`);
      continue;
    }
    if (SECRET_ARG_FLAGS.includes(a.toLowerCase())) {
      out.push(a);
      if (i + 1 < args.length) {
        out.push("***");
        i++;
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

export { redactArgv, redactAtPath, redactSecrets };
