// Shared domain types for the split modules.

export type JsonObject = Record<string, any>;

/** One leaf-level difference between two settings trees. */
export interface SettingsChange {
  path: string;
  op: "add" | "remove" | "change";
  from: unknown;
  to: unknown;
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
}

/** One instance directory on disk. */
export interface InstanceInfo {
  name: string;
  appType: string;
  path: string;
}
