import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isMarkdown, readerMarkup, splitFrontmatter } from '../src/markdown';

const render = (text: string, query = '') =>
  renderToStaticMarkup(
    createElement(Markdown, {
      children: text,
      remarkPlugins: [remarkGfm],
      rehypePlugins: [readerMarkup(query)],
      skipHtml: true,
    }),
  );
test('reader parses GFM and headings without treating fenced code or raw HTML as markup', () => {
  const html = render(
    '# Titolo\n\n## Titolo\n\n## Titolo-1\n\n```md\n# Falso titolo\n```\n\n<script>alert(1)</script>\n\n[Link](javascript:alert(1))\n\n| Nome | Stato |\n| --- | --- |\n| Test | Fatto |\n\n- [x] Fatto',
  );
  assert.match(html, /id="md-titolo"/);
  assert.match(html, /id="md-titolo-1"/);
  assert.match(html, /id="md-titolo-1-1"/);
  assert.doesNotMatch(html, /id="md-falso|<script|href="javascript:/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"[^>]*checked/);
});
test('search highlights literal text safely, including punctuation, and limits matches', () => {
  assert.match(render('Test a+b e A+B.', 'a+b'), /<mark data-hit="true">a\+b<\/mark>/);
  assert.equal((render('x '.repeat(2000), 'x').match(/<mark /g) || []).length, 500);
  assert.doesNotMatch(render('Testo innocuo', '<img onerror=alert(1)>'), /<img/);
});
test('Markdown recognition and frontmatter retain the original source and line endings', () => {
  assert.ok(isMarkdown('README.MD', 'application/octet-stream'));
  assert.ok(isMarkdown('documento', 'text/markdown;charset=utf-8'));
  assert.equal(isMarkdown('report.pdf', 'application/pdf'), false);
  const source = '\uFEFF---\r\nname: skill\r\n---\r\n# Istruzioni\r\n';
  assert.deepEqual(splitFrontmatter(source), { metadata: 'name: skill', body: '# Istruzioni\r\n' });
  assert.deepEqual(splitFrontmatter('# Documento\n---'), {
    metadata: '',
    body: '# Documento\n---',
  });
});
