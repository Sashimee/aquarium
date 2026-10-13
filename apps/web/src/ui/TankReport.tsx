import type { CameraMode } from '../interaction/camera';
import { useState } from 'react';
import { tankReportLines } from '../sync/life';
import { useCameraMode, useDemoBiome, useEngineReady } from './context';
import { useActiveTank, useSessionState } from './session';

const MODE_LABEL: Record<CameraMode, string> = {
  orbit: 'Outside view',
  focus: 'Following a fish',
  dive: 'Inside the tank',
};

export default function TankReport() {
  const [open, setOpen] = useState(false);
  const engine = useEngineReady();
  const mode = useCameraMode();
  const demoBiome = useDemoBiome();
  const tank = useActiveTank();
  const { species, phase } = useSessionState();
  return (
    <section className="report" aria-label="Tank report">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="tank-report-body"
        onClick={() => setOpen(!open)}
      >
        Tank report
      </button>
      <div id="tank-report-body" hidden={!open}>
        {tank ? (
          tankReportLines(tank, species).map((line) => <p key={line}>{line}</p>)
        ) : (
          <>
            <p>A 300 litre {demoBiome} aquarium, 120 by 50 by 50 centimetres.</p>
            <p>
              {phase === 'unverified'
                ? 'Verify your email address to keep a saved tank.'
                : 'This is the demo tank. Sign in with a verified account to keep a tank.'}
            </p>
          </>
        )}
        <p>Camera: {MODE_LABEL[mode]}.</p>
        <p>
          {engine
            ? `Rendering with ${engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL 2'} at the ${engine.tier} quality tier.`
            : 'The tank is still loading.'}
        </p>
      </div>
    </section>
  );
}
