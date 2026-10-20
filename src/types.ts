// Shared domain types for the split modules.

export type JsonObject = Record<string, any>;

/** One leaf-level difference between two settings trees. */
export interface SettingsChange {
  path: string;
  op: "add" | "remove" | "change";
  from: unknown;
  to: unknown;
  /**
   * The REAL key sequence of `path` in the source tree. `path` joins keys with
   * dots for display, so a key that itself contains dots (Codex
   * `[profiles."my.profile"]`, `[hooks.state."/abs/path:..."]`) is ambiguous
   * when re-parsed. Consumers that WRITE a patch must use these segments.
   */
  segments?: string[];
}

/** A provider row as it comes out of the cc-switch DB. */
export interface ProviderRow {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  category: string | null;
  meta: string;
  is_current?: number | boolean;
  sort_index?: number;
  [key: string]: any;
}

/** One launch-history entry (launch_history.json). */
export interface HistoryEntry {
  cli: string;
  providerId?: string | null;
  providerName?: string;
  hotkey?: string | null;
  extraArgs?: string[];
  ts?: number;
  [key: string]: any;
}

/** Parsed launch_history.json. */
export interface HistoryFile {
  version?: number;
  entries?: HistoryEntry[];
  order?: (string | null)[];
  pins?: Record<string, unknown>;
  [key: string]: any;
}

/** The subset of live-state.json this CLI reads (fail-open). */
export interface StackState {
  enabled?: boolean;
  baseUrl?: string;
  [key: string]: any;
}

/** One doctor check line. */
export interface DoctorCheck {
  label: string;
  pass: boolean;
  detail: string;
  /** Reserved for `doctor --fix`: only whitelisted checks may self-heal. */
  fixable?: boolean;
  fixId?: string;
}

/** One `doctor --fix` action result. */
export interface DoctorFixResult {
  fixId: string;
  label: string;
  status: "fixed" | "failed";
  detail: string;
}

/** App keys supported by the adapter table. */
export type AppKey = "claude" | "codex";

// The adapter capability surface. Method parameters are deliberately `any`
// while the noImplicitAny pass is in progress: the point of this interface is
// to give the APP_ADAPTERS object literal a context type (killing TS7006)
// without pretending the per-app config shapes are uniform yet.
export interface AppAdapter {
  appType: string;
  label: string;
  displayName: string;
  bin: string;
  envVar: string;
  commonConfigKey: string;
  instanceSettingsFileName?: string;
  fullAutoFlag: string;
  setupInstance(providerId: any): any;
  prepare(...args: any[]): any;
  launch(...args: any[]): any;
  permissionArgs(hotkey: any): any;
  inferHotkeyFromArgs(args: any): any;
  readInstancePluginState?(instanceDir: any): any;
  readInstanceSettingsSnapshot?(instanceDir: any): any;
  computeEffectiveSettings?(...args: any[]): any;
  parseCommonSnippet?(text: any): any;
  providerDocFromSettingsConfig?(settingsConfigObj: any): any;
  channelOwnedPath?(...args: any[]): any;
  runtimeStatePath?(...args: any[]): any;
  instructions?: {
    fileName: string;
    globalPath(): string;
    missingGlobalWarn(...args: any[]): any;
    buildTemplate(...args: any[]): any;
    refreshSnapshot?(...args: any[]): any;
    [key: string]: any;
  };
  detectPluginDrift?(state: any): any;
  detectSettingsDrift?(...args: any[]): any;
  syncSettingsBack?(...args: any[]): any;
  syncPluginsBack?(...args: any[]): any;
  rewritesCommonOnSync?: boolean;
  [key: string]: any;
}

/** One instance directory on disk. */
export interface InstanceInfo {
  name: string;
  appType: string;
  path: string;
}
