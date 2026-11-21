import DOMPurify from 'dompurify';
import { useEffect, useRef, useState } from 'react';

function clean(html: string) {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'a', 'ul', 'ol', 'li', 'div'],
    ALLOWED_ATTR: ['href'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|\/(?!\/)|#)/i,
  });
}

export function richTextSummary(html: string) {
  const parsed = new DOMParser().parseFromString(clean(html.replace(/<\/(?:p|div|li)>|<br\s*\/?\s*>/gi, '\n')), 'text/html');
  return parsed.body.textContent?.trim() ?? '';
}

export function RichTextValue({ html }: { html: string }) {
  return <div className="rich-text-value" dangerouslySetInnerHTML={{ __html: clean(html) }} />;
}

export function RichTextEditor({ id, html, disabled, onChange }: {
  id: string; html: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const selection = useRef<Range | null>(null);
  const [link, setLink] = useState('');
  useEffect(() => {
    if (!editor.current || clean(editor.current.innerHTML) === html) return;
    editor.current.innerHTML = clean(html);
    selection.current = null;
  }, [html]);

  function saveSelection() {
    const current = document.getSelection();
    if (current?.rangeCount && editor.current?.contains(current.getRangeAt(0).commonAncestorContainer)) {
      selection.current = current.getRangeAt(0).cloneRange();
    }
  }

  function format(command: string, argument?: string) {
    editor.current?.focus();
    if (selection.current && editor.current?.contains(selection.current.commonAncestorContainer)) {
      const current = document.getSelection();
      current?.removeAllRanges();
      current?.addRange(selection.current);
    }
    document.execCommand(command, false, argument);
    onChange(clean(editor.current?.innerHTML ?? ''));
    saveSelection();
  }

  return <div className="stack">
    <div className="inline" role="group" aria-label="Rich text formatting">
      <button type="button" disabled={disabled} onClick={() => format('formatBlock', 'p')}>Paragraph</button>
      <button type="button" disabled={disabled} onClick={() => format('bold')}>Bold</button>
      <button type="button" disabled={disabled} onClick={() => format('insertUnorderedList')}>Bulleted list</button>
      <button type="button" disabled={disabled} onClick={() => format('insertOrderedList')}>Numbered list</button>
      <label>Link URL <input value={link} onChange={(event) => setLink(event.target.value)} disabled={disabled} /></label>
      <button type="button" disabled={disabled || !/^https?:\/\/\S+$/i.test(link.trim())}
        onClick={() => { format('createLink', link.trim()); setLink(''); }}>Add link</button>
    </div>
    <div id={id} ref={editor} role="textbox" aria-multiline="true" aria-labelledby={id + '-label'}
      className="rich-text-editor" contentEditable={!disabled}
      onInput={(event) => { onChange(clean(event.currentTarget.innerHTML)); saveSelection(); }}
      onBlur={saveSelection} onKeyUp={saveSelection} onMouseUp={saveSelection}
      onDragOver={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}
      onPaste={(event) => {
        event.preventDefault();
        saveSelection();
        format('insertText', event.clipboardData.getData('text/plain'));
      }} />
  </div>;
}
