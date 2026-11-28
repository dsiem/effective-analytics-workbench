import { compact, number } from "./format.js";
import type { H } from "./primitives.js";

export const chart = <Message>(
  h: H<Message>,
  {
    data,
    title,
    kind,
    formatValue = number,
    formatTick = compact,
    width = 700,
  }: {
    readonly data: ReadonlyArray<{
      readonly label: string;
      readonly value: number;
    }>;
    readonly title: string;
    readonly kind: "area" | "bar";
    readonly width?: number;
    readonly formatValue?: (value: number) => string;
    readonly formatTick?: (value: number) => string;
  },
) => {
  const low = Math.min(0, ...data.map((row) => row.value));
  const high = Math.max(0, ...data.map((row) => row.value));
  // Round the domain to readable axis intervals while retaining zero and signed values.
  const target = (high - low || 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step =
    ([1, 2, 5, 10].find((factor) => factor * magnitude >= target) ?? 10) *
    magnitude;
  const min = Math.floor(low / step) * step;
  const max = high === low ? min + step : Math.ceil(high / step) * step;
  const range = max - min;
  const ticks = Array.from(
    { length: Math.round(range / step) + 1 },
    (_, index) => min + index * step,
  );
  const plotWidth = width - 88;
  const x = (i: number) =>
    56 +
    (kind === "bar" || data.length === 1
      ? ((i + 0.5) * plotWidth) / data.length
      : (i * plotWidth) / (data.length - 1));
  const y = (value: number) => 215 - ((value - min) / range) * 180;
  const baseline = y(0);
  const barWidth = Math.max(1, plotWidth / Math.max(1, data.length) - 5);
  const points = data.map((row, i) => `${x(i)},${y(row.value)}`).join(" ");
  return h.svg(
    [
      h.ViewBox(`0 0 ${width} 260`),
      h.Role("img"),
      h.AriaLabel(title),
      h.Class("chart"),
    ],
    [
      h.title([], [title]),
      ...ticks.flatMap((value) => [
        h.line(
          [
            h.Attribute("x1", "56"),
            h.Attribute("x2", String(width - 20)),
            h.Attribute("y1", String(y(value))),
            h.Attribute("y2", String(y(value))),
            h.Class("chart-grid"),
          ],
          [],
        ),
        h.text(
          [
            h.Attribute("x", "48"),
            h.Attribute("text-anchor", "end"),
            h.Attribute("y", String(y(value) + 4)),
            h.Class("chart-tick"),
            h.Attribute("font-size", "11"),
          ],
          [formatTick(value)],
        ),
      ]),
      h.line(
        [
          h.Attribute("x1", "56"),
          h.Attribute("x2", String(width - 20)),
          h.Attribute("y1", String(baseline)),
          h.Attribute("y2", String(baseline)),
          h.Stroke("var(--border, #e4e7ee)"),
        ],
        [],
      ),
      ...(kind === "area" && data.length
        ? [
            h.polygon(
              [
                h.Attribute(
                  "points",
                  `${x(0)},${baseline} ${points} ${x(data.length - 1)},${baseline}`,
                ),
                h.Fill("var(--chart-color, #4f46e5)"),
                h.Attribute("opacity", "0.08"),
              ],
              [],
            ),
            h.polyline(
              [
                h.Attribute("points", points),
                h.Fill("none"),
                h.Class("chart-line"),
                h.Attribute("stroke-width", "2.5"),
              ],
              [],
            ),
          ]
        : []),
      ...data.map((row, i) =>
        kind === "bar"
          ? h.rect(
              [
                h.Attribute("x", String(x(i) - barWidth / 2)),
                h.Attribute("y", String(Math.min(baseline, y(row.value)))),
                h.Attribute("width", String(barWidth)),
                h.Attribute(
                  "height",
                  String(Math.abs(baseline - y(row.value))),
                ),
                h.Attribute("rx", "3"),
                h.Class("chart-bar"),
                h.Fill("var(--chart-color, #4f46e5)"),
              ],
              [h.title([], [`${row.label}: ${formatValue(row.value)}`])],
            )
          : h.circle(
              [
                h.Attribute("cx", String(x(i))),
                h.Attribute("cy", String(y(row.value))),
                h.Attribute("r", data.length > 8 ? "2.5" : "4"),
                h.Class("chart-point"),
                h.Fill("var(--chart-color, #4f46e5)"),
              ],
              [h.title([], [`${row.label}: ${formatValue(row.value)}`])],
            ),
      ),
      ...data.flatMap((row, index) =>
        index % Math.max(1, Math.ceil(data.length / 6)) === 0
          ? [
              h.text(
                [
                  h.Attribute("x", String(x(index))),
                  h.Attribute("y", "245"),
                  h.Class("chart-tick"),
                  h.Attribute("font-size", "12"),
                  h.Attribute("text-anchor", "middle"),
                ],
                [row.label],
              ),
            ]
          : [],
      ),
    ],
  );
};
