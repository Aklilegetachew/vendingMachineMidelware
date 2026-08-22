/**
 * Formats tag, length, and value into an EMVCo TLV (Tag-Length-Value) string segment.
 * Tag is formatted to 2 digits.
 * Length is formatted to 2 digits matching value length.
 *
 * @param tag Tag identifier (e.g. '00', '01', 28, 54)
 * @param value String value of the tag payload
 */
export function formatTlv(tag: string | number, value: string): string {
  const formattedTag = String(tag).padStart(2, '0');
  const length = String(value.length).padStart(2, '0');
  return `${formattedTag}${length}${value}`;
}
