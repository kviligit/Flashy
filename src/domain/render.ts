/**
 * Anki-style template rendering, and the rule that decides which cards a
 * note produces.
 *
 * Supported syntax:
 *   {{Field}}              the field's value, as HTML
 *   {{text:Field}}         the field's value with tags stripped
 *   {{hint:Field}}         a click-to-reveal hint
 *   {{cloze:Field}}        cloze deletions, resolved for this card's ordinal
 *   {{FrontSide}}          the rendered question (answer templates only)
 *   {{#Field}}...{{/Field}} shown only when the field is non-empty
 *   {{^Field}}...{{/Field}} shown only when the field is empty
 *
 * Pure and DOM-free, so it is testable in node and reusable for export.
 */

export type Side = 'question' | 'answer';

export interface RenderContext {
  fields: Record<string, string>;
  /** Template index for standard notes; cloze number for cloze notes. */
  ord: number;
  /** Rendered question, for `{{FrontSide}}`. */
  frontSide?: string;
  side: Side;
  /**
   * The field names the note type declares.
   *
   * When given, a reference to anything outside this set renders as empty:
   * the field cannot ever hold content, so a template mentioning it must
   * not be able to keep a card alive. When omitted, an unknown reference is
   * left visible as `{{Typo}}`, which is what makes a template mistake
   * obvious while editing.
   */
  knownFields?: ReadonlySet<string>;
}

const CLOZE_PATTERN = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

/** Every cloze number appearing in a piece of text, ascending and unique. */
export function clozeOrdinals(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(CLOZE_PATTERN)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > 0) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Resolve cloze markers for one card.
 *
 * The card's own deletion is blanked on the question and highlighted on the
 * answer; every other deletion shows its text plainly, so the surrounding
 * sentence still reads.
 */
export function renderCloze(text: string, ord: number, side: Side): string {
  return text.replace(CLOZE_PATTERN, (_match, digits: string, answer: string, hint?: string) => {
    const n = Number(digits);
    if (n !== ord) return answer;
    if (side === 'answer') return `<span class="cloze">${answer}</span>`;
    const placeholder = hint && hint.length > 0 ? escapeHtml(hint) : '...';
    return `<span class="cloze">[${placeholder}]</span>`;
  });
}

/** Strip tags and collapse whitespace — for previews and sort fields. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rendering produces UNTRUSTED HTML.
 *
 * There is deliberately no sanitiser here. This module is pure and
 * DOM-free, and sanitising HTML without a parser cannot be done safely — an
 * earlier attempt used regexes and was bypassed by `<img src="x"/onerror=…>`,
 * because browsers accept `/` as an attribute separator and a regex
 * requiring whitespace does not.
 *
 * The security boundary is `setSafeHtml` in `src/ui/safe-html.ts`, which
 * parses into an inert DOM and applies an allow-list. Everything that puts
 * rendered card content on the page must go through it. Anything else —
 * export, plain-text previews, blankness checks — is not an injection sink
 * and does not need one.
 */

/** Field names a template refers to, in any form. */
export function fieldsReferenced(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/\{\{([#^/]?)(?:([a-z]+):)?([^}]+)\}\}/g)) {
    const name = (match[3] ?? '').trim();
    if (!name || name === 'FrontSide') continue;
    names.add(name);
  }
  return [...names];
}

/** Render one side of one card. */
export function renderTemplate(template: string, ctx: RenderContext): string {
  const withSections = resolveSections(template, ctx);
  return resolveFields(withSections, ctx);
}

/** `{{#Field}}` / `{{^Field}}` blocks, innermost first. */
function resolveSections(template: string, ctx: RenderContext): string {
  const section = /\{\{([#^])([^}/]+)\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/;
  let out = template;
  // Repeated passes let nested sections resolve from the inside out.
  for (let guard = 0; guard < 20; guard++) {
    const next = out.replace(section, (_m, kind: string, rawName: string, body: string) => {
      const name = rawName.trim();
      const filled = hasContent(ctx.fields[name] ?? '');
      const keep = kind === '#' ? filled : !filled;
      return keep ? body : '';
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function resolveFields(template: string, ctx: RenderContext): string {
  return template.replace(/\{\{(?:([a-z]+):)?([^}]+)\}\}/g, (match, filter: string | undefined, rawName: string) => {
    const name = rawName.trim();

    if (name === 'FrontSide') return ctx.frontSide ?? '';

    const value = ctx.fields[name];
    if (value === undefined) {
      return ctx.knownFields ? '' : match; // see RenderContext.knownFields
    }

    switch (filter) {
      case 'text':
        return escapeHtml(stripHtml(value));
      case 'cloze':
        return renderCloze(value, ctx.ord, ctx.side);
      case 'hint':
        return hasContent(value)
          ? `<details class="hint"><summary>${escapeHtml(name)}</summary>${value}</details>`
          : '';
      default:
        return value;
    }
  });
}

function hasContent(value: string): boolean {
  return stripHtml(value).length > 0;
}

/**
 * Elements that are content in their own right, even with no text around
 * them. A card whose front is a single picture is a perfectly good card.
 */
const EMBEDDED_CONTENT = /<\s*(img|audio|video|svg|object|embed|iframe)\b/i;

/**
 * True when a rendered question is blank, meaning no card should exist.
 *
 * Text is not the only kind of content: stripping the tags from an
 * image-only card leaves an empty string, and treating that as blank would
 * refuse to create the card at all.
 */
export function isBlankQuestion(rendered: string): boolean {
  if (EMBEDDED_CONTENT.test(rendered)) return false;
  return stripHtml(rendered).length === 0;
}
