/**
 * ApexCharts writes labels into tooltips and legends with innerHTML, and a user agent or protocol
 * is whatever the client sent, so only characters with no HTML meaning reach a chart.
 */
const UNSAFE_LABEL_CHARS = /[^\p{L}\p{N} ._\-/()+:;,@[\]=]/gu;

export function toSafeChartLabel(value: string): string {
  return value.replace(UNSAFE_LABEL_CHARS, "?");
}
