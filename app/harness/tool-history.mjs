// D-1012g: how an old tool call reads under the three tool names (used by the transcript's write reminder).
// The session itself is never rewritten: dsh refuses replacing an assistant/message.
const RENAMES = Object.freeze({ QueryBoard: 'Get', ApplyBatch: 'Set', ApplyAction: 'Execute', ReadArtifact: 'Get' });

export function projectToolCall(block) {
  if (block?.type !== 'tool-call' || !Object.hasOwn(RENAMES, block.name)) return block;
  if (block.name !== 'ReadArtifact') return { ...block, name: RENAMES[block.name] };
  const { ref, offset } = block.input ?? {};
  return { ...block, name: 'Get', input: { artifact: { ref, ...(offset === undefined ? {} : { offset }) } } };
}
