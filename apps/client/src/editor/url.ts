// Link-URL allowlisting for everything that can produce an `<a href>`.
//
// Both Markdown parsers accept `[text](anything)` — the href capture group is
// `([^)]+)` — and Day One `.zip` exports are UNTRUSTED input that reaches the
// import parser directly. Without a check, `[click](javascript:steal())` lands
// in an entry as a real link mark, is stored, syncs to every device, and fires
// on click with the vault unlocked and every key in memory.
//
// StarterKit's Link extension does ship a default URL check, but relying on a
// third-party default for an XSS-critical control is exactly the kind of
// implicit safety this module removes: the allowlist lives here, in app code,
// and is applied on parse, on serialize, and in the extension config.
export const ALLOWED_LINK_PROTOCOLS = ['http', 'https', 'mailto', 'tel'] as const;

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

// Characters a browser ignores while resolving a scheme: C0/C1 controls,
// space, and the zero-width family. "java\tscript:" and " javascript:" are
// live bypasses unless we drop these before looking for the colon. Expressed
// by code point rather than a literal character class, so no control byte ever
// has to live in this source file.
function isIgnorable(code: number): boolean {
  return (
    code <= 0x20 || // C0 controls and space
    (code >= 0x7f && code <= 0xa0) || // DEL, C1 controls, NBSP
    (code >= 0x200b && code <= 0x200d) || // zero-width space / non-joiner / joiner
    code === 0xfeff // zero-width no-break space (BOM)
  );
}

function stripIgnorable(s: string): string {
  let out = '';
  for (const ch of s) {
    if (!isIgnorable(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/**
 * True when `href` is safe to put in an `<a href>`.
 *
 * Relative and fragment URLs are allowed: they carry no scheme, so they cannot
 * express `javascript:` / `data:` / `vbscript:`. Anything with a scheme must
 * name one of ALLOWED_LINK_PROTOCOLS.
 */
export function isSafeHref(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  const cleaned = stripIgnorable(href);
  if (cleaned === '') return false;
  const scheme = SCHEME_RE.exec(cleaned);
  if (!scheme) return true; // relative, absolute-path, or fragment
  return (ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(scheme[1].toLowerCase());
}

/** The href to store, or null when the URL must not become a link at all. */
export function safeHref(href: unknown): string | null {
  return isSafeHref(href) ? href : null;
}
