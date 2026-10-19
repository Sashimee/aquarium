import type { SaveSource, SaveStatus } from '../interaction/events';

interface Report {
  status: SaveStatus;
  message: string | null;
}

const IDLE: Report = { status: 'idle', message: null };
const WORST: readonly SaveStatus[] = ['error', 'retrying', 'saving', 'saved'];

/**
 * One status for several savers: a failure stays on show until the failed saver succeeds or is
 * reset, so a later success elsewhere cannot hide it.
 */
export class SaveStatusMerge {
  private readonly reports = new Map<SaveSource, Report>();

  constructor(
    private readonly emit: (status: SaveStatus, message: string | null, source: SaveSource) => void,
  ) {}

  reporter(source: SaveSource): (status: SaveStatus, message: string | null) => void {
    return (status, message) => {
      this.reports.set(source, { status, message });
      const worst = WORST.find((s) =>
        [...this.reports.values()].some((report) => report.status === s),
      );
      const shown = [...this.reports.values()].find((report) => report.status === worst) ?? IDLE;
      this.emit(shown.status, shown.message, source);
    };
  }
}
