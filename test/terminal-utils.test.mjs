import { test } from "node:test";
import assert from "node:assert/strict";

const {
  sanitizeText,
  sanitizeAnsiLine,
  displayWidth,
  fitLine,
  padDisplay,
  clipFrame,
  classifyConfirmKey,
  buildEditorInvocation,
  shQuote,
  exitCodeForSignal,
  editorExitCode,
  parseTmuxPanes,
  parseTmuxPaneInfo,
  installTerminalGuard,
} = await import("../src/terminal-utils.ts");

test("sanitizeText: strips CSI/OSC and control chars, flattens whitespace", () => {
  assert.equal(sanitizeText("\x1b[31mred\x1b[0m"), "red");
  assert.equal(sanitizeText("\x1b]0;title\x07name"), "name");
  assert.equal(sanitizeText("a\nb\tc\rd"), "a b c d");
  assert.equal(sanitizeText("a\x00b\x07c\x7fd"), "abcd");
  assert.equal(sanitizeText(null), "");
});

test("sanitizeAnsiLine: keeps SGR colors, drops everything else", () => {
  assert.equal(sanitizeAnsiLine("\x1b[31mred\x1b[0m"), "\x1b[31mred\x1b[0m");
  assert.equal(sanitizeAnsiLine("\x1b[2K\x1b[1;36mx\x1b[0m"), "\x1b[1;36mx\x1b[0m");
  assert.equal(sanitizeAnsiLine("a\nb"), "a b");
  assert.equal(sanitizeAnsiLine("x\x1b]0;t\x07y"), "xy");
});

test("displayWidth: ANSI is zero-width, CJK/emoji are wide, combining is zero", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("\x1b[31mabc\x1b[0m"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("😀"), 2);
  assert.equal(displayWidth("é"), 1);
});

test("fitLine: truncates on display width and preserves/reset SGR", () => {
  assert.equal(fitLine("abcdef", 10), "abcdef");
  assert.equal(fitLine("abcdef", 4), "abc…");
  assert.equal(fitLine("中文中文", 5), "中文…");
  const colored = fitLine("\x1b[31mabcdef\x1b[0m", 4);
  assert.ok(colored.startsWith("\x1b[31m"));
  assert.ok(colored.endsWith("\x1b[0m"));
});

test("padDisplay: pads by visible width, not by bytes", () => {
  assert.equal(padDisplay("ab", 4), "ab  ");
  assert.equal(padDisplay("中文", 4), "中文");
  assert.equal(padDisplay("\x1b[31mab\x1b[0m", 4), "ab  ");
});

test("clipFrame: fits the height and keeps the last (notice) line", () => {
  const lines = ["1", "2", "3", "4", "5", "6", "7", "8"];
  assert.deepEqual(clipFrame(lines, 10), lines);
  const clipped = clipFrame(lines, 5); // usable height 4
  assert.equal(clipped.length, 4);
  assert.equal(clipped[clipped.length - 1], "8");
  assert.ok(clipped.some((l) => l.includes("lines hidden")));
  assert.deepEqual(clipFrame(lines, 2), ["1"]);
});

test("classifyConfirmKey: y/Y → yes, Ctrl-C → interrupt, anything else → no", () => {
  assert.equal(classifyConfirmKey("y"), "yes");
  assert.equal(classifyConfirmKey("Y"), "yes");
  assert.equal(classifyConfirmKey("yes"), "yes");
  assert.equal(classifyConfirmKey("n"), "no");
  assert.equal(classifyConfirmKey("\r"), "no");
  assert.equal(classifyConfirmKey(""), "no");
  assert.equal(classifyConfirmKey("\x03"), "interrupt");
});

test("buildEditorInvocation: the file is a positional arg, never interpolated", () => {
  const inv = buildEditorInvocation("code -w", "/tmp/a file $(x)'s.md");
  assert.equal(inv.command, "/bin/sh");
  assert.deepEqual(inv.args.slice(0, 2), ["-c", 'code -w "$@"']);
  assert.equal(inv.args[2], "switch-editor");
  assert.equal(inv.args[3], "/tmp/a file $(x)'s.md");
  assert.equal(buildEditorInvocation("", "/f").args[1], 'vi "$@"');
});

test("shQuote: POSIX single-quote escaping", () => {
  assert.equal(shQuote("/tmp/a b"), "'/tmp/a b'");
  assert.equal(shQuote("a'b"), "'a'\\''b'");
});

test("exitCodeForSignal: 128 + signum", () => {
  assert.equal(exitCodeForSignal("SIGINT"), 130);
  assert.equal(exitCodeForSignal("SIGTERM"), 143);
  assert.equal(exitCodeForSignal("SIGHUP"), 129);
  assert.equal(exitCodeForSignal("NOPE"), 1);
  assert.equal(exitCodeForSignal(null), 1);
});

test("editorExitCode: success 0, non-zero preserved, signal mapped, spawn error 1", () => {
  assert.equal(editorExitCode({ status: 0 }), 0);
  assert.equal(editorExitCode({ status: 2 }), 2);
  assert.equal(editorExitCode({ status: null, signal: "SIGTERM" }), 143);
  assert.equal(editorExitCode({ error: new Error("ENOENT") }), 1);
  assert.equal(editorExitCode({}), 1);
});

test("parseTmuxPanes: /dev prefix, CRLF and dirty lines", () => {
  const map = parseTmuxPanes("/dev/ttys001\tmain\r\n/dev/ttys002\twork\nbadline\n\ttys003\tx\n");
  assert.equal(map.get("ttys001"), "main");
  assert.equal(map.get("ttys002"), "work");
  assert.equal(map.size, 2);
});

test("parseTmuxPaneInfo: pane identity, dirty lines and control chars", () => {
  const map = parseTmuxPaneInfo(
    "/dev/ttys001\tmain\t%1\t0\t0\r\n/dev/ttys002\twork\t%2\t1\t3\nshort\tline\n\n",
  );
  assert.deepEqual(map.get("ttys001"), { session: "main", paneId: "%1", windowIndex: "0", paneIndex: "0" });
  assert.deepEqual(map.get("ttys002"), { session: "work", paneId: "%2", windowIndex: "1", paneIndex: "3" });
  assert.equal(map.size, 2);
  assert.equal(map.has("short"), false);

  const dirty = parseTmuxPaneInfo("/dev/ttys003\t\x1b[31mevil\x1b[0m\t%3\t0\t0\n");
  assert.equal(dirty.get("ttys003").session, "evil");
});

test("installTerminalGuard: signals cleanup and exit; dispose removes listeners", () => {
  const before = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
    hup: process.listenerCount("SIGHUP"),
    exit: process.listenerCount("exit"),
  };
  let cleaned = 0;
  const exits = [];
  const guard = installTerminalGuard({
    cleanup: () => { cleaned++; },
    exit: (code) => exits.push(code),
    stderr: { write: () => {} },
  });
  assert.equal(process.listenerCount("SIGINT"), before.sigint + 1);
  process.emit("SIGINT");
  assert.equal(cleaned, 1);
  assert.deepEqual(exits, [130]);
  guard.dispose();
  assert.equal(process.listenerCount("SIGINT"), before.sigint);
  assert.equal(process.listenerCount("SIGTERM"), before.sigterm);
  assert.equal(process.listenerCount("SIGHUP"), before.hup);
  assert.equal(process.listenerCount("exit"), before.exit);

  // After dispose a second signal is not handled by the guard.
  process.emit("SIGTERM");
  assert.deepEqual(exits, [130]);
});
