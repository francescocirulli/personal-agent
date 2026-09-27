import type { Element, Root, RootContent } from 'hast';

export const markdownPreviewLimit = 200_000;
export type MarkdownDocument = {
  key: string;
  name: string;
  url?: string;
  content?: string;
  chatId?: string;
  attachmentId?: string;
};
export function isMarkdown(name: string, mime: string) {
  return /\.md$/i.test(name) || mime.split(';')[0] === 'text/markdown';
}
export function nodeText(node: RootContent | Root): string {
  return 'value' in node
    ? node.value
    : 'children' in node
      ? node.children.map(nodeText).join('')
      : '';
}
// Runs on the parsed tree: fenced code never becomes a heading and raw HTML is not executed.
export function readerMarkup(query: string) {
  return () => (tree: Root) => {
    const used = new Map<string, number>();
    let hits = 0;
    const walk = (parent: Root | Element) => {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type === 'element') {
          if (/^h[1-6]$/.test(node.tagName)) {
            const base =
              nodeText(node)
                .toLowerCase()
                .trim()
                .replace(/[^\p{L}\p{N}\s_-]/gu, '')
                .replace(/\s+/g, '-') || 'sezione';
            let slug = base,
              suffix = 0;
            while (used.has(slug)) slug = `${base}-${++suffix}`;
            used.set(slug, 1);
            node.properties.id = `md-${slug}`;
            node.properties.dataHeading = true;
          }
          walk(node);
        }
        if (node.type !== 'text' || !query || hits >= 500) return [node];
        const parts: RootContent[] = [];
        const lower = node.value.toLocaleLowerCase(),
          needle = query.toLocaleLowerCase();
        let start = 0,
          at = lower.indexOf(needle);
        while (at !== -1 && hits < 500) {
          parts.push({ type: 'text', value: node.value.slice(start, at) });
          parts.push({
            type: 'element',
            tagName: 'mark',
            properties: { dataHit: true },
            children: [{ type: 'text', value: node.value.slice(at, at + query.length) }],
          });
          hits++;
          start = at + query.length;
          at = lower.indexOf(needle, start);
        }
        parts.push({ type: 'text', value: node.value.slice(start) });
        return parts;
      });
    };
    walk(tree);
  };
}
export function splitFrontmatter(text: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  return match
    ? { metadata: match[1], body: text.slice(match[0].length) }
    : { metadata: '', body: text };
}
