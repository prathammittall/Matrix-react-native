import { Tabs } from 'expo-router/js-tabs';
import { StyleSheet } from 'react-native';

import { IconHistory, IconHome, IconNavigate, IconSettings } from '@/components/ui/icons';
import { Type, useColors } from '@/theme';

/**
 * The JS tab bar (rather than the native one) so the icons are the same
 * hand-drawn set used everywhere else in the app and the bar picks up the
 * MATRIX palette identically on both platforms.
 */
export default function TabsLayout() {
  const c = useColors();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textTertiary,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        tabBarLabelStyle: { ...Type.micro, marginBottom: 2 },
        sceneStyle: { backgroundColor: c.background },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => <IconHome size={22} tint={String(color)} />,
          tabBarAccessibilityLabel: 'Home dashboard',
        }}
      />
      <Tabs.Screen
        name="navigate"
        options={{
          title: 'Navigate',
          tabBarIcon: ({ color }) => <IconNavigate size={22} tint={String(color)} />,
          tabBarAccessibilityLabel: 'Live navigation',
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'History',
          tabBarIcon: ({ color }) => <IconHistory size={22} tint={String(color)} />,
          tabBarAccessibilityLabel: 'Navigation history',
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <IconSettings size={22} tint={String(color)} />,
          tabBarAccessibilityLabel: 'Settings',
        }}
      />
    </Tabs>
  );
}
