import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PHOTO_FILTERS, type PhotoFilter } from '../engine/photo/grade';
import { F_STOP_RANGE } from '../engine/photo/lens';
import type { PhotoCaptureOutcome, PhotoCommand, PhotoMove } from '../interaction/events';
import { useBridge, usePhotoView } from './context';
import { Dialog } from './Dialog';
import {
  browserDownloadHost,
  canSharePhoto,
  downloadPhoto,
  photoFile,
  photoFileName,
  sharePhoto,
} from './photoSave';
import { describeFocus, focusToSlider, FOV_DEGREES, sliderToFocus } from './photoSliders';

const FILTER_LABEL: Record<PhotoFilter, string> = {
  natural: 'Natural',
  vivid: 'Vivid',
  cool: 'Cool',
  warm: 'Warm',
  bw: 'Black and white',
};

interface Taken {
  url: string;
  file: File;
}

function useRequest() {
  return useBridge().interaction;
}

/** Always mounted: a failed capture must still be reported after photo mode has closed. */
export function PhotoLayer() {
  const interaction = useRequest();
  const view = usePhotoView();
  const [taken, setTaken] = useState<Taken | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const takenRef = useRef<Taken | null>(null);

  const clear = () => {
    if (takenRef.current) URL.revokeObjectURL(takenRef.current.url);
    takenRef.current = null;
    setTaken(null);
  };

  useEffect(() => {
    const off = interaction.on('photo:capture', (outcome: PhotoCaptureOutcome) => {
      if (outcome.status === 'failed') {
        setFailure(outcome.message);
        return;
      }
      setFailure(null);
      if (takenRef.current) URL.revokeObjectURL(takenRef.current.url);
      const file = photoFile(outcome.blob, photoFileName(new Date()));
      takenRef.current = { url: URL.createObjectURL(outcome.blob), file };
      setTaken(takenRef.current);
    });
    return () => {
      off();
      if (takenRef.current) URL.revokeObjectURL(takenRef.current.url);
    };
  }, [interaction]);

  const active = view?.state.active ?? false;
  return (
    <>
      {active && <PhotoBar />}
      {failure && (
        <div className="photo-notice" role="alert">
          <p>{failure}</p>
          <button type="button" onClick={() => setFailure(null)}>
            Dismiss
          </button>
        </div>
      )}
      {taken && <PhotoResult taken={taken} onClose={clear} />}
    </>
  );
}

function PhotoBar() {
  const interaction = useRequest();
  const view = usePhotoView();
  const capturing = view?.capturing ?? false;
  const hidden = view?.state.uiHidden ?? false;
  return (
    <div className="photo-bar" role="group" aria-label="Photo mode">
      <button
        type="button"
        data-photo="exit"
        onClick={() => interaction.emit('photo:request', { type: 'exit' })}
      >
        Exit
      </button>
      <button
        type="button"
        className="shutter primary"
        data-photo="shutter"
        aria-label="Take photo"
        aria-busy={capturing}
        disabled={capturing}
        onClick={() => {
          interaction.emit('photo:request', { type: 'capture' });
        }}
      >
        {capturing ? 'Taking photo' : 'Take photo'}
      </button>
      <button
        type="button"
        data-photo="hide-ui"
        onClick={() => interaction.emit('photo:request', { type: 'hide-ui', hidden: !hidden })}
      >
        {hidden ? 'Show controls' : 'Hide controls'}
      </button>
    </div>
  );
}

function PhotoResult({ taken, onClose }: { taken: Taken; onClose(): void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const canShare = canSharePhoto(navigator, taken.file);
  return (
    <Dialog title="Your photo" onClose={onClose}>
      <img
        className="photo-preview"
        src={taken.url}
        alt="The picture you just took of your tank."
      />
      <p className="hint">{taken.file.name}</p>
      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={() => {
            downloadPhoto(browserDownloadHost, taken.file, taken.file.name);
            setProblem(null);
            setNote('Saved to your downloads.');
          }}
        >
          Save picture
        </button>
        {canShare && (
          <button
            type="button"
            onClick={() => {
              setProblem(null);
              setNote(null);
              sharePhoto(navigator, taken.file).then(
                (outcome) => setNote(outcome === 'shared' ? 'Shared.' : null),
                (cause: unknown) =>
                  setProblem(cause instanceof Error ? cause.message : 'Sharing failed.'),
              );
            }}
          >
            Share
          </button>
        )}
        <button type="button" onClick={onClose}>
          Keep shooting
        </button>
      </div>
      {!canShare && (
        <p className="hint">
          This browser cannot share pictures, so save it and send it from there.
        </p>
      )}
      <p role="status" className="hint">
        {note}
      </p>
      <p role="alert" className="hint" hidden={!problem}>
        {problem}
      </p>
    </Dialog>
  );
}

function Slider({
  id,
  label,
  output,
  children,
}: {
  id: string;
  label: string;
  output: string;
  children: ReactNode;
}) {
  return (
    <div className="photo-field">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{output}</output>
      {children}
    </div>
  );
}

const MOVES: readonly { move: PhotoMove; label: string; glyph: string }[] = [
  { move: 'up', label: 'Move up', glyph: 'Up' },
  { move: 'forward', label: 'Move forward', glyph: 'In' },
  { move: 'down', label: 'Move down', glyph: 'Down' },
  { move: 'left', label: 'Move left', glyph: 'Left' },
  { move: 'back', label: 'Move back', glyph: 'Out' },
  { move: 'right', label: 'Move right', glyph: 'Right' },
];

function HoldButton({ move, label, glyph }: { move: PhotoMove; label: string; glyph: string }) {
  const interaction = useRequest();
  const hold = (down: boolean) => interaction.emit('photo:request', { type: 'hold', move, down });
  return (
    <button
      type="button"
      className="pad-button"
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        hold(true);
      }}
      onPointerUp={() => hold(false)}
      onPointerCancel={() => hold(false)}
      onLostPointerCapture={() => hold(false)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) hold(true);
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') hold(false);
      }}
      onBlur={() => hold(false)}
    >
      {glyph}
    </button>
  );
}

export function PhotoTools() {
  const interaction = useRequest();
  const view = usePhotoView();
  if (!view?.state.active) return null;
  const { filter, fov, depthOfField: dof, simPaused } = view.state;
  const send = (command: PhotoCommand) => interaction.emit('photo:request', command);
  const lens = dof.enabled && dof.available;
  return (
    <section className="photo-tools" aria-label="Photo controls">
      <fieldset className="photo-filters">
        <legend>Filter</legend>
        {PHOTO_FILTERS.map((f) => (
          <label key={f} className="chip">
            <input
              type="radio"
              name="photo-filter"
              value={f}
              checked={filter === f}
              onChange={() => send({ type: 'filter', filter: f })}
            />
            <span>{FILTER_LABEL[f]}</span>
          </label>
        ))}
      </fieldset>

      <Slider id="photo-fov" label="Field of view" output={`${Math.round(fov)} degrees`}>
        <input
          id="photo-fov"
          type="range"
          min={FOV_DEGREES.min}
          max={FOV_DEGREES.max}
          step={1}
          value={fov}
          onChange={(e) => send({ type: 'fov', degrees: e.currentTarget.valueAsNumber })}
        />
      </Slider>

      <label className="check">
        <input
          type="checkbox"
          checked={dof.enabled}
          disabled={!dof.available}
          onChange={(e) => send({ type: 'dof', enabled: e.currentTarget.checked })}
        />
        <span>Depth of field</span>
      </label>
      {!dof.available && (
        <p className="hint">Depth of field needs the medium or high quality setting.</p>
      )}
      <Slider id="photo-focus" label="Focus distance" output={describeFocus(dof.focusDistance)}>
        <input
          id="photo-focus"
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={focusToSlider(dof.focusDistance)}
          disabled={!lens}
          onChange={(e) =>
            send({ type: 'dof', focusDistance: sliderToFocus(e.currentTarget.valueAsNumber) })
          }
        />
      </Slider>
      <Slider id="photo-fstop" label="Aperture" output={`f/${dof.fStop.toFixed(1)}`}>
        <input
          id="photo-fstop"
          type="range"
          min={F_STOP_RANGE.min}
          max={F_STOP_RANGE.max}
          step={0.1}
          value={dof.fStop}
          disabled={!lens}
          onChange={(e) => send({ type: 'dof', fStop: e.currentTarget.valueAsNumber })}
        />
      </Slider>

      <label className="check">
        <input
          type="checkbox"
          checked={simPaused}
          onChange={(e) => send({ type: 'freeze', paused: e.currentTarget.checked })}
        />
        <span>Freeze the fish</span>
      </label>

      <div role="group" aria-label="Move the camera" className="photo-pad">
        {MOVES.map((m) => (
          <HoldButton key={m.move} {...m} />
        ))}
      </div>
      <p className="hint">
        Drag to look around, pinch or scroll to zoom. Keys: W A S D move, Q and E go down and up,
        arrows turn, plus and minus zoom, H hides the controls, Escape leaves.
        {dof.enabled && dof.available ? ' Tap the picture to focus on what you touch.' : ''}
      </p>
    </section>
  );
}
