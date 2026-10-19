// ─── Node.js runtime floor ─────────────────────────────────────────────
// The CLI needs Node 18+ at runtime: the statusline usage segment calls the
// global fetch() added in Node 18, and its failure is swallowed, so an older
// runtime silently loses the balance segment instead of reporting an error.
// bin/cc-launch.mjs checks this before loading src/main.js and exits with the
// message below, which turns that silent downgrade into one actionable line.

export const MIN_NODE_MAJOR = 18;

// process.versions.node has no leading "v", but accept one anyway: the same
// value can arrive from nvm/volta output or a user-provided string.
export function nodeMajorVersion(version: string): number {
  const match = /^v?(\d+)/.exec(String(version).trim());
  return match ? Number(match[1]) : 0;
}

export function isNodeVersionSupported(version: string): boolean {
  return nodeMajorVersion(version) >= MIN_NODE_MAJOR;
}

export function unsupportedNodeVersionMessage(version: string): string {
  return [
    `✗ switch requires Node.js >= ${MIN_NODE_MAJOR} (current: v${String(version).trim().replace(/^v/, "")}).`,
    `  The statusline usage segment uses the global fetch API, which Node.js ${MIN_NODE_MAJOR}+ provides.`,
    "  Upgrade Node and retry, e.g. `nvm install 22 && nvm alias default 22`.",
  ].join("\n");
}
