// SPDX-License-Identifier: Apache-2.0
/** A bounded local display copy; never changes the arguments or answer sent to the model. */
export function localToolSnapshot(value, maximumBytes = 32768) {
  const text = JSON.stringify(value, null, 2) ?? 'null'
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maximumBytes) return { text, truncated: false, totalBytes: bytes.length }
  // Remove an incomplete UTF-8 tail; the preview is explicitly text, not truncated JSON to parse.
  let end = maximumBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true, totalBytes: bytes.length }
}
