import { CareIcon, DecorIcon, FeedIcon, PlayIcon, ShopIcon } from './icons';
import { usePlayTool } from './context';
import type { OpenPanel, Panel } from './panels';
import { useEngineReadyForPlay } from './PlayControls';

const ITEMS: readonly {
  panel: OpenPanel;
  label: string;
  Icon: () => React.JSX.Element;
  needsEngine: boolean;
}[] = [
  { panel: 'feed', label: 'Feed', Icon: FeedIcon, needsEngine: true },
  { panel: 'play', label: 'Play', Icon: PlayIcon, needsEngine: true },
  { panel: 'decor', label: 'Decorate', Icon: DecorIcon, needsEngine: false },
  { panel: 'shop', label: 'Shop', Icon: ShopIcon, needsEngine: false },
  { panel: 'care', label: 'Care', Icon: CareIcon, needsEngine: false },
];

export function Dock({ panel, onPress }: { panel: Panel; onPress(panel: OpenPanel): void }) {
  const ready = useEngineReadyForPlay();
  const tool = usePlayTool();
  return (
    <nav className="dock" aria-label="Actions">
      {ITEMS.map(({ panel: id, label, Icon, needsEngine }) => {
        const waiting = needsEngine && !ready;
        return (
          <button
            key={id}
            type="button"
            className={id === 'play' && tool !== 'tap' ? 'dock-item glow' : 'dock-item'}
            data-opener={id}
            aria-pressed={panel === id}
            aria-controls={`panel-${id}`}
            disabled={waiting}
            title={waiting ? 'The tank is still loading' : undefined}
            onClick={() => onPress(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
