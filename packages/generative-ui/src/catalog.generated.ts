// Generated from @assistant-ui/generative-ui 0.0.12. Run npm run generate -w @pi-bot/generative-ui.
export const widgetCatalog = {
  "Header": {
    "description": "A section heading. Renders as a bold title.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "text": {
          "description": "The heading text or number.",
          "type": [
            "string",
            "number"
          ]
        },
        "size": {
          "description": "Heading size; defaults to `lg`.",
          "type": "string",
          "enum": [
            "sm",
            "md",
            "lg",
            "xl",
            "2xl",
            "3xl"
          ]
        }
      },
      "required": [
        "text"
      ],
      "additionalProperties": false
    }
  },
  "Text": {
    "description": "A run of text. Use for paragraphs, labels, or inline copy.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "value": {
          "description": "The text or number to display.",
          "type": [
            "string",
            "number"
          ]
        },
        "size": {
          "description": "Text size; defaults to `md`.",
          "type": "string",
          "enum": [
            "sm",
            "md",
            "lg",
            "xl",
            "2xl",
            "3xl"
          ]
        },
        "weight": {
          "description": "Font weight.",
          "type": "string",
          "enum": [
            "normal",
            "medium",
            "semibold",
            "bold"
          ]
        },
        "color": {
          "description": "Foreground color token.",
          "type": "string",
          "enum": [
            "emphasis",
            "secondary",
            "alpha-70",
            "white",
            "white-70",
            "white-50"
          ]
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    }
  },
  "Caption": {
    "description": "Secondary, de-emphasized text under a primary element.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "value": {
          "description": "The caption text or number.",
          "type": [
            "string",
            "number"
          ]
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    }
  },
  "Image": {
    "description": "An image. Provide `src` and `alt` for accessibility. Put several images in a `Row` for a gallery, or a `sm` image beside text for a thumbnail.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "src": {
          "type": "string",
          "description": "Image URL, taken from a tool result or the user; never invent one."
        },
        "alt": {
          "type": "string",
          "description": "Alt text for accessibility."
        },
        "size": {
          "description": "Size token or pixel value.",
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "sm",
                "md",
                "lg"
              ]
            },
            {
              "type": "number"
            }
          ]
        },
        "round": {
          "description": "Render as a circular avatar (fully rounded, cropped to a square).",
          "type": "boolean"
        }
      },
      "required": [
        "src",
        "alt"
      ],
      "additionalProperties": false
    }
  },
  "Divider": {
    "description": "A horizontal rule between sections.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "flush": {
          "description": "Whether the divider spans the full width with no inset.",
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  "Diagram": {
    "description": "A diagram drawn from Mermaid source, such as a flowchart, a sequence of messages, or the states of a process. Keep it small and label the nodes in plain words.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "description": "Mermaid source, such as `flowchart LR` followed by `A[Order] --> B[Ship]`."
        },
        "title": {
          "description": "A caption for the diagram, as text or a number.",
          "type": [
            "string",
            "number"
          ]
        }
      },
      "required": [
        "code"
      ],
      "additionalProperties": false
    }
  },
  "Map": {
    "description": "Places on a map, such as the stops of a trip or locations to compare, with an optional route through them in order.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "places": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string",
                "description": "The place's name."
              },
              "lat": {
                "type": "number",
                "description": "Latitude in degrees."
              },
              "lng": {
                "type": "number",
                "description": "Longitude in degrees."
              },
              "detail": {
                "description": "A short note about the place.",
                "type": "string"
              }
            },
            "required": [
              "label",
              "lat",
              "lng"
            ],
            "additionalProperties": false
          },
          "description": "The places, in order."
        },
        "route": {
          "description": "Draw a line through the places in order.",
          "type": "boolean"
        }
      },
      "required": [
        "places"
      ],
      "additionalProperties": false
    }
  },
  "Fact": {
    "description": "A label/value pair, rendered as a key followed by its value. Use for compact metadata, and put an answer's key figures side by side in a `Row`.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "label": {
          "description": "The fact label (key) as text or a number.",
          "type": [
            "string",
            "number"
          ]
        },
        "value": {
          "description": "The fact value as text or a number.",
          "type": [
            "string",
            "number"
          ]
        },
        "delta": {
          "description": "Change from before.",
          "type": "string"
        },
        "trend": {
          "description": "Change direction.",
          "type": "string",
          "enum": [
            "up",
            "down",
            "flat"
          ]
        },
        "upIsGood": {
          "description": "Whether up is good.",
          "type": "boolean"
        }
      },
      "required": [
        "label",
        "value"
      ],
      "additionalProperties": false
    }
  },
  "Button": {
    "description": "A clickable button. Carries `_action` describing the side effect or resume value. Set `submit` to submit an ancestor Form/Card instead of firing `_action` on click.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "label": {
          "description": "Button label text or number.",
          "type": [
            "string",
            "number"
          ]
        },
        "buttonStyle": {
          "description": "Visual style.",
          "type": "string",
          "enum": [
            "primary",
            "secondary",
            "outline",
            "ghost",
            "danger"
          ]
        },
        "block": {
          "description": "Whether the button spans the full width.",
          "type": "boolean"
        },
        "submit": {
          "description": "Render as a submit button for an ancestor Form/Card instead of a click button.",
          "type": "boolean"
        },
        "undoable": {
          "description": "Delay the action with an undo control, for sends and other hard-to-reverse actions.",
          "type": "boolean"
        }
      },
      "required": [
        "label"
      ],
      "additionalProperties": false
    }
  },
  "Select": {
    "description": "A dropdown selector. Carries `_action` describing the on-select behavior.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string"
              },
              "value": {
                "type": "string"
              }
            },
            "required": [
              "label",
              "value"
            ],
            "additionalProperties": false
          },
          "description": "Selectable options."
        },
        "placeholder": {
          "description": "Placeholder text or number shown when nothing is selected.",
          "type": [
            "string",
            "number"
          ]
        },
        "label": {
          "description": "Accessible label for the control.",
          "type": "string"
        },
        "name": {
          "description": "Field name used inside a Form.",
          "type": "string"
        },
        "defaultValue": {
          "description": "Initially selected value.",
          "type": "string"
        },
        "required": {
          "description": "Require a selection in a form.",
          "type": "boolean"
        }
      },
      "required": [
        "options"
      ],
      "additionalProperties": false
    }
  },
  "Input": {
    "description": "A text input. Carries `_action` describing the on-submit behavior.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "inputType": {
          "description": "Single-line input type. Values remain strings.",
          "type": "string",
          "enum": [
            "text",
            "password",
            "number"
          ]
        },
        "placeholder": {
          "description": "Placeholder text.",
          "type": "string"
        },
        "multiline": {
          "description": "Render a textarea instead of a single-line input; ignored when `inputType` is `\"password\"` or `\"number\"`.",
          "type": "boolean"
        },
        "label": {
          "description": "Accessible label for the control.",
          "type": "string"
        },
        "name": {
          "description": "Field name used inside a Form.",
          "type": "string"
        },
        "defaultValue": {
          "description": "Initial text.",
          "type": "string"
        },
        "required": {
          "description": "Require a value in a form.",
          "type": "boolean"
        },
        "minLength": {
          "description": "Minimum text length.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxLength": {
          "description": "Maximum text length.",
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "min": {
          "description": "Minimum numeric value for a number input.",
          "type": "number"
        },
        "max": {
          "description": "Maximum numeric value for a number input.",
          "type": "number"
        }
      },
      "additionalProperties": false
    }
  },
  "DatePicker": {
    "description": "A date, datetime, or time input. Carries `_action`, which runs once per committed value: a pick from the picker, or a typed value on blur or Enter.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "inputType": {
          "description": "Temporal input type. Defaults to \"date\". Values remain strings.",
          "type": "string",
          "enum": [
            "date",
            "datetime",
            "time"
          ]
        },
        "value": {
          "description": "Initial value: YYYY-MM-DD for date, HH:mm or HH:mm:ss with optional fraction of at most 9 digits for time, YYYY-MM-DDTHH:mm with optional :ss and fraction of at most 9 digits for datetime. A datetime with Z or ±HH:mm is an instant, displayed in the viewer's time zone and submitted with the same offset and precision. A datetime without an offset is local and submitted unchanged. An empty datetime submits with the viewer's offset and seconds.",
          "type": "string"
        },
        "min": {
          "description": "Minimum value: YYYY-MM-DD for date, HH:mm or HH:mm:ss with optional fraction of at most 9 digits for time, YYYY-MM-DDTHH:mm with optional :ss and fraction of at most 9 digits for datetime. Datetimes with Z or ±HH:mm are converted to the viewer's time zone.",
          "type": "string"
        },
        "max": {
          "description": "Maximum value: YYYY-MM-DD for date, HH:mm or HH:mm:ss with optional fraction of at most 9 digits for time, YYYY-MM-DDTHH:mm with optional :ss and fraction of at most 9 digits for datetime. Datetimes with Z or ±HH:mm are converted to the viewer's time zone.",
          "type": "string"
        },
        "label": {
          "description": "Accessible label for the control.",
          "type": "string"
        },
        "name": {
          "description": "Field name used inside a Form.",
          "type": "string"
        },
        "required": {
          "description": "Require a date or time in a form.",
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  "Checkbox": {
    "description": "A checkbox with a label. Carries `_action` describing the on-change behavior.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "label": {
          "description": "Label text or number next to the checkbox.",
          "type": [
            "string",
            "number"
          ]
        },
        "name": {
          "description": "Field name used inside a Form.",
          "type": "string"
        },
        "required": {
          "description": "Require the checkbox to be checked.",
          "type": "boolean"
        },
        "defaultChecked": {
          "description": "Whether the checkbox starts checked.",
          "type": "boolean"
        },
        "variant": {
          "description": "Whether to render a checkbox or switch.",
          "type": "string",
          "enum": [
            "checkbox",
            "switch"
          ]
        }
      },
      "required": [
        "label"
      ],
      "additionalProperties": false
    }
  },
  "Slider": {
    "description": "A numeric range control. Carries `_action` describing the committed value.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "name": {
          "description": "Field name used inside a Form.",
          "type": "string"
        },
        "label": {
          "description": "Accessible label for the control.",
          "type": "string"
        },
        "min": {
          "type": "number",
          "description": "Minimum value."
        },
        "max": {
          "type": "number",
          "description": "Maximum value."
        },
        "step": {
          "description": "Value increment. Defaults to 1.",
          "type": "number"
        },
        "defaultValue": {
          "description": "Initial value.",
          "type": "number"
        },
        "unit": {
          "description": "Unit shown with the value.",
          "type": "string"
        }
      },
      "required": [
        "min",
        "max"
      ],
      "additionalProperties": false
    }
  },
  "RadioGroup": {
    "description": "A group of mutually exclusive radio options. Carries `_action` describing the on-change behavior.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string"
              },
              "value": {
                "type": "string"
              },
              "description": {
                "type": "string"
              }
            },
            "required": [
              "label",
              "value"
            ],
            "additionalProperties": false
          },
          "description": "Selectable options."
        },
        "name": {
          "description": "Field name used inside a Form.",
          "type": "string"
        },
        "label": {
          "description": "Accessible name for the group.",
          "type": "string"
        },
        "defaultValue": {
          "description": "Initially selected value.",
          "type": "string"
        },
        "required": {
          "description": "Require a selected option in a form.",
          "type": "boolean"
        }
      },
      "required": [
        "options"
      ],
      "additionalProperties": false
    }
  },
  "CheckboxGroup": {
    "description": "A group of checkbox options where any number can be checked. Set `progress` for a checklist the user works through. Carries `_action` describing the on-change behavior.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "options": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string"
              },
              "value": {
                "type": "string"
              },
              "description": {
                "type": "string"
              }
            },
            "required": [
              "label",
              "value"
            ],
            "additionalProperties": false
          },
          "description": "Selectable options."
        },
        "name": {
          "description": "Field name used inside a Form.",
          "type": "string"
        },
        "label": {
          "description": "Accessible name for the group.",
          "type": "string"
        },
        "defaultValue": {
          "description": "Initially checked values.",
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "progress": {
          "description": "Show how many options are checked, with a progress bar.",
          "type": "boolean"
        },
        "required": {
          "description": "Require at least one checked option in a form.",
          "type": "boolean"
        }
      },
      "required": [
        "options"
      ],
      "additionalProperties": false
    }
  },
  "Form": {
    "description": "Wraps named child controls (Select/Input/Checkbox/RadioGroup/CheckboxGroup/DatePicker with a `name`). Carries `_action`; on submit it fires with every named control's value, keyed by `name`.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "gap": {
          "description": "Gap between children in 4px units. 0 to 8 is the supported range.",
          "type": "number",
          "minimum": 0,
          "maximum": 8
        }
      },
      "additionalProperties": false
    }
  },
  "Card": {
    "description": "A module the reader scans or acts on, such as a summary, a checklist, a form, or one option in a comparison. It renders as a panel, so keep plain sections (a `Header` with `Text` or `Markdown`) outside cards, and do not wrap the whole answer in one card or nest cards. It takes on a framed surface when `background` is set, when `confirm`/`cancel` add a footer, or when it is a slot in a `Carousel`. Set `asForm` to collect named child control values on submit.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "title": {
          "description": "Optional card title text or number.",
          "type": [
            "string",
            "number"
          ]
        },
        "padding": {
          "description": "Padding in 4px units (e.g. 2 = 8px). 0 to 8 is the supported range.",
          "type": "number",
          "minimum": 0,
          "maximum": 8
        },
        "background": {
          "description": "Background color or gradient. Resource-loading functions and CSS escapes are ignored. Setting this also switches the card's own text to white, since a custom background makes the card a tinted surface; children can still opt into a different color explicitly.",
          "type": "string"
        },
        "asForm": {
          "description": "Render as a form; submitting it fires `confirm._action`, or the Card's own `_action` when `confirm` has none, with every named child control's value keyed by `name`.",
          "type": "boolean"
        },
        "confirm": {
          "description": "Confirm button shown in the footer.",
          "type": "object",
          "properties": {
            "label": {
              "description": "Footer button label text or number.",
              "type": [
                "string",
                "number"
              ]
            },
            "_action": {
              "description": "Action fired when the button is activated.",
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "description": "The action type, resolved by the host's action registry."
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": {}
            }
          },
          "required": [
            "label"
          ],
          "additionalProperties": false
        },
        "cancel": {
          "description": "Cancel button shown in the footer.",
          "type": "object",
          "properties": {
            "label": {
              "description": "Footer button label text or number.",
              "type": [
                "string",
                "number"
              ]
            },
            "_action": {
              "description": "Action fired when the button is activated.",
              "type": "object",
              "properties": {
                "type": {
                  "type": "string",
                  "description": "The action type, resolved by the host's action registry."
                }
              },
              "required": [
                "type"
              ],
              "additionalProperties": {}
            }
          },
          "required": [
            "label"
          ],
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }
  },
  "Col": {
    "description": "A vertical stack; children laid out top to bottom.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "gap": {
          "description": "Gap between children in 4px units. 0 to 8 is the supported range.",
          "type": "number",
          "minimum": 0,
          "maximum": 8
        },
        "align": {
          "description": "Cross-axis alignment.",
          "type": "string",
          "enum": [
            "start",
            "center",
            "end"
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "Row": {
    "description": "A horizontal row; children laid out left to right.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "gap": {
          "description": "Gap between children in 4px units. 0 to 8 is the supported range.",
          "type": "number",
          "minimum": 0,
          "maximum": 8
        },
        "align": {
          "description": "Cross-axis alignment.",
          "type": "string",
          "enum": [
            "start",
            "center",
            "end"
          ]
        },
        "justify": {
          "description": "Main-axis distribution.",
          "type": "string",
          "enum": [
            "start",
            "center",
            "end",
            "between"
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "Spacer": {
    "description": "Empty space that pushes neighbors apart.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "Badge": {
    "description": "A small labeled tag, e.g. for status or category.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "value": {
          "description": "Badge text or number.",
          "type": [
            "string",
            "number"
          ]
        },
        "variant": {
          "description": "Visual variant token.",
          "type": "string"
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    }
  },
  "Box": {
    "description": "A generic container for composition, e.g. a progress bar built from an outer track Box containing a partial-width fill Box. Size accepts numbers (pixels) and CSS lengths; background accepts colors and gradients. These render as inline styles rather than data-attribute hooks.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "width": {
          "description": "Width; a number is pixels, a string is a CSS length such as \"50%\" or \"12rem\".",
          "type": [
            "string",
            "number"
          ]
        },
        "height": {
          "description": "Height; a number is pixels, a string is a CSS length such as \"1.5rem\".",
          "type": [
            "string",
            "number"
          ]
        },
        "radius": {
          "description": "Corner radius; \"full\" is a pill/circle, a number is pixels.",
          "anyOf": [
            {
              "type": "string",
              "const": "full"
            },
            {
              "type": "number"
            }
          ]
        },
        "background": {
          "description": "Background color or gradient. Resource-loading functions and CSS escapes are ignored.",
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "Tabs": {
    "description": "Panels the user switches between with tabs, one visible at a time. Use it for parallel content the user looks at one part at a time, such as options, plans, or days. Each child is one panel, usually a Col, labeled by the matching entry in `tabs`.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "tabs": {
          "type": "array",
          "items": {
            "type": [
              "string",
              "number"
            ]
          },
          "description": "Tab labels as text or numbers, one per child panel, in order."
        },
        "label": {
          "description": "Accessible name as text or a number for the row of tabs.",
          "type": [
            "string",
            "number"
          ]
        }
      },
      "required": [
        "tabs"
      ],
      "additionalProperties": false
    }
  },
  "ListView": {
    "description": "A vertical list container. Wrap `ListViewItem` children as rows.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "ListViewItem": {
    "description": "A row inside a ListView. Carries `_action` to make the whole row clickable and keyboard-activatable.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  "Steps": {
    "description": "Numbered steps to follow in order, such as instructions or a how-to guide. Each step has a short `title` saying what to do and an optional `detail` on how.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "steps": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title": {
                "description": "What to do, in a few words, as text or a number.",
                "type": [
                  "string",
                  "number"
                ]
              },
              "detail": {
                "description": "How to do it, or what to watch for, as text or a number.",
                "type": [
                  "string",
                  "number"
                ]
              }
            },
            "required": [
              "title"
            ],
            "additionalProperties": false
          },
          "description": "The steps, in order."
        }
      },
      "required": [
        "steps"
      ],
      "additionalProperties": false
    }
  },
  "Timeline": {
    "description": "Events in time order, each with a time or date label, such as a schedule, an itinerary, or a history.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "time": {
                "description": "When it happens, as the user should read it, such as `Day 1`, `6:00 pm`, or `1969`, as text or a number.",
                "type": [
                  "string",
                  "number"
                ]
              },
              "title": {
                "description": "What happens, as text or a number.",
                "type": [
                  "string",
                  "number"
                ]
              },
              "detail": {
                "description": "More about it, as text or a number.",
                "type": [
                  "string",
                  "number"
                ]
              }
            },
            "required": [
              "time",
              "title"
            ],
            "additionalProperties": false
          },
          "description": "The events, in time order."
        }
      },
      "required": [
        "items"
      ],
      "additionalProperties": false
    }
  },
  "Table": {
    "description": "Tabular data. Provide `columns` and `rows`; each row is an array of cells matching the columns.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "columns": {
          "description": "Column definitions.",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "type": "string",
                "description": "Column header label."
              },
              "align": {
                "description": "Cell alignment.",
                "type": "string",
                "enum": [
                  "start",
                  "end"
                ]
              },
              "format": {
                "description": "Cell value format.",
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "number",
                      "currency",
                      "percent",
                      "date"
                    ],
                    "description": "Format kind. `percent` takes a fraction, so 0.25 renders as 25%."
                  },
                  "currency": {
                    "description": "Currency code.",
                    "type": "string"
                  },
                  "decimals": {
                    "description": "Decimal places.",
                    "type": "number"
                  }
                },
                "required": [
                  "kind"
                ],
                "additionalProperties": false
              }
            },
            "required": [
              "label"
            ],
            "additionalProperties": false
          }
        },
        "rows": {
          "description": "Rows of cells.",
          "type": "array",
          "items": {
            "type": "array",
            "items": {
              "description": "A cell value.",
              "type": [
                "string",
                "number",
                "boolean"
              ]
            }
          }
        },
        "sortable": {
          "description": "Allow header sorting.",
          "type": "boolean"
        }
      },
      "additionalProperties": false
    }
  },
  "Markdown": {
    "description": "A markdown string. Rendered as-is by default; override this component for a full markdown renderer.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "value": {
          "type": "string",
          "description": "Markdown source."
        }
      },
      "required": [
        "value"
      ],
      "additionalProperties": false
    }
  },
  "Chart": {
    "description": "A chart. `variant` selects bar, line, sparkline, or area rendering. Provide `data` for a single series, or `series` for multiple named series (`series` takes precedence over `data` when both are present). Set `stacked` to accumulate series values instead of overlaying them, and `showAxis`/`showLegend` to add y-axis ticks, x-axis point labels, and a legend.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "variant": {
          "type": "string",
          "enum": [
            "bar",
            "line",
            "sparkline",
            "area"
          ],
          "description": "Chart variant."
        },
        "data": {
          "description": "Data points for a single series.",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "description": "Point label.",
                "type": "string"
              },
              "value": {
                "type": "number",
                "description": "Point value."
              }
            },
            "required": [
              "value"
            ],
            "additionalProperties": false
          }
        },
        "series": {
          "description": "Multiple named series; takes precedence over `data` when present.",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "label": {
                "description": "Series label, shown in the legend.",
                "type": "string"
              },
              "color": {
                "description": "Series color. One of `emphasis`, `secondary`, `alpha-70`, `white`, `white-70`, or `white-50`, matching Text's `color` tokens; other values have no visual effect.",
                "type": "string"
              },
              "data": {
                "type": "array",
                "items": {
                  "type": "object",
                  "properties": {
                    "label": {
                      "description": "Point label.",
                      "type": "string"
                    },
                    "value": {
                      "type": "number",
                      "description": "Point value."
                    }
                  },
                  "required": [
                    "value"
                  ],
                  "additionalProperties": false
                },
                "description": "Data points for this series."
              }
            },
            "required": [
              "data"
            ],
            "additionalProperties": false
          }
        },
        "stacked": {
          "description": "Accumulate series values instead of overlaying them (bar and area variants; ignored for line and sparkline).",
          "type": "boolean"
        },
        "showAxis": {
          "description": "Show y-axis ticks and x-axis point labels.",
          "type": "boolean"
        },
        "showLegend": {
          "description": "Show a legend mapping each series to its color.",
          "type": "boolean"
        },
        "color": {
          "description": "Series color (single-series mode only). One of `emphasis`, `secondary`, `alpha-70`, `white`, `white-70`, or `white-50`, matching Text's `color` tokens; other values have no visual effect.",
          "type": "string"
        }
      },
      "required": [
        "variant"
      ],
      "additionalProperties": false
    }
  },
  "Citation": {
    "description": "A source the answer draws on, shown as a card with its title and site that links to it. Use one per source.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "title": {
          "description": "The source's title as text or a number.",
          "type": [
            "string",
            "number"
          ]
        },
        "url": {
          "description": "Link to the source; only http and https links open.",
          "type": "string"
        },
        "source": {
          "description": "Where it comes from, such as a site or publication, as text or a number. Defaults to the link's domain.",
          "type": [
            "string",
            "number"
          ]
        },
        "snippet": {
          "description": "A short quote or summary of what the source says, as text or a number.",
          "type": [
            "string",
            "number"
          ]
        }
      },
      "required": [
        "title"
      ],
      "additionalProperties": false
    }
  },
  "Alert": {
    "description": "A highlighted message conveying urgency. `tone` drives the severity.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "title": {
          "description": "Alert title text or number.",
          "type": [
            "string",
            "number"
          ]
        },
        "description": {
          "description": "Supporting description text or number.",
          "type": [
            "string",
            "number"
          ]
        },
        "tone": {
          "description": "Severity tone; defaults to `info`.",
          "type": "string",
          "enum": [
            "info",
            "success",
            "warning",
            "danger"
          ]
        }
      },
      "additionalProperties": false
    }
  },
  "Carousel": {
    "description": "A horizontally scrollable group of `Card` children (max 10). Set `label` for an accessible name.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "label": {
          "description": "Accessible label for the carousel.",
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "Icon": {
    "description": "A small line icon from the built-in set. `size` controls the rendered pixel size.",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "enum": [
            "sun",
            "moon",
            "cloud",
            "rain",
            "snow",
            "wind",
            "play",
            "pause",
            "check",
            "x",
            "star",
            "heart",
            "arrow-right",
            "arrow-up-right",
            "chevron-right",
            "calendar",
            "clock",
            "map-pin",
            "plane",
            "truck",
            "credit-card",
            "user",
            "search",
            "bell"
          ],
          "description": "Which built-in icon to render."
        },
        "size": {
          "description": "Icon size; defaults to `md` (16px).",
          "type": "string",
          "enum": [
            "sm",
            "md",
            "lg"
          ]
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  }
} as const;
