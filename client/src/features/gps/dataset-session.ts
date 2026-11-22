import type { GpsEndpoint, MapSummary } from "../../../../shared/map-dataset";
import type { Filters } from "../../../../shared/filters";
import type { MapResource } from "./dataset";
import { dataKey } from "./model";

export type MapQuery = {
  readonly query: string;
  readonly filters: Filters;
  readonly endpoint: GpsEndpoint;
  readonly revision: number;
};
export type MapSessionEvent =
  | { readonly _tag: "Loaded"; readonly key: string; readonly data: MapSummary }
  | { readonly _tag: "Failed"; readonly key: string; readonly error: unknown };

export function createMapSession({
  load,
  notify,
}: {
  readonly load: (input: MapQuery, signal: AbortSignal) => Promise<MapResource>;
  readonly notify: (event: MapSessionEvent) => void;
}) {
  let resource: MapResource | undefined;
  let active:
    | { readonly key: string; readonly controller: AbortController }
    | undefined;
  let disposed = false;

  return {
    current: () => resource,
    async replace(input: MapQuery): Promise<void> {
      const key = dataKey(input.query, input.endpoint, input.revision);
      if (disposed || active?.key === key) return;
      active?.controller.abort();
      const run = { key, controller: new AbortController() };
      active = run;
      let next: MapResource;
      try {
        next = await load(input, run.controller.signal);
      } catch (error) {
        if (!disposed && active === run) notify({ _tag: "Failed", key, error });
        return;
      }
      if (disposed || active !== run) return;
      resource = next;
      notify({ _tag: "Loaded", key, data: next.summary });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.controller.abort();
      active = undefined;
      resource = undefined;
    },
  };
}
