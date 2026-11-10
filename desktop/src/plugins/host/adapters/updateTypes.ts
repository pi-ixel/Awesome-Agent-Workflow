export interface UpdatePreferences {
  autoCheck: boolean;
  checkIntervalMinutes: number;
  autoDownload: boolean;
  server: string;
  acceleration: boolean;
  contribute: boolean;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  published_at?: string | null;
}

export interface UpdateSnapshot {
  phase: string;
  currentVersion: string;
  ready: UpdateManifest | null;
  available: UpdateManifest | null;
  progress: number;
  error: string | null;
  uploadError: string | null;
  sourceMessages: string[];
  installed: boolean;
  preferences: UpdatePreferences;
}

export interface UpdatesHost {
  isNative(): boolean;
  listen(listener: (snapshot: UpdateSnapshot) => void): Promise<() => void>;
  status(): Promise<UpdateSnapshot>;
  check(): Promise<void>;
  download(): Promise<void>;
  preferences(preferences: UpdatePreferences): Promise<void>;
  prepare(version: string): Promise<void>;
  cancel(): Promise<void>;
  install(): Promise<void>;
  openFolder(): Promise<void>;
}
