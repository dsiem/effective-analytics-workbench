import type { GenieContext } from "../../../../shared/genie";
import type { Filters } from "../../../../shared/filters";
import type { Model } from "./model";
export type ViewModel = Model & {
  readonly mobile: boolean;
  readonly filters: Filters | null;
  readonly context: GenieContext;
};
