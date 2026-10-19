import type { SaveSource, SaveStatus } from '../interaction/events';

interface Report {
  status: SaveStatus;
  message: string | null;
}

const IDLE: Report = { status: 'idle', message: null };
const WORST: readonly SaveStatus[] = ['error', 'retrying', 'saving', 'saved'];

/**
 * One status for several savers: a failure stays on show until the failed saver succeeds or is
 * reset, so a later success elsewhere cannot hide it. While several savers share the worst
 * status, the one already on show keeps the message, so a second failure does not replace it.
 */
export class SaveStatusMerge {
  private readonly reports = new Map<SaveSource, Report>();
  private shown: SaveSource | null = null;

  constructor(
    private readonly emit: (
      status: SaveStatus,
      message: string | null,
      source: SaveSource,
      reported: { source: SaveSource; status: SaveStatus },
    ) => void,
  ) {}

  reporter(source: SaveSource): (status: SaveStatus, message: string | null) => void {
    return (status, message) => {
      this.reports.set(source, { status, message });
      const worst = WORST.find((s) =>
        [...this.reports.values()].some((report) => report.status === s),
      );
      const holders = [...this.reports.entries()].filter(([, report]) => report.status === worst);
      const shown =
        holders.find(([held]) => held === this.shown) ??
        holders.find(([held]) => held === source) ??
        holders[0];
      this.shown = shown?.[0] ?? null;
      this.emit(
        shown?.[1].status ?? IDLE.status,
        shown?.[1].message ?? IDLE.message,
        shown?.[0] ?? source,
        { source, status },
      );
    };
  }
}
