// Adapted from Lucide 0.468.0.
// License: lucide-LICENSE.txt
import type { H } from "../primitives.js";

const shapes = {
  "arrow-down-up": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "m3 16 4 4 4-4M7 20V4m6 4 4-4 4 4m-4-4v16")], []),
  ],
  lock: <Message>(h: H<Message>) => [
    h.rect(
      [
        h.Attribute("x", "4"),
        h.Attribute("y", "10"),
        h.Attribute("width", "16"),
        h.Attribute("height", "11"),
        h.Attribute("rx", "2"),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M8 10V7a4 4 0 0 1 8 0v3")], []),
  ],
  search: <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "m21 21-4.3-4.3")], []),
    h.circle(
      [h.Attribute("cx", "11"), h.Attribute("cy", "11"), h.Attribute("r", "8")],
      [],
    ),
  ],
  "layout-dashboard": <Message>(h: H<Message>) => [
    h.rect(
      [
        h.Attribute("width", "7"),
        h.Attribute("height", "9"),
        h.Attribute("x", "3"),
        h.Attribute("y", "3"),
        h.Attribute("rx", "1"),
      ],
      [],
    ),
    h.rect(
      [
        h.Attribute("width", "7"),
        h.Attribute("height", "5"),
        h.Attribute("x", "14"),
        h.Attribute("y", "3"),
        h.Attribute("rx", "1"),
      ],
      [],
    ),
    h.rect(
      [
        h.Attribute("width", "7"),
        h.Attribute("height", "9"),
        h.Attribute("x", "14"),
        h.Attribute("y", "12"),
        h.Attribute("rx", "1"),
      ],
      [],
    ),
    h.rect(
      [
        h.Attribute("width", "7"),
        h.Attribute("height", "5"),
        h.Attribute("x", "3"),
        h.Attribute("y", "16"),
        h.Attribute("rx", "1"),
      ],
      [],
    ),
  ],
  "table-2": <Message>(h: H<Message>) => [
    h.path(
      [
        h.Attribute(
          "d",
          "M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18",
        ),
      ],
      [],
    ),
  ],
  map: <Message>(h: H<Message>) => [
    h.path(
      [
        h.Attribute(
          "d",
          "M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z",
        ),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M15 5.764v15")], []),
    h.path([h.Attribute("d", "M9 3.236v15")], []),
  ],
  "book-open": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M12 7v14")], []),
    h.path(
      [
        h.Attribute(
          "d",
          "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
        ),
      ],
      [],
    ),
  ],
  sparkles: <Message>(h: H<Message>) => [
    h.path(
      [
        h.Attribute(
          "d",
          "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
        ),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M20 3v4")], []),
    h.path([h.Attribute("d", "M22 5h-4")], []),
    h.path([h.Attribute("d", "M4 17v2")], []),
    h.path([h.Attribute("d", "M5 18H3")], []),
  ],
  "car-taxi-front": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M10 2h4")], []),
    h.path(
      [
        h.Attribute(
          "d",
          "m21 8-2 2-1.5-3.7A2 2 0 0 0 15.646 5H8.4a2 2 0 0 0-1.903 1.257L5 10 3 8",
        ),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M7 14h.01")], []),
    h.path([h.Attribute("d", "M17 14h.01")], []),
    h.rect(
      [
        h.Attribute("width", "18"),
        h.Attribute("height", "8"),
        h.Attribute("x", "3"),
        h.Attribute("y", "10"),
        h.Attribute("rx", "2"),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M5 18v2")], []),
    h.path([h.Attribute("d", "M19 18v2")], []),
  ],
  "circle-dollar-sign": <Message>(h: H<Message>) => [
    h.circle(
      [
        h.Attribute("cx", "12"),
        h.Attribute("cy", "12"),
        h.Attribute("r", "10"),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8")], []),
    h.path([h.Attribute("d", "M12 18V6")], []),
  ],
  activity: <Message>(h: H<Message>) => [
    h.path(
      [
        h.Attribute(
          "d",
          "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
        ),
      ],
      [],
    ),
  ],
  route: <Message>(h: H<Message>) => [
    h.circle(
      [h.Attribute("cx", "6"), h.Attribute("cy", "19"), h.Attribute("r", "3")],
      [],
    ),
    h.path(
      [
        h.Attribute(
          "d",
          "M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15",
        ),
      ],
      [],
    ),
    h.circle(
      [h.Attribute("cx", "18"), h.Attribute("cy", "5"), h.Attribute("r", "3")],
      [],
    ),
  ],
  "panel-left": <Message>(h: H<Message>) => [
    h.rect(
      [
        h.Attribute("width", "18"),
        h.Attribute("height", "18"),
        h.Attribute("x", "3"),
        h.Attribute("y", "3"),
        h.Attribute("rx", "2"),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M9 3v18")], []),
  ],
  menu: <Message>(h: H<Message>) => [
    h.line(
      [
        h.Attribute("x1", "4"),
        h.Attribute("x2", "20"),
        h.Attribute("y1", "12"),
        h.Attribute("y2", "12"),
      ],
      [],
    ),
    h.line(
      [
        h.Attribute("x1", "4"),
        h.Attribute("x2", "20"),
        h.Attribute("y1", "6"),
        h.Attribute("y2", "6"),
      ],
      [],
    ),
    h.line(
      [
        h.Attribute("x1", "4"),
        h.Attribute("x2", "20"),
        h.Attribute("y1", "18"),
        h.Attribute("y2", "18"),
      ],
      [],
    ),
  ],
  x: <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M18 6 6 18")], []),
    h.path([h.Attribute("d", "m6 6 12 12")], []),
  ],
  "chevron-left": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "m15 18-6-6 6-6")], []),
  ],
  "chevron-right": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "m9 18 6-6-6-6")], []),
  ],
  "chevron-down": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "m6 9 6 6 6-6")], []),
  ],
  "calendar-days": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M8 2v4")], []),
    h.path([h.Attribute("d", "M16 2v4")], []),
    h.rect(
      [
        h.Attribute("width", "18"),
        h.Attribute("height", "18"),
        h.Attribute("x", "3"),
        h.Attribute("y", "4"),
        h.Attribute("rx", "2"),
      ],
      [],
    ),
    h.path([h.Attribute("d", "M3 10h18")], []),
    h.path([h.Attribute("d", "M8 14h.01")], []),
    h.path([h.Attribute("d", "M12 14h.01")], []),
    h.path([h.Attribute("d", "M16 14h.01")], []),
    h.path([h.Attribute("d", "M8 18h.01")], []),
    h.path([h.Attribute("d", "M12 18h.01")], []),
    h.path([h.Attribute("d", "M16 18h.01")], []),
  ],
  "maximize-2": <Message>(h: H<Message>) => [
    h.polyline([h.Attribute("points", "15 3 21 3 21 9")], []),
    h.polyline([h.Attribute("points", "9 21 3 21 3 15")], []),
    h.line(
      [
        h.Attribute("x1", "21"),
        h.Attribute("x2", "14"),
        h.Attribute("y1", "3"),
        h.Attribute("y2", "10"),
      ],
      [],
    ),
    h.line(
      [
        h.Attribute("x1", "3"),
        h.Attribute("x2", "10"),
        h.Attribute("y1", "21"),
        h.Attribute("y2", "14"),
      ],
      [],
    ),
  ],
  "minimize-2": <Message>(h: H<Message>) => [
    h.polyline([h.Attribute("points", "4 14 10 14 10 20")], []),
    h.polyline([h.Attribute("points", "20 10 14 10 14 4")], []),
    h.line(
      [
        h.Attribute("x1", "14"),
        h.Attribute("x2", "21"),
        h.Attribute("y1", "10"),
        h.Attribute("y2", "3"),
      ],
      [],
    ),
    h.line(
      [
        h.Attribute("x1", "3"),
        h.Attribute("x2", "10"),
        h.Attribute("y1", "21"),
        h.Attribute("y2", "14"),
      ],
      [],
    ),
  ],
  plus: <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M5 12h14")], []),
    h.path([h.Attribute("d", "M12 5v14")], []),
  ],
  pencil: <Message>(h: H<Message>) => [
    h.path(
      [
        h.Attribute(
          "d",
          "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
        ),
      ],
      [],
    ),
    h.path([h.Attribute("d", "m15 5 4 4")], []),
  ],
  "trash-2": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M3 6h18")], []),
    h.path([h.Attribute("d", "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6")], []),
    h.path([h.Attribute("d", "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2")], []),
    h.line(
      [
        h.Attribute("x1", "10"),
        h.Attribute("x2", "10"),
        h.Attribute("y1", "11"),
        h.Attribute("y2", "17"),
      ],
      [],
    ),
    h.line(
      [
        h.Attribute("x1", "14"),
        h.Attribute("x2", "14"),
        h.Attribute("y1", "11"),
        h.Attribute("y2", "17"),
      ],
      [],
    ),
  ],
  "arrow-up-right": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M7 7h10v10")], []),
    h.path([h.Attribute("d", "M7 17 17 7")], []),
  ],
  "arrow-up": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "m5 12 7-7 7 7")], []),
    h.path([h.Attribute("d", "M12 19V5")], []),
  ],
  pin: <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M12 17v5")], []),
    h.path(
      [
        h.Attribute(
          "d",
          "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
        ),
      ],
      [],
    ),
  ],
  "pin-off": <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M12 17v5")], []),
    h.path(
      [h.Attribute("d", "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89")],
      [],
    ),
    h.path([h.Attribute("d", "m2 2 20 20")], []),
    h.path(
      [
        h.Attribute(
          "d",
          "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
        ),
      ],
      [],
    ),
  ],
  sun: <Message>(h: H<Message>) => [
    h.circle(
      [h.Attribute("cx", "12"), h.Attribute("cy", "12"), h.Attribute("r", "4")],
      [],
    ),
    h.path([h.Attribute("d", "M12 2v2")], []),
    h.path([h.Attribute("d", "M12 20v2")], []),
    h.path([h.Attribute("d", "m4.93 4.93 1.41 1.41")], []),
    h.path([h.Attribute("d", "m17.66 17.66 1.41 1.41")], []),
    h.path([h.Attribute("d", "M2 12h2")], []),
    h.path([h.Attribute("d", "M20 12h2")], []),
    h.path([h.Attribute("d", "m6.34 17.66-1.41 1.41")], []),
    h.path([h.Attribute("d", "m19.07 4.93-1.41 1.41")], []),
  ],
  moon: <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z")], []),
  ],
  monitor: <Message>(h: H<Message>) => [
    h.rect(
      [
        h.Attribute("width", "20"),
        h.Attribute("height", "14"),
        h.Attribute("x", "2"),
        h.Attribute("y", "3"),
        h.Attribute("rx", "2"),
      ],
      [],
    ),
    h.line(
      [
        h.Attribute("x1", "8"),
        h.Attribute("x2", "16"),
        h.Attribute("y1", "21"),
        h.Attribute("y2", "21"),
      ],
      [],
    ),
    h.line(
      [
        h.Attribute("x1", "12"),
        h.Attribute("x2", "12"),
        h.Attribute("y1", "17"),
        h.Attribute("y2", "21"),
      ],
      [],
    ),
  ],
  check: <Message>(h: H<Message>) => [
    h.path([h.Attribute("d", "M20 6 9 17l-5-5")], []),
  ],
  "message-square": <Message>(h: H<Message>) => [
    h.path(
      [
        h.Attribute(
          "d",
          "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
        ),
      ],
      [],
    ),
  ],
};

export type IconName = keyof typeof shapes;

export const icon = <Message>(h: H<Message>, name: IconName) =>
  h.svg(
    [
      h.Class("icon"),
      h.ViewBox("0 0 24 24"),
      h.Width("16"),
      h.Height("16"),
      h.Fill("none"),
      h.Stroke("currentColor"),
      h.StrokeWidth("2"),
      h.StrokeLinecap("round"),
      h.StrokeLinejoin("round"),
      h.AriaHidden(true),
      h.Attribute("focusable", "false"),
    ],
    shapes[name](h),
  );
