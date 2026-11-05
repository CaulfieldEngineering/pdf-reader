import type { Document, GroupId } from "../model";

/**
 * A skip detector. It labels blocks (`label(block, kind, reason)`) or adds
 * inline spans (`block.spans`). Detectors never delete anything: the UI
 * decides what to read from the labels and the user's settings, so a wrong
 * guess costs a skipped sentence that is still visible (dimmed) on the page.
 */
export interface Detector {
  name: string;
  group: GroupId;
  run(doc: Document): void;
}

export interface GroupChoice {
  id: string;
  label: string;
}

/** A skip group, shown as one toggle (or a select, with choices) in Settings. */
export interface SkipGroup {
  id: GroupId;
  label: string;
  help: string;
  /** For a select: the choices. "skip" means skip. */
  choices?: GroupChoice[];
  default: boolean | string;
}
