import type {
  GpsCell,
  MapCellSummary,
  MapSummary,
  TripMap,
} from "../../../../shared/map-dataset.js";

export const activityBucket = (trips: number, maximum: number) =>
  Math.min(4, Math.floor((trips / maximum) ** 0.32 * 5));

export interface MapResource {
  readonly summary: MapSummary;
  readonly rows: ReadonlyArray<GpsCell>;
  cell(index: number): MapCellSummary | undefined;
  index(id: string): number;
  ring(index: number): number[][];
}
export const summarizeCell = ({
  boundary: _,
  ...cell
}: GpsCell): MapCellSummary => cell;
export function jsonMap(data: TripMap): MapResource {
  const { cells: rows, ...totals } = data;
  const indices = new Map(rows.map((cell, i) => [cell.id, i]));
  if (indices.size !== rows.length) throw new Error("Duplicate map cell");
  return {
    summary: {
      ...totals,
      loaded: rows.length,
      cells: rows.slice(0, 5).map(summarizeCell),
    },
    rows,
    cell: (index) => (rows[index] ? summarizeCell(rows[index]) : undefined),
    index: (id) => indices.get(id) ?? -1,
    ring: (index) => rows[index]?.boundary.coordinates[0] ?? [],
  };
}

export function pickedIndex(
  resource: MapResource,
  layerId: string,
  index: number,
) {
  return layerId === "gps-cells" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < resource.rows.length
    ? index
    : -1;
}
