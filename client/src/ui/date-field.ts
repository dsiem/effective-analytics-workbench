import { type Calendar, DatePicker, Input } from "@foldkit/ui";
import { Match, Option } from "effect";
import type { ChildAttribute } from "foldkit/html";
import { calendarDay } from "../lib/format";
import { icon } from "./icons";
import { button, type Child, type H } from "./primitives";

function calendarView<Message>(
  h: H<Message>,
  attributes: Calendar.CalendarAttributes,
  model: DatePicker.Model,
): Child {
  const nav = (
    attrs: ReadonlyArray<ChildAttribute>,
    direction: "previous" | "next",
    disabled = false,
  ) =>
    h.button(
      [...attrs, h.Disabled(disabled), h.Class("calendar-nav")],
      [icon(h, direction === "previous" ? "chevron-left" : "chevron-right")],
    );
  const heading = (
    attrs: ReadonlyArray<ChildAttribute>,
    title: { readonly id: string; readonly text: string },
  ) =>
    h.button(
      [...attrs, h.Id(title.id), h.Class("calendar-heading")],
      [title.text, icon(h, "chevron-down")],
    );
  const minimum = model.calendar.maybeMinDate;
  const maximum = model.calendar.maybeMaxDate;
  return Match.valueTags(attributes, {
    Days: (attributes) => {
      const current = model.calendar.viewYear * 12 + model.calendar.viewMonth;
      return h.div(
        [...attributes.root, h.Class("calendar")],
        [
          h.div(
            [h.Class("calendar-header")],
            [
              nav(
                attributes.previousMonthButton,
                "previous",
                Option.exists(
                  minimum,
                  (date) => current <= date.year * 12 + date.month,
                ),
              ),
              heading(attributes.headingButton, attributes.heading),
              nav(
                attributes.nextMonthButton,
                "next",
                Option.exists(
                  maximum,
                  (date) => current >= date.year * 12 + date.month,
                ),
              ),
            ],
          ),
          h.div(
            [...attributes.grid, h.Class("calendar-grid")],
            [
              h.div(
                [...attributes.headerRow, h.Class("calendar-week")],
                attributes.columnHeaders.map((column) =>
                  h.div(
                    [...column.attributes, h.Class("calendar-weekday")],
                    [column.name],
                  ),
                ),
              ),
              ...attributes.weeks.map((week) =>
                h.div(
                  [...week.attributes, h.Class("calendar-week")],
                  week.cells.map((cell) =>
                    h.div(
                      [...cell.cellAttributes, h.Class("calendar-cell")],
                      [
                        h.button(
                          [
                            ...cell.buttonAttributes,
                            h.Disabled(cell.isDisabled),
                            h.Class("calendar-day"),
                          ],
                          [cell.label],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      );
    },
    Months: (attributes) =>
      h.div(
        [...attributes.root, h.Class("calendar")],
        [
          h.div(
            [h.Class("calendar-header justify-center")],
            [heading(attributes.headingButton, attributes.heading)],
          ),
          h.div(
            [...attributes.grid, h.Class("calendar-periods")],
            attributes.cells.map((cell) =>
              h.div(
                [...cell.cellAttributes, h.Class("calendar-cell")],
                [
                  h.button(
                    [
                      ...cell.buttonAttributes,
                      h.Disabled(cell.isDisabled),
                      h.Class("calendar-period"),
                    ],
                    [cell.shortLabel],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    Years: (attributes) =>
      h.div(
        [...attributes.root, h.Class("calendar")],
        [
          h.div(
            [h.Class("calendar-header")],
            [
              nav(
                attributes.previousPageButton,
                "previous",
                Option.exists(
                  minimum,
                  (date) =>
                    (attributes.cells[0]?.year ?? date.year) <= date.year,
                ),
              ),
              h.h2(
                [h.Id(attributes.heading.id), h.Class("calendar-heading")],
                [attributes.heading.text],
              ),
              nav(
                attributes.nextPageButton,
                "next",
                Option.exists(
                  maximum,
                  (date) =>
                    (attributes.cells.at(-1)?.year ?? date.year) >= date.year,
                ),
              ),
            ],
          ),
          h.div(
            [...attributes.grid, h.Class("calendar-periods")],
            attributes.cells.map((cell) =>
              h.div(
                [...cell.cellAttributes, h.Class("calendar-cell")],
                [
                  h.button(
                    [
                      ...cell.buttonAttributes,
                      h.Disabled(cell.isDisabled),
                      h.Class("calendar-period"),
                    ],
                    [cell.label],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
  });
}

/** Editable ISO date plus a bounded Foldkit calendar; no native-picker defaults. */
export function dateField<Message>(
  h: H<Message>,
  options: {
    readonly id: string;
    readonly label: string;
    readonly calendarLabel: string;
    readonly value: string;
    readonly model: Option.Option<DatePicker.Model>;
    readonly onInput: (value: string) => Message;
    readonly onMessage: (message: DatePicker.Message) => Message;
  },
) {
  const picker = Option.getOrUndefined(options.model);
  return Input.view(
    {
      id: options.id,
      value: options.value,
      onInput: options.onInput,
      placeholder: "YYYY-MM-DD",
      toView: ({ label, input }) =>
        h.div(
          [h.Class("field")],
          [
            h.label([...label, h.Class("field-label")], [options.label]),
            h.div(
              [h.Class("date-control")],
              [
                h.input([
                  ...input,
                  h.Class("input date-input"),
                  h.Pattern("[0-9]{4}-[0-9]{2}-[0-9]{2}"),
                  h.Maxlength(10),
                  h.Autocomplete("off"),
                  h.Spellcheck(false),
                ]),
                h.div(
                  [h.Class("date-picker-anchor")],
                  [
                    picker
                      ? h.submodel({
                          slotId: picker.id,
                          model: picker,
                          view: DatePicker.view,
                          toParentMessage: options.onMessage,
                          viewInputs: {
                            anchor: {
                              placement: "bottom-start",
                              gap: 8,
                              padding: 12,
                            },
                            maybeSelectedDate: calendarDay(options.value),
                            ariaLabel: options.calendarLabel,
                            triggerContent: () => icon(h, "calendar-days"),
                            className: "date-picker",
                            triggerClassName: "date-trigger",
                            panelClassName: "date-panel",
                            backdropClassName: "picker-backdrop",

                            toCalendarView: (attributes) =>
                              h.div(
                                [
                                  h.Role("dialog"),
                                  h.AriaLabel(options.calendarLabel),
                                ],
                                [
                                  calendarView(h, attributes, picker),
                                  ...(options.value
                                    ? [
                                        button(h, {
                                          label: "Clear date",
                                          variant: "ghost",
                                          size: "small",
                                          className: "calendar-clear",
                                          onClick: options.onMessage(
                                            DatePicker.Message.Cleared(),
                                          ),
                                        }),
                                      ]
                                    : []),
                                ],
                              ),
                          },
                        })
                      : h.button(
                          [
                            h.Type("button"),
                            h.Disabled(true),
                            h.AriaLabel(options.calendarLabel),
                            h.Title("Enter the date as YYYY-MM-DD"),
                            h.Class("date-trigger"),
                          ],
                          [icon(h, "calendar-days")],
                        ),
                  ],
                ),
              ],
            ),
          ],
        ),
    },
    h,
  );
}
