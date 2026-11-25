import type {
  GpsCell,
  GpsEndpoint,
  TripMap,
} from "@dsiem/analytics-shared/map-dataset";

const cells: GpsCell[] = [
  {
    id: "8a2a100d2c17fff",
    longitude: -73.991545695,
    latitude: 40.750144147,
    boundary: {
      type: "Polygon",
      coordinates: [
        [
          [-73.991264989, 40.750781242],
          [-73.992176329, 40.750630661],
          [-73.992457022, 40.749993565],
          [-73.991826393, 40.749507057],
          [-73.990915074, 40.749657634],
          [-73.990634362, 40.750294723],
          [-73.991264989, 40.750781242],
        ],
      ],
    },
    trips: 60,
    avg_fare: 11.25,
    avg_distance: 2,
    zip: "10001",
  },
  {
    id: "8a2a100d2cb7fff",
    longitude: -73.994629658,
    latitude: 40.750815979,
    boundary: {
      type: "Polygon",
      coordinates: [
        [
          [-73.994348989, 40.751453087],
          [-73.995260335, 40.751302481],
          [-73.995540991, 40.750665372],
          [-73.994910319, 40.750178876],
          [-73.993998994, 40.750329478],
          [-73.99371832, 40.75096658],
          [-73.994348989, 40.751453087],
        ],
      ],
    },
    trips: 20,
    avg_fare: 13,
    avg_distance: 3,
    zip: "10119",
  },
];

export const gpsFixture = (endpoint: GpsEndpoint = "pickup"): TripMap => ({
  endpoint,
  matchingTrips: 100,
  locatedTrips: 80,
  shownTrips: 80,
  totalCells: cells.length,
  truncated: false,
  cells: cells.map((cell) => ({
    ...cell,
    boundary: { ...cell.boundary, type: "Polygon" as const },
  })),
  queriedAt: "2026-11-15T10:00:00Z",
});
