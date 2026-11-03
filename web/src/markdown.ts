import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.validateLink = url => /^https?:\/\//i.test(url);

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const link = tokens[index];
  link.attrSet('target', '_blank');
  link.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const label = renderer.renderInlineAsText(tokens[index].children ?? [], options, env);
  return markdown.utils.escapeHtml(label || 'Изображение');
};

markdown.renderer.rules.table_open = () => '<div class="markdown-table" tabindex="0" role="region" aria-label="Таблица"><table>';
markdown.renderer.rules.table_close = () => '</table></div>';

export function renderMarkdown(text: string) {
  return markdown.render(text);
}
