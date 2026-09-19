import { describeStatus } from '@/components/navigation-status';
import { Debouncer, nextMode, type ModeInput } from '@/services/navigation-engine';

const base: ModeInput = {
  navigating: true,
  gnss: 'ACTIVE',
  inference: 'READY',
  windowReady: true,
};

describe('nextMode — navigation mode switching', () => {
  it('is IDLE whenever navigation has not been started', () => {
    expect(nextMode({ ...base, navigating: false })).toBe('IDLE');
    expect(nextMode({ ...base, navigating: false, gnss: 'OUTAGE' })).toBe('IDLE');
  });

  it('navigates by GNSS while a fix is available, even a weak one', () => {
    expect(nextMode(base)).toBe('GNSS');
    expect(nextMode({ ...base, gnss: 'WEAK' })).toBe('GNSS');
  });

  it('prefers GNSS over dead reckoning even when the model is ready', () => {
    expect(nextMode({ ...base, gnss: 'WEAK', inference: 'READY' })).toBe('GNSS');
  });

  it('switches to dead reckoning on a GNSS outage once the window is full', () => {
    expect(nextMode({ ...base, gnss: 'OUTAGE' })).toBe('DEAD_RECKONING');
    expect(nextMode({ ...base, gnss: 'UNAVAILABLE' })).toBe('DEAD_RECKONING');
  });

  it('does NOT dead reckon before the 50-sample window is full', () => {
    expect(nextMode({ ...base, gnss: 'OUTAGE', windowReady: false })).toBe('DEGRADED');
  });

  it('degrades rather than guessing when the inference service is unavailable', () => {
    expect(nextMode({ ...base, gnss: 'OUTAGE', inference: 'OFFLINE' })).toBe('DEGRADED');
    expect(nextMode({ ...base, gnss: 'OUTAGE', inference: 'ERROR' })).toBe('DEGRADED');
    expect(nextMode({ ...base, gnss: 'OUTAGE', inference: 'WARMING' })).toBe('DEGRADED');
  });

  it('recovers to GNSS as soon as a fix returns mid-outage', () => {
    expect(nextMode({ ...base, gnss: 'OUTAGE' })).toBe('DEAD_RECKONING');
    expect(nextMode({ ...base, gnss: 'ACTIVE' })).toBe('GNSS');
  });

  it('never produces a mode outside the declared set', () => {
    const modes = new Set<string>();
    for (const navigating of [true, false]) {
      for (const gnss of ['ACTIVE', 'WEAK', 'OUTAGE', 'UNAVAILABLE'] as const) {
        for (const inference of ['IDLE', 'WARMING', 'READY', 'ERROR', 'OFFLINE'] as const) {
          for (const windowReady of [true, false]) {
            modes.add(nextMode({ navigating, gnss, inference, windowReady }));
          }
        }
      }
    }
    expect([...modes].sort()).toEqual(['DEAD_RECKONING', 'DEGRADED', 'GNSS', 'IDLE']);
  });
});

describe('Debouncer — outage detection must survive a single dropped fix', () => {
  it('does not fire on the first occurrence when the threshold is 2', () => {
    const d = new Debouncer();
    expect(d.push('DEAD_RECKONING', 2)).toBe(false);
    expect(d.push('DEAD_RECKONING', 2)).toBe(true);
  });

  it('resets its count when the value changes', () => {
    const d = new Debouncer();
    d.push('DEAD_RECKONING', 3);
    d.push('DEAD_RECKONING', 3);
    expect(d.push('GNSS', 3)).toBe(false);
    expect(d.push('GNSS', 3)).toBe(false);
    expect(d.push('GNSS', 3)).toBe(true);
  });

  it('fires immediately when the threshold is 1', () => {
    expect(new Debouncer().push('GNSS', 1)).toBe(true);
  });
});

describe('describeStatus — the four status-indicator states', () => {
  it('reports GNSS ACTIVE', () => {
    const s = describeStatus('GNSS', 'ACTIVE', 'Accuracy 4 m');
    expect(s.label).toBe('GNSS ACTIVE');
    expect(s.tone).toBe('ok');
    expect(s.ai).toBe(false);
  });

  it('reports GNSS WEAK', () => {
    expect(describeStatus('GNSS', 'WEAK', 'Accuracy 30 m').tone).toBe('warn');
  });

  it('reports GNSS OUTAGE when not dead reckoning', () => {
    const s = describeStatus('GNSS', 'OUTAGE', 'No fix for 6.0 s');
    expect(s.label).toBe('GNSS OUTAGE');
    expect(s.tone).toBe('danger');
  });

  it('reports AI DEAD RECKONING and marks it as AI-sourced', () => {
    const s = describeStatus('DEAD_RECKONING', 'OUTAGE', 'No fix for 12.0 s');
    expect(s.label).toBe('AI DEAD RECKONING');
    expect(s.tone).toBe('ai');
    expect(s.ai).toBe(true);
  });

  it('never claims a position in DEGRADED mode', () => {
    const s = describeStatus('DEGRADED', 'OUTAGE', 'No fix');
    expect(s.ai).toBe(false);
    expect(s.label).toContain('UNAVAILABLE');
  });
});
