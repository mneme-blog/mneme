// Read-only renderer for a stored ProseMirror document. Renders the same DOM
// shapes TipTap produces and reuses the `.mneme-prose` stylesheet, so a preview
// is typographically identical to the editor — without the cost (and focus/
// keyboard side effects) of mounting a real editor instance per template.
import type { ComponentChildren, VNode } from 'preact';
import type { JSONContent } from '@tiptap/core';
import { t, tp } from '../i18n';
import { parseBody } from './doc';
import { renderLatex } from './math';
import './editor.css';

interface Mark {
  type: string;
}

function withMarks(text: string, marks?: Mark[]): ComponentChildren {
  let node: ComponentChildren = text;
  for (const m of marks ?? []) {
    if (m.type === 'bold') node = <strong>{node}</strong>;
    else if (m.type === 'italic') node = <em>{node}</em>;
    else if (m.type === 'code') node = <code>{node}</code>;
    else if (m.type === 'strike') node = <s>{node}</s>;
  }
  return node;
}

function renderNode(n: JSONContent, i: number): ComponentChildren {
  const kids = (n.content ?? []).map(renderNode);
  switch (n.type) {
    case 'text':
      return withMarks(n.text ?? '', n.marks as Mark[] | undefined);
    case 'paragraph':
      // Empty paragraphs are deliberate writing room in a template — keep the line.
      return <p key={i}>{kids.length ? kids : ' '}</p>;
    case 'heading': {
      const level = (n.attrs?.level as number) ?? 2;
      if (level === 1) return <h1 key={i}>{kids}</h1>;
      if (level === 3) return <h3 key={i}>{kids}</h3>;
      return <h2 key={i}>{kids}</h2>;
    }
    case 'bulletList':
      return <ul key={i}>{kids}</ul>;
    case 'orderedList':
      return <ol key={i} start={(n.attrs?.start as number) ?? 1}>{kids}</ol>;
    case 'listItem':
      return <li key={i}>{kids}</li>;
    case 'taskList':
      return <ul key={i} data-type="taskList">{kids}</ul>;
    case 'taskItem':
      // Mirrors the TipTap task-item DOM (label > input, then div) so the
      // checklist styling in editor.css applies as-is.
      return (
        <li key={i} data-checked={n.attrs?.checked ? 'true' : 'false'}>
          <label>
            <input type="checkbox" checked={!!n.attrs?.checked} disabled />
          </label>
          <div>{kids.length ? kids : <p>{' '}</p>}</div>
        </li>
      );
    case 'blockquote':
      return <blockquote key={i}>{kids}</blockquote>;
    case 'codeBlock':
      return (
        <pre key={i}>
          <code>{kids}</code>
        </pre>
      );
    case 'horizontalRule':
      return <hr key={i} />;
    case 'table':
      return (
        <div key={i} class="tableWrapper">
          <table>
            <tbody>{kids}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr key={i}>{kids}</tr>;
    case 'tableHeader':
      return <th key={i} colSpan={(n.attrs?.colspan as number) ?? 1} rowSpan={(n.attrs?.rowspan as number) ?? 1}>{kids}</th>;
    case 'tableCell':
      return <td key={i} colSpan={(n.attrs?.colspan as number) ?? 1} rowSpan={(n.attrs?.rowspan as number) ?? 1}>{kids}</td>;
    case 'entryLink':
      // Display-only chip; previews don't navigate.
      return <span key={i} class="mneme-wikilink">{String(n.attrs?.label ?? '')}</span>;
    case 'inlineMath':
      return <span key={i} data-type="inline-math" dangerouslySetInnerHTML={{ __html: renderLatex(String(n.attrs?.latex ?? ''), 'inline') }} />;
    case 'blockMath':
      return <div key={i} data-type="block-math" dangerouslySetInnerHTML={{ __html: renderLatex(String(n.attrs?.latex ?? ''), 'block') }} />;
    case 'hardBreak':
      return <br key={i} />;
    case 'mediaAttachment': {
      // Display-only marker; previews never resolve media bytes.
      const kind = n.attrs?.kind === 'audio' ? t('editorx.preview.audio') : t('editorx.preview.video');
      return (
        <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--ui)', fontSize: '0.82em', color: 'var(--ink-3)', border: '1px dashed var(--line)', borderRadius: 9, padding: '4px 10px' }}>
          {kind}
        </div>
      );
    }
    case 'locationMap': {
      // Display-only marker; previews never resolve the snapshot bytes.
      const from = (n.attrs?.from as { label?: unknown } | undefined)?.label;
      const to = (n.attrs?.to as { label?: unknown } | undefined)?.label;
      const label = `📍 ${typeof from === 'string' && from ? from : t('editorx.preview.location')}${typeof to === 'string' && to ? ` → ${to}` : ''}`;
      return (
        <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--ui)', fontSize: '0.82em', color: 'var(--ink-3)', border: '1px dashed var(--line)', borderRadius: 9, padding: '4px 10px' }}>
          {label}
        </div>
      );
    }
    case 'videoInterview': {
      // Display-only marker; previews never resolve the clip or film bytes.
      const name = typeof n.attrs?.typeName === 'string' && n.attrs.typeName ? n.attrs.typeName : t('editorx.preview.videoInterview');
      const count = Array.isArray(n.attrs?.cards) ? n.attrs.cards.length : 0;
      return (
        <div key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--ui)', fontSize: '0.82em', color: 'var(--ink-3)', border: '1px dashed var(--line)', borderRadius: 9, padding: '4px 10px' }}>
          {`🎬 ${name}`}
          {count > 0 && ` · ${tp('editorx.videoInterview.questions', count)}`}
        </div>
      );
    }
    default:
      return <span key={i}>{kids}</span>;
  }
}

export function DocPreview({
  json,
  text,
  size = 14.5,
}: {
  json: string | undefined;
  text: string;
  /** Base font size in px; headings/gaps scale from it (editor default is 18). */
  size?: number;
}): VNode {
  const doc = parseBody(json, text);
  return (
    <div
      class="mneme-prose"
      // Custom properties: Preact routes dashed keys through style.setProperty.
      style={{ '--editor-size': `${size}px`, '--editor-gap': `${Math.round(size * 0.75)}px` } as never}
    >
      {(doc.content ?? []).map(renderNode)}
    </div>
  );
}
