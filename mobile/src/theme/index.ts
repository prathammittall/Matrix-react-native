import { useSyncExternalStore } from 'react';
import { Appearance, useColorScheme } from 'react-native';

import { Palette, type ColorScheme, type ThemeColors } from './tokens';

export * from './tokens';

export type ThemePreference = 'system' | 'dark' | 'light';

/**
 * The theme preference lives outside React.
 *
 * `useColors` is called by nearly every component, including ones that render
 * above the settings provider (the splash gate, the error boundary). A module
 * store keeps the theme readable from all of them without threading a context
 * through the tree or creating an import cycle between theme and services.
 */
let preference: ThemePreference = 'dark';
const listeners = new Set<() => void>();

export function setThemePreference(next: ThemePreference) {
  if (next === preference) return;
  preference = next;
  for (const fn of listeners) fn();
}

export function getThemePreference(): ThemePreference {
  return preference;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The scheme actually in force, once the preference and the OS are combined. */
export function useColorSchemeResolved(): ColorScheme {
  const pref = useSyncExternalStore(subscribe, getThemePreference, getThemePreference);
  const system = useColorScheme();
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return system === 'light' ? 'light' : 'dark';
}

/** Resolved palette for the current scheme. Black is the default. */
export function useColors(): ThemeColors {
  return Palette[useColorSchemeResolved()];
}

export function useIsDark(): boolean {
  return useColorSchemeResolved() === 'dark';
}

/** Non-hook read, for imperative call sites such as map style selection. */
export function currentScheme(): ColorScheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
}
