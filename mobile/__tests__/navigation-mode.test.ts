import { describeStatus } from '@/components/navigation-status';
import { ConfirmationGate, nextMode, type ModeInput } from '@/services/navigation-engine';

const base: ModeInput = {
  navigating: true,
  gnss: 'ACTIVE',
  inference: 'READY',
  windowReady: true,
  hasAnchor: true,
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

  it('reports ACQUIRING before the first fix — a search is not a loss', () => {
    expect(nextMode({ ...base, gnss: 'ACQUIRING', hasAnchor: false })).toBe('ACQUIRING');
    // and it stays ACQUIRING even with a ready model: there is nothing to anchor to
    expect(nextMode({ ...base, gnss: 'ACQUIRING', hasAnchor: false, inference: 'READY' })).toBe(
      'ACQUIRING',
    );
  });

  it('cannot dead reckon without an anchor to reckon from', () => {
    expect(nextMode({ ...base, gnss: 'OUTAGE', hasAnchor: false })).toBe('DEGRADED');
    expect(nextMode({ ...base, gnss: 'UNAVAILABLE', hasAnchor: false })).toBe('DEGRADED');
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
      for (const gnss of ['ACQUIRING', 'ACTIVE', 'WEAK', 'OUTAGE', 'UNAVAILABLE'] as const) {
        for (const inference of ['IDLE', 'WARMING', 'READY', 'ERROR', 'OFFLINE'] as const) {
          for (const windowReady of [true, false]) {
            for (const hasAnchor of [true, false]) {
              modes.add(nextMode({ navigating, gnss, inference, windowReady, hasAnchor }));
            }
          }
        }
      }
    }
    expect([...modes].sort()).toEqual([
      'ACQUIRING',
      'DEAD_RECKONING',
      'DEGRADED',
      'GNSS',
      'IDLE',
    ]);
  });
});

describe('ConfirmationGate — a mode change must hold for real time', () => {
  it('does not fire until the hold has elapsed, however often it is pushed', () => {
    const g = new ConfirmationGate();
    // this is the exact bug the old sample counter had: two callers pushing
    // milliseconds apart used to satisfy a two-sample threshold
    expect(g.push('DEAD_RECKONING', 3, 1000)).toBe(false);
    expect(g.push('DEAD_RECKONING', 3, 1050)).toBe(false);
    expect(g.push('DEAD_RECKONING', 3, 1100)).toBe(false);
    expect(g.push('DEAD_RECKONING', 3, 3999)).toBe(false);
    expect(g.push('DEAD_RECKONING', 3, 4000)).toBe(true);
  });

  it('restarts the hold when the candidate changes', () => {
    const g = new ConfirmationGate();
    g.push('DEAD_RECKONING', 2, 0);
    expect(g.push('GNSS', 2, 1900)).toBe(false);
    expect(g.push('GNSS', 2, 3899)).toBe(false);
    expect(g.push('GNSS', 2, 3900)).toBe(true);
  });

  it('a single spurious reading never flips the mode', () => {
    const g = new ConfirmationGate();
    for (let t = 0; t < 10_000; t += 500) {
      // healthy, healthy, blip, healthy, ...
      const value = t === 3000 ? 'DEAD_RECKONING' : 'GNSS';
      if (value === 'DEAD_RECKONING') expect(g.push(value, 3, t)).toBe(false);
      else g.push(value, 1.5, t);
    }
  });

  it('force() adopts the next matching push immediately, for user actions', () => {
    const g = new ConfirmationGate();
    g.force('DEAD_RECKONING');
    expect(g.push('DEAD_RECKONING', 999, 0)).toBe(true);
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

  it('never claims an AI position in DEGRADED mode', () => {
    const s = describeStatus('DEGRADED', 'OUTAGE', 'No fix');
    expect(s.ai).toBe(false);
    expect(s.label).toBe('POSITION HELD');
    expect(s.tone).toBe('danger');
  });

  it('says it is acquiring, not that GNSS was lost, before the first fix', () => {
    const s = describeStatus('ACQUIRING', 'ACQUIRING', 'Acquiring satellites');
    expect(s.label).toBe('ACQUIRING GNSS');
    expect(s.label).not.toContain('LOST');
    expect(s.ai).toBe(false);
  });
});
