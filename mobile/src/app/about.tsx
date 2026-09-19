import { Screen, ScreenHeader } from '@/components/screen';
import { Badge, Card, Divider, Row, Section, Txt } from '@/components/ui';
import { FROZEN } from '@/services/config';
import { Spacing, useColors } from '@/theme';

/**
 * About.
 *
 * Includes the limitations verbatim from the research reports. A navigation
 * product that hides what it cannot do is worse than one that states it.
 */
export default function AboutScreen() {
  const c = useColors();
  return (
    <Screen>
      <ScreenHeader title="About MATRIX" back />

      <Card style={{ gap: Spacing.md }}>
        <Row justify="space-between">
          <Txt variant="heading">MATRIX DR</Txt>
          <Badge label="frozen model" tone="ok" />
        </Row>
        <Txt variant="body" color="textSecondary">
          MATRIX keeps navigating when the satellite signal does not. When GNSS drops — in a tunnel,
          an underpass, a dense urban canyon — a trained model reads the phone&apos;s accelerometer
          and gyroscope and estimates how the vehicle&apos;s speed and heading are changing. Those
          estimates are integrated forward from the last known fix, so the map keeps moving until
          GNSS returns.
        </Txt>
      </Card>

      <Section title="How it works">
        <Card style={{ gap: Spacing.md }}>
          <Step
            n={1}
            title="Sense"
            body={`The phone's 6-axis IMU is sampled at ${FROZEN.SAMPLE_RATE_HZ} Hz into ${FROZEN.WINDOW_SAMPLES}-sample causal windows — exactly the input the model was trained on.`}
          />
          <Step
            n={2}
            title="Predict"
            body="A small convolutional–recurrent network predicts the change in forward speed over the next half second (Δv) and the yaw rate. A second network predicts absolute speed as a slow anchor."
          />
          <Step
            n={3}
            title="Fuse"
            body={`A complementary filter (τ = ${FROZEN.TAU_S} s) combines the two: Δv supplies the fast dynamics, the anchor stops slow drift from accumulating.`}
          />
          <Step
            n={4}
            title="Integrate"
            body="Speed and yaw rate are integrated forward from the last GNSS fix to produce a position, which is what the map draws."
          />
        </Card>
      </Section>

      <Section title="What it does not claim">
        <Card style={{ gap: Spacing.sm, borderColor: `${c.warn}44` }}>
          <Limit text="Dead reckoning drifts. Error grows with outage length — metres over ten seconds, hundreds of metres over five minutes." />
          <Limit text="The model was trained and tested on one phone (Huawei P20 Pro) in one vehicle (Ford Fiesta). Generalisation to other devices is untested." />
          <Limit text="Three drivers contributed data; the test split is a single unseen driver." />
          <Limit text="The model assumes exactly 10 Hz IMU data. Windows that fall outside that timing are dropped, not resampled." />
          <Limit text="Dead reckoning needs a velocity anchor at the moment GNSS is lost. Error in that anchor propagates into the whole estimate." />
          <Limit text="Beyond about five minutes, heading drift dominates and the estimate should not be trusted for navigation." />
          <Limit text="Benchmark figures in this app are measured research results on a specific dataset. They are not a guarantee of real-world accuracy." />
        </Card>
      </Section>

      <Section title="Frozen configuration">
        <Card style={{ gap: Spacing.sm }}>
          <Fact label="Input" value={`${FROZEN.WINDOW_SAMPLES} × 6 (acc xyz, gyro xyz) at ${FROZEN.SAMPLE_RATE_HZ} Hz`} />
          <Fact label="Prediction" value="Δv over 0.5 s, yaw rate" />
          <Fact label="Fusion" value={`complementary filter, τ = ${FROZEN.TAU_S} s, k = ${FROZEN.K}`} />
          <Divider />
          <Txt variant="micro" color="textTertiary">
            The trained weights, the scaler, the feature order and the fusion constants are fixed.
            This app reads them from the inference service and adapts to them; it has no capability
            to change them.
          </Txt>
        </Card>
      </Section>

      <Txt variant="micro" color="textTertiary" style={{ textAlign: 'center' }}>
        MATRIX · AI dead reckoning for GNSS-denied navigation
      </Txt>
    </Screen>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  const c = useColors();
  return (
    <Row gap={Spacing.md} align="flex-start">
      <Txt variant="label" style={{ color: c.accent, width: 18 }}>
        {n}
      </Txt>
      <Row gap={2} style={{ flex: 1, flexDirection: 'column', alignItems: 'flex-start' }}>
        <Txt variant="bodyStrong">{title}</Txt>
        <Txt variant="caption" color="textSecondary">
          {body}
        </Txt>
      </Row>
    </Row>
  );
}

function Limit({ text }: { text: string }) {
  const c = useColors();
  return (
    <Row gap={Spacing.sm} align="flex-start">
      <Txt variant="caption" style={{ color: c.warn }}>
        •
      </Txt>
      <Txt variant="caption" color="textSecondary" style={{ flex: 1 }}>
        {text}
      </Txt>
    </Row>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Row justify="space-between" gap={Spacing.md}>
      <Txt variant="caption" color="textTertiary">
        {label}
      </Txt>
      <Txt variant="caption" style={{ flex: 1, textAlign: 'right' }}>
        {value}
      </Txt>
    </Row>
  );
}
