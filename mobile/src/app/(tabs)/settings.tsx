import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Screen, ScreenHeader } from '@/components/screen';
import {
  Button,
  Card,
  IconChevronRight,
  ListRow,
  Section,
  SegmentedControl,
  ToggleRow,
  Txt,
} from '@/components/ui';
import { useSettings } from '@/hooks/use-settings';
import { DEFAULT_API_URL, FROZEN } from '@/services/config';
import { Radius, Spacing, useColors } from '@/theme';

/**
 * Settings.
 *
 * Everything here is presentation or connectivity. The frozen model parameters
 * (architecture, weights, scaler, feature order, Δv horizon, τ) are shown as
 * read-only facts and are deliberately not editable — changing any of them would
 * invalidate the model's measured accuracy.
 */
export default function SettingsScreen() {
  const c = useColors();
  const { settings, update, reset } = useSettings();
  const [apiDraft, setApiDraft] = useState(settings.apiUrl);

  return (
    <Screen>
      <ScreenHeader title="Settings" />

      <Section title="Units">
        <SegmentedControl
          label="Units"
          value={settings.units}
          onChange={(v) => update('units', v)}
          options={[
            { value: 'metric', label: 'Metric (km/h)' },
            { value: 'imperial', label: 'Imperial (mph)' },
          ]}
        />
      </Section>

      <Section title="Map">
        <SegmentedControl
          label="Map style"
          value={settings.mapStyle}
          onChange={(v) => update('mapStyle', v)}
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'terrain', label: 'Terrain' },
          ]}
        />
        <Txt variant="caption" color="textTertiary">
          Maps are rendered by MapLibre from OpenStreetMap tiles — no API key and no billing.
          Basemap tiles need a connection the first time an area is viewed; the navigation
          overlays and the AI itself work with no network at all.
        </Txt>
        <Card padded={false}>
          <ToggleRow
            first
            title="Show GNSS track"
            subtitle="The path measured by the satellite receiver"
            value={settings.showGnssTrack}
            onChange={(v) => update('showGnssTrack', v)}
          />
          <ToggleRow
            title="Show AI dead-reckoning track"
            subtitle="The path estimated by the frozen model during outages"
            value={settings.showDrTrack}
            onChange={(v) => update('showDrTrack', v)}
          />
          <ToggleRow
            last
            title="Follow vehicle"
            subtitle="Keep the camera centred while navigating"
            value={settings.followVehicle}
            onChange={(v) => update('followVehicle', v)}
          />
        </Card>
      </Section>

      <Section title="Navigation">
        <Card padded={false}>
          <ToggleRow
            first
            title="Keep screen awake"
            subtitle="Prevents the display sleeping during a drive"
            value={settings.keepAwake}
            onChange={(v) => update('keepAwake', v)}
          />
          <ToggleRow
            title="Haptics on mode change"
            subtitle="Vibrate when the AI takes over and when GNSS returns"
            value={settings.hapticsOnModeChange}
            onChange={(v) => update('hapticsOnModeChange', v)}
          />
          <ToggleRow
            last
            title="Technical details"
            subtitle="Show checkpoint hashes, τ and filter equations in the AI panel"
            value={settings.technicalDetails}
            onChange={(v) => update('technicalDetails', v)}
          />
        </Card>
      </Section>

      <Section title="AI inference">
        <SegmentedControl
          label="Where the model runs"
          value={settings.inferenceMode}
          onChange={(v) => update('inferenceMode', v)}
          options={[
            { value: 'ondevice', label: 'On device' },
            { value: 'auto', label: 'Auto' },
            { value: 'service', label: 'Server' },
          ]}
        />
        <Txt variant="caption" color="textTertiary">
          {settings.inferenceMode === 'ondevice'
            ? 'The frozen model runs on this phone with ONNX Runtime. Dead reckoning works with no network at all — the case the product exists for.'
            : settings.inferenceMode === 'service'
              ? 'Every window is sent to the inference service. Requires a reachable backend; dead reckoning stops working if the network does.'
              : 'Prefers the on-device model and falls back to the service only if the bundled models cannot be loaded.'}
        </Txt>
        <Txt variant="caption" color="textTertiary">
          Both paths run the same frozen weights, the same scaler and the same τ = {FROZEN.TAU_S} s
          filter, so they produce the same track. Changing this takes effect on the next drive.
        </Txt>
      </Section>

      <Section title="Inference service">
        <Card style={{ gap: Spacing.md }}>
          <View style={{ gap: Spacing.sm }}>
            <Txt variant="label" color="textSecondary">
              BASE URL
            </Txt>
            <TextInput
              value={apiDraft}
              onChangeText={setApiDraft}
              onBlur={() => update('apiUrl', apiDraft.trim() || DEFAULT_API_URL)}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="Inference service base URL"
              placeholder={DEFAULT_API_URL}
              placeholderTextColor={c.textTertiary}
              style={{
                minHeight: 44,
                paddingHorizontal: Spacing.md,
                borderRadius: Radius.md,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.surfaceSunken,
                color: c.text,
              }}
            />
            <Txt variant="caption" color="textTertiary">
              Android emulator: http://10.0.2.2:8000 · iOS simulator: http://127.0.0.1:8000 ·
              physical device: your computer&apos;s LAN address. Only used in Server or Auto mode.
            </Txt>
          </View>
          <Button
            label="Apply and test"
            variant="secondary"
            onPress={() => {
              update('apiUrl', apiDraft.trim() || DEFAULT_API_URL);
              router.push('/diagnostics');
            }}
          />
        </Card>
      </Section>

      <Section title="Model">
        <Card padded={false}>
          <ListRow first title="Model" subtitle="MATRIX DR — frozen" right={<Txt variant="caption" color="textTertiary">read-only</Txt>} />
          <ListRow title="Input window" subtitle={`${FROZEN.WINDOW_SAMPLES} samples at ${FROZEN.SAMPLE_RATE_HZ} Hz`} />
          <ListRow title="Features" subtitle={FROZEN.FEATURES.join(', ')} />
          <ListRow title="Δv horizon" subtitle={`k = ${FROZEN.K} (0.5 s)`} />
          <ListRow last title="Complementary filter τ" subtitle={`${FROZEN.TAU_S} s`} />
        </Card>
        <Txt variant="caption" color="textTertiary">
          These values are fixed by the trained model and cannot be changed from the app. Editing
          any of them would invalidate the measured accuracy.
        </Txt>
      </Section>

      <Section title="More">
        <Card padded={false}>
          <ListRow
            first
            title="Demo mode"
            subtitle="Replay a recorded drive with a real GNSS outage"
            right={<IconChevronRight color="textTertiary" />}
            onPress={() => router.push('/demo')}
          />
          <ListRow
            title="System diagnostics"
            subtitle="Permissions, sensors, service status, latency"
            right={<IconChevronRight color="textTertiary" />}
            onPress={() => router.push('/diagnostics')}
          />
          <ListRow
            last
            title="About MATRIX"
            subtitle="What this app does and what it does not claim"
            right={<IconChevronRight color="textTertiary" />}
            onPress={() => router.push('/about')}
          />
        </Card>
      </Section>

      <Button label="Reset settings to defaults" variant="ghost" onPress={reset} />
    </Screen>
  );
}
