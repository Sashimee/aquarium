import { useEffect, useSyncExternalStore } from 'react';
import { audio as shared, type AudioEngine } from '../interaction/audio/engine';
import { useAuth } from './context';

function useAudio(audio: AudioEngine): void {
  useSyncExternalStore(audio.subscribe, audio.getVersion, audio.getVersion);
}

function useAudioUser(audio: AudioEngine): void {
  const { user } = useAuth();
  const id = user?.id ?? null;
  useEffect(() => audio.setUser(id), [audio, id]);
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="26"
      height="26"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4Z" />
      {muted ? (
        <path d="m16 9.5 5 5M21 9.5l-5 5" />
      ) : (
        <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
      )}
    </svg>
  );
}

export function SoundButton({ audio = shared }: { audio?: AudioEngine }) {
  useAudio(audio);
  useAudioUser(audio);
  const { muted } = audio.settings;
  return (
    <button
      type="button"
      className="round"
      aria-label="Sound"
      aria-pressed={!muted}
      title={muted ? 'Sound is off' : 'Sound is on'}
      disabled={audio.status === 'unsupported'}
      onClick={() => audio.setMuted(!muted)}
    >
      <SpeakerIcon muted={muted} />
    </button>
  );
}

export function SoundSetting({ audio = shared }: { audio?: AudioEngine }) {
  useAudio(audio);
  const { muted, volume, quiet } = audio.settings;
  const unsupported = audio.status === 'unsupported';
  return (
    <section aria-labelledby="sound-title">
      <h2 id="sound-title">Sound</h2>
      <label>
        <input
          type="checkbox"
          checked={!muted}
          disabled={unsupported}
          onChange={(e) => audio.setMuted(!e.target.checked)}
        />{' '}
        Play sound
      </label>
      <p>
        <label>
          Volume{' '}
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(volume * 100)}
            disabled={unsupported}
            aria-valuetext={`${Math.round(volume * 100)} percent`}
            onChange={(e) => audio.setVolume(Number(e.target.value) / 100)}
          />
        </label>
      </p>
      <label>
        <input
          type="checkbox"
          checked={quiet}
          disabled={unsupported}
          aria-describedby="sound-note"
          onChange={(e) => audio.setQuiet(e.target.checked)}
        />{' '}
        No sudden loud sounds
      </label>
      <p id="sound-note" className="hint">
        {unsupported
          ? 'This browser has no Web Audio, so there is nothing to turn on.'
          : 'Softens taps and bubbles. Sound starts after your first tap or key press.'}
      </p>
    </section>
  );
}
