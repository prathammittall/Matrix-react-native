import { useColorScheme } from 'react-native';

import { Palette, type ColorScheme, type ThemeColors } from './tokens';

export * from './tokens';

/** Resolved palette for the viewer's current scheme. Dark is the default. */
export function useColors(): ThemeColors {
  const scheme = useColorScheme();
  const key: ColorScheme = scheme === 'light' ? 'light' : 'dark';
  return Palette[key];
}

export function useIsDark(): boolean {
  return useColorScheme() !== 'light';
}
