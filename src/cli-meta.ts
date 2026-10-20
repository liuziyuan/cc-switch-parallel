// ─── cli metadata ──────────────────────────────────────────────────────
// Static CLI facts shared by adapters and history. Kept dependency-free so
// history does not have to import the whole adapter graph.

const APP_TYPES = ["claude", "codex"] as const;

interface CliMeta {
  appType: string;
  fullAutoFlag: string;
  permissionArgs(hotkey: string | null | undefined): string[];
  inferHotkeyFromArgs(args: string[]): string | undefined;
}

const CLI_META: Record<string, CliMeta> = {
  claude: {
    appType: "claude",
    fullAutoFlag: "--dangerously-skip-permissions",
    permissionArgs(hotkey) {
      if (hotkey === "2") return ["--permission-mode", "acceptEdits"];
      if (hotkey === "3") return ["--dangerously-skip-permissions"];
      return [];
    },
    // Reverse of permissionArgs for history recording: which permission mode
    // (if any) the forwarded argv carries. Contract: returns undefined when no
    // permission flag is present — never "1"/default, or the same launch would
    // fork two history entries.
    inferHotkeyFromArgs(args) {
      if (args.includes("--dangerously-skip-permissions")) return "3";
      const i = args.indexOf("--permission-mode");
      if (i >= 0 && args[i + 1] === "acceptEdits") return "2";
      if (args.includes("--permission-mode=acceptEdits")) return "2";
      return undefined;
    },
  },
  codex: {
    appType: "codex",
    fullAutoFlag: "--dangerously-bypass-approvals-and-sandbox",
    permissionArgs(hotkey) {
      if (hotkey === "2") return ["--approve-for-me"];
      if (hotkey === "3") return ["--dangerously-bypass-approvals-and-sandbox"];
      return [];
    },
    // See the claude entry for the contract (undefined = no permission flag).
    inferHotkeyFromArgs(args) {
      if (args.includes("--dangerously-bypass-approvals-and-sandbox")) return "3";
      if (args.includes("--approve-for-me")) return "2";
      return undefined;
    },
  },
};

function getCliMeta(cli: string): CliMeta | undefined {
  return CLI_META[cli];
}

export { APP_TYPES, CLI_META, getCliMeta };
export type { CliMeta };
