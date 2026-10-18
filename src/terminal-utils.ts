// ─── terminal-utils (batch D) ─────────────────────────────────────────
// Pure terminal/text helpers shared by the TUI, ps and the editor path.
// No I/O here except the optional process listeners in installTerminalGuard
// (which are injectable for tests).

import { constants as osConstants } from "node:os";

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// C0/C1 minus ESC (the SGR-preserving path handles ESC separately).
const CONTROL_RE = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g;

/** Remove every escape sequence and control character. CR/LF/TAB → space. */
export function sanitizeText(value: any): string {
  return String(value ?? "")
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(CONTROL_RE, "")
    .replace(/\x1b/g, "");
}

/** Remove escape/control chars but KEEP SGR (…m) color sequences. */
export function sanitizeAnsiLine(value: any): string {
  return String(value ?? "")
    .replace(OSC_RE, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (seq) => (seq.endsWith("m") ? seq : ""))
    .replace(/[\r\n\t]/g, " ")
    .replace(CONTROL_RE, "")
    // Stray ESC sequences that did not survive as SGR.
    .replace(/\x1b(?!\[[0-9;]*m)/g, "");
}

function charWidth(cp: number): number {
  // Combining marks, ZWJ, variation selectors, skin-tone modifiers: no width.
  if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 0;
  // East Asian wide / fullwidth and emoji blocks (approximation, stable).
  if (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  )) return 2;
  return 1;
}

/** Display width of the VISIBLE text (ANSI codes count 0). */
export function displayWidth(value: any): number {
  const s = String(value ?? "").replace(OSC_RE, "").replace(CSI_RE, "");
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    width += charWidth(cp);
  }
  return width;
}

/** Truncate to `maxWidth` display columns, preserving SGR and appending … */
export function fitLine(value: any, maxWidth: number): string {
  const s = sanitizeAnsiLine(value);
  const limit = Math.max(0, Math.floor(maxWidth));
  if (limit === 0) return "";
  let width = 0;
  let out = "";
  for (let i = 0; i < s.length;) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
      i++;
      continue;
    }
    const cp = s.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (width + cw > limit - 1) {
      return out + "…" + (out.includes("\x1b[") ? "\x1b[0m" : "");
    }
    out += ch;
    width += cw;
    i += ch.length;
  }
  return out;
}

/** Pad a sanitized cell to `width` display columns. */
export function padDisplay(value: any, width: number): string {
  const s = sanitizeText(value);
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

/**
 * Clamp a frame to the terminal height. `rows-1` is the usable height (the
 * trailing newline scrolls). When over budget keep the first `rows-2` lines,
 * one "hidden" marker, and the LAST line — the confirmation/notice row.
 */
export function clipFrame(lines: string[], rows: number): string[] {
  const max = Math.max(1, Math.floor(rows) - 1);
  if (lines.length <= max) return lines;
  if (max <= 2) return lines.slice(0, max);
  const hidden = lines.length - (max - 1);
  return [...lines.slice(0, max - 2), `… ${hidden} 行未显示 …`, lines[lines.length - 1]];
}

/** Map one raw keypress to the confirmation outcome. EOF is a stream event. */
export function classifyConfirmKey(key: any): "yes" | "no" | "interrupt" {
  const s = String(key ?? "");
  if (s === "\x03") return "interrupt";
  return /^y/i.test(s.trim()) ? "yes" : "no";
}

/**
 * Run an editor command through a shell while keeping the file path out of
 * the command string: the path is the first positional parameter (`$1`), so
 * spaces/quotes/`$()` in it can never be interpreted.
 */
export function buildEditorInvocation(editorCommand: any, file: string) {
  const cmd = String(editorCommand || "").trim() || "vi";
  return { command: "/bin/sh", args: ["-c", `${cmd} "$@"`, "switch-editor", String(file)] };
}

/** POSIX single-quote escaping for shell arguments. */
export function shQuote(path: any): string {
  return `'${String(path).replace(/'/g, "'\\''")}'`;
}

export function exitCodeForSignal(signal: any): number {
  const n = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return typeof n === "number" ? 128 + n : 1;
}

/** Exit status for a spawnSync editor result (error/signal/non-zero). */
export function editorExitCode(result: any): number {
  if (result?.error) return 1;
  if (result?.signal) return exitCodeForSignal(result.signal);
  return typeof result?.status === "number" ? result.status : 1;
}

/** Parse `tmux list-panes -F '#{pane_tty}\t#{session_name}'` output. */
export function parseTmuxPanes(stdout: any): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const tty = sanitizeText(line.slice(0, tab)).replace(/^\/dev\//, "");
    const session = sanitizeText(line.slice(tab + 1));
    if (tty && session) map.set(tty, session);
  }
  return map;
}

type GuardOptions = {
  cleanup: () => void;
  exit?: (code: number) => void;
  stderr?: { write: (s: string) => void };
};

/**
 * Install process-level terminal guards for the lifetime of a TUI session.
 * `dispose()` removes every listener: leaving a SIGINT handler behind would
 * hijack the CLI launched right after the TUI exits.
 */
export function installTerminalGuard({ cleanup, exit = (code) => process.exit(code), stderr = process.stderr }: GuardOptions) {
  let active = true;
  let disposed = false;
  const onExit = () => { if (active) cleanup(); };
  const signal = (code: number) => () => {
    if (!active) return;
    active = false;
    cleanup();
    exit(code);
  };
  const onSigint = signal(130);
  const onSigterm = signal(143);
  const onSighup = signal(129);
  const onUncaught = (err: any) => {
    if (!active) return;
    active = false;
    cleanup();
    stderr.write(`✗ ${err?.message || String(err)}\n`);
    exit(1);
  };
  process.on("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  process.on("uncaughtException", onUncaught);
  return {
    dispose() {
      // Always remove the listeners, even after a handler fired: tests (and
      // any caller that substitutes `exit`) keep running after a signal.
      if (disposed) return;
      disposed = true;
      active = false;
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGHUP", onSighup);
      process.removeListener("uncaughtException", onUncaught);
    },
  };
}
