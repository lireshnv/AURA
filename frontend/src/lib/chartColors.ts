/**
 * Shared chart palette for the Well-being / Risk & Trend / History / Profile
 * dashboards - the real hex values behind AURA's purple/teal/blue accent
 * tokens (recharts needs literal colors, not Tailwind class names). Kept in
 * one place so new charts don't each pick a slightly different purple.
 */
export const CHART = {
  purple: "#7c3aed", // primary-container - the accent used for the "headline" series
  purpleDeep: "#630ed4", // primary
  teal: "#006b5f", // secondary
  tealLight: "#6df5e1", // secondary-container
  blue: "#004ba4", // tertiary
  blueLight: "#0062d2", // tertiary-container
  grid: "#e2e8f0",
  axis: "#4a4455", // on-surface-variant
  tooltipBorder: "#ccc3d8", // outline-variant
  tooltipBg: "#ffffff",
} as const

/** Risk-band semantics - a separate, universally-understood convention from
 * the brand accent triad above, used only for LOW/MEDIUM/HIGH indicators. */
export const BAND_COLOR: Record<string, string> = {
  GREEN: "#059669",
  LOW: "#059669",
  AMBER: "#d97706",
  MEDIUM: "#d97706",
  RED: "#ba1a1a",
  HIGH: "#ba1a1a",
}

export const BAND_LABEL: Record<string, string> = {
  GREEN: "LOW",
  LOW: "LOW",
  AMBER: "MEDIUM",
  MEDIUM: "MEDIUM",
  RED: "HIGH",
  HIGH: "HIGH",
}

export const CHART_TOOLTIP_STYLE = {
  background: CHART.tooltipBg,
  border: `1px solid ${CHART.tooltipBorder}`,
  borderRadius: 8,
  fontSize: 12,
}

export const CHART_AXIS_TICK = { fill: CHART.axis, fontSize: 10 }
