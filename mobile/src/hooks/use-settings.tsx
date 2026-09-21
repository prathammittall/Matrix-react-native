import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { setApiBaseUrl } from '@/services/api';
import { setThemePreference } from '@/theme';
import { DEFAULT_SETTINGS, storage, type Settings } from '@/services/storage';

interface SettingsContextValue {
  settings: Settings;
  loaded: boolean;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  update: () => undefined,
  reset: () => undefined,
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void storage.loadSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      setApiBaseUrl(s.apiUrl);
      setThemePreference(s.theme);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'apiUrl') setApiBaseUrl(next.apiUrl);
      if (key === 'theme') setThemePreference(next.theme);
      void storage.saveSettings(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    setApiBaseUrl(DEFAULT_SETTINGS.apiUrl);
    setThemePreference(DEFAULT_SETTINGS.theme);
    void storage.saveSettings(DEFAULT_SETTINGS);
  }, []);

  const value = useMemo(() => ({ settings, loaded, update, reset }), [settings, loaded, update, reset]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
