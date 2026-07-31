// Math typesetting: TipTap's Mathematics nodes (KaTeX-rendered LaTeX) plus the
// edit dialog. A formula is just a `latex` string in the node attrs inside
// bodyJson, so it rides the encrypted entry body like every other block — the
// relay never sees it. Typing $$x$$ makes inline math, $$$x$$$ a display block;
// clicking a rendered formula (or the "/" Math commands) opens the dialog.
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Editor } from '@tiptap/core';
import type { AnyExtension } from '@tiptap/core';
import { Mathematics } from '@tiptap/extension-mathematics';
import katex from 'katex';
import { t, type MessageKey } from '../i18n';
import { Btn } from '../ui/primitives';
import { Icon } from '../ui/Icon';
// KaTeX's stylesheet rides in editor.css (a CSS import here would break
// node-side tsx scripts that import editor modules).

export type MathKind = 'inline' | 'block';

/** One open edit: an existing node at `pos`, or a new one at the cursor (`pos` null). */
export interface MathEditRequest {
  kind: MathKind;
  latex: string;
  pos: number | null;
}

/** Mutable bridge between the extension's click handler and the Preact dialog —
 * same pattern as the slash menu's handle (the editor mounts outside Preact). */
export interface MathHandle {
  listener: ((req: MathEditRequest) => void) | null;
}

export function createMathHandle(): MathHandle {
  return { listener: null };
}

/** The configured Mathematics extension; clicking a node opens the dialog. */
export function mathExtension(handle?: MathHandle): AnyExtension {
  return Mathematics.configure({
    // Same hardening for the extension's own in-editor rendering path.
    katexOptions: KATEX_OPTIONS,
    inlineOptions: {
      onClick: (node, pos) =>
        handle?.listener?.({ kind: 'inline', latex: String(node.attrs.latex ?? ''), pos }),
    },
    blockOptions: {
      onClick: (node, pos) =>
        handle?.listener?.({ kind: 'block', latex: String(node.attrs.latex ?? ''), pos }),
    },
  });
}

/**
 * KaTeX options, spelled out rather than inherited.
 *
 * Rendered output goes through `dangerouslySetInnerHTML`, so the only thing
 * standing between stored LaTeX and stored XSS is `trust`. KaTeX defaults it
 * to false, which disables `\href`, `\url`, `\includegraphics` and the `\html*`
 * family — but leaning on an upstream default for an XSS-critical control is
 * precisely the fragility this pins down. Set it here, where a reviewer reading
 * the render path can see it.
 *
 * The rest bound the work a single formula can cost: `maxExpand` caps macro
 * expansion (the classic billion-laughs shape), `maxSize` caps user-specified
 * dimensions, and `strict: 'ignore'` keeps unusual-but-harmless input rendering
 * instead of erroring — content already in someone's journal must keep opening.
 */
const KATEX_OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: 'ignore',
  maxExpand: 1000,
  maxSize: 500,
} as const;

/** LaTeX → HTML. Never throws; KaTeX renders bad input in its error color. */
export function renderLatex(latex: string, kind: MathKind): string {
  return katex.renderToString(latex, { ...KATEX_OPTIONS, displayMode: kind === 'block' });
}

/** The in-dialog LaTeX cheatsheet: each snippet is KaTeX-rendered as its own
 * preview and clicking it inserts the source at the textarea cursor.
 * Section titles are message keys, resolved via t() at render time; the
 * snippets themselves are LaTeX source and deliberately not translated. */
const CHEATSHEET: ReadonlyArray<{ title: MessageKey; items: readonly string[] }> = [
  {
    title: 'editorx.math.sheet.basics',
    items: ['x^{2}', 'x_{i}', '\\frac{a}{b}', '\\sqrt{x}', '\\sqrt[n]{x}', '\\binom{n}{k}', '\\vec{v}', '\\hat{x}', '\\overline{x}'],
  },
  {
    title: 'editorx.math.sheet.calculus',
    items: ['\\sum_{i=1}^{n}', '\\prod_{i=1}^{n}', '\\int_{a}^{b}', '\\oint', '\\lim_{x \\to \\infty}', '\\frac{dy}{dx}', '\\frac{\\partial f}{\\partial x}', '\\nabla'],
  },
  {
    title: 'editorx.math.sheet.symbols',
    items: ['\\times', '\\cdot', '\\pm', '\\leq', '\\geq', '\\neq', '\\approx', '\\equiv', '\\in', '\\notin', '\\subset', '\\cup', '\\cap', '\\infty', '\\to', '\\Rightarrow', '\\Leftrightarrow', '\\forall', '\\exists', '\\emptyset'],
  },
  {
    title: 'editorx.math.sheet.greek',
    items: ['\\alpha', '\\beta', '\\gamma', '\\delta', '\\epsilon', '\\theta', '\\lambda', '\\mu', '\\pi', '\\sigma', '\\tau', '\\phi', '\\omega', '\\Gamma', '\\Delta', '\\Sigma', '\\Omega'],
  },
  {
    title: 'editorx.math.sheet.layout',
    items: [
      '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
      '\\begin{cases} a & x > 0 \\\\ b & x \\leq 0 \\end{cases}',
      '\\text{text}',
      'a_1, a_2, \\dots',
      '\\underbrace{a+b}_{n}',
    ],
  },
];

/** Modal LaTeX editor with a live preview. Renders nothing until the handle's
 * listener fires (a click on a math node, or a "/" Math command). */
export function MathDialog({ handle, editor }: { handle: MathHandle; editor: Editor | null }): VNode | null {
  const [req, setReq] = useState<MathEditRequest | null>(null);
  const [latex, setLatex] = useState('');
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    handle.listener = (r) => {
      setReq(r);
      setLatex(r.latex);
    };
    return () => {
      handle.listener = null;
    };
  }, [handle]);

  useEffect(() => {
    if (req) inputRef.current?.focus();
  }, [req]);

  if (!req) return null;
  const editing = req.pos !== null;
  const close = (): void => setReq(null);

  const apply = (): void => {
    const src = latex.trim();
    if (editor) {
      const chain = editor.chain().focus();
      if (req.pos === null) {
        if (src) (req.kind === 'inline' ? chain.insertInlineMath({ latex: src }) : chain.insertBlockMath({ latex: src })).run();
      } else if (!src) {
        // Saving an emptied formula removes the node rather than leaving a blank atom.
        (req.kind === 'inline' ? chain.deleteInlineMath({ pos: req.pos }) : chain.deleteBlockMath({ pos: req.pos })).run();
      } else {
        (req.kind === 'inline' ? chain.updateInlineMath({ latex: src, pos: req.pos }) : chain.updateBlockMath({ latex: src, pos: req.pos })).run();
      }
    }
    close();
  };

  const insertSnippet = (snippet: string): void => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? latex.length;
    const end = el?.selectionEnd ?? latex.length;
    setLatex(latex.slice(0, start) + snippet + latex.slice(end));
    // Refocus after the re-render and park the caret behind the snippet, so
    // chips can be chained without re-clicking into the textarea.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const remove = (): void => {
    if (editor && req.pos !== null) {
      const chain = editor.chain().focus();
      (req.kind === 'inline' ? chain.deleteInlineMath({ pos: req.pos }) : chain.deleteBlockMath({ pos: req.pos })).run();
    }
    close();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      apply();
    }
  };

  return (
    <div
      role="dialog"
      onClick={close}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(30,22,16,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: 20, border: '1px solid var(--line)', padding: 22, boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ width: 36, height: 36, borderRadius: 999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)' }}>
            <Icon name="math" size={17} color="var(--accent-ink)" />
          </span>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>
            {editing ? t('editorx.math.edit') : req.kind === 'block' ? t('editorx.math.insertBlock') : t('editorx.math.insertInline')}
          </h3>
        </div>

        <textarea
          ref={inputRef}
          value={latex}
          onInput={(e) => setLatex((e.target as HTMLTextAreaElement).value)}
          onKeyDown={onKeyDown}
          placeholder={req.kind === 'block' ? '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' : 'e^{i\\pi} + 1 = 0'}
          rows={req.kind === 'block' ? 3 : 2}
          spellcheck={false}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'var(--mono)', fontSize: 13.5, lineHeight: 1.6, color: 'var(--ink)', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 12px', outline: 'none' }}
        />

        <div style={{ minHeight: 54, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '12px 0', padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', border: '1px dashed var(--line)', overflowX: 'auto' }}>
          {latex.trim() ? (
            <div style={{ color: 'var(--ink)' }} dangerouslySetInnerHTML={{ __html: renderLatex(latex, req.kind) }} />
          ) : (
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)' }}>{t('editorx.math.preview')}</span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowCheatsheet((v) => !v)}
          aria-expanded={showCheatsheet}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: showCheatsheet ? 10 : 16, padding: 0, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)' }}
        >
          <Icon name={showCheatsheet ? 'down' : 'right'} size={12} color="var(--ink-3)" dirFlip />
          {t('editorx.math.cheatsheet')}
        </button>

        {showCheatsheet && (
          <div style={{ maxHeight: 230, overflowY: 'auto', marginBottom: 16, padding: '10px 12px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)' }}>
            {CHEATSHEET.map((section) => (
              <div key={section.title} style={{ marginBottom: 10 }}>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
                  {t(section.title)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {section.items.map((snippet) => (
                    <button
                      key={snippet}
                      type="button"
                      title={snippet}
                      onClick={() => insertSnippet(snippet)}
                      style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 9px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, cursor: 'pointer', color: 'var(--ink)', fontSize: 13 }}
                      dangerouslySetInnerHTML={{ __html: renderLatex(snippet, 'inline') }}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)' }}>
              {t('editorx.math.sheet.hint')}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {editing && (
            <Btn kind="danger" size="sm" onClick={remove}>{t('common.remove')}</Btn>
          )}
          <span style={{ flex: 1 }} />
          <Btn kind="ghost" size="sm" onClick={close}>{t('common.cancel')}</Btn>
          <Btn kind="primary" size="sm" onClick={apply}>{editing ? t('common.save') : t('common.insert')}</Btn>
        </div>
      </div>
    </div>
  );
}
