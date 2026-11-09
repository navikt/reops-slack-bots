/** Minimal Slack block shape; preserve fields we don't need to interpret. */
export interface MessageBlock {
  type?: string;
  block_id?: string;
  [key: string]: unknown;
}

/** Legacy action blocks lack a source channel; their generated permalink has it. */
export function sourceFromLegacyReminder(blocks: MessageBlock[], threadTs: string): string | null {
  const index = blocks.findIndex((block) => block.type === "actions" && block.block_id === `digest_item_${threadTs}`);
  const section = blocks[index - 2];
  if (section?.type !== "section") return null;
  const text = (section.text as { text?: string } | undefined)?.text;
  if (typeof text !== "string") return null;
  return text.match(/<https:\/\/[^/<>]+\.slack\.com\/archives\/([CG][A-Z0-9]+)\/p\d+(?:\?[^|>]*)?\|/)?.[1] ?? null;
}

/**
 * Remove one of our section/context/actions groups from the actual message.
 * Missing DB rows must never be interpreted as an empty Slack message.
 * Unknown layouts fail closed: leave the message unchanged.
 */
export function removeDigestItem(
  blocks: MessageBlock[],
  threadTs: string,
): { blocks: MessageBlock[]; remainingItems: number } | null {
  const itemActions = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.type === "actions" && block.block_id?.startsWith("digest_item_"));
  const matches = itemActions.filter(({ block }) => block.block_id === `digest_item_${threadTs}`);
  if (matches.length !== 1) return null;

  // Layout emitted by buildDigestBlocks: header, divider, then each item's
  // section + context + actions, with dividers between items.
  if (blocks[0]?.type !== "section" || blocks[1]?.type !== "divider") return null;
  if (blocks.length !== itemActions.length * 4 + 1) return null;
  for (const [itemIndex, { index }] of itemActions.entries()) {
    if (index !== 4 + itemIndex * 4) return null;
    if (blocks[index - 2]?.type !== "section" || blocks[index - 1]?.type !== "context") return null;
    if (blocks[index - 3]?.type !== "divider") return null;
    if (index + 1 < blocks.length && blocks[index + 1]?.type !== "divider") return null;
  }

  const actionIndex = matches[0].index;
  let start = actionIndex - 2;
  let end = actionIndex + 1;
  // Prefer removing the following divider; for the last item remove the
  // preceding one, except the header divider for a single-item message.
  if (blocks[end]?.type === "divider") end += 1;
  else if (itemActions.length > 1) start -= 1;

  return {
    blocks: [...blocks.slice(0, start), ...blocks.slice(end)],
    remainingItems: itemActions.length - 1,
  };
}
