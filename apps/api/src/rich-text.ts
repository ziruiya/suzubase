import sanitizeHtml from 'sanitize-html';
import { decode } from 'he';

export function richTextPlain(html: string) {
  const withBreaks = html.replace(/<\/(?:p|div|li)>|<br\s*\/?\s*>/gi, '\n');
  return decode(sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })).trim();
}

export function sanitizeRichText(input: string) {
  const html = sanitizeHtml(input, {
    allowedTags: ['p', 'br', 'strong', 'b', 'a', 'ul', 'ol', 'li', 'div'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['https', 'http'],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'svg', 'math'],
  });
  return richTextPlain(html) ? html : '';
}
