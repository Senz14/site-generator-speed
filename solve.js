// sitegen — a fast drop-in for makefun-site 1.0.0 (make.fun's own static site
// generator). run(input) returns exactly the output tree makefun-site's build
// returns for the same input: every page's index.html, the index and tag pages,
// build-report.txt and each static file, byte for byte.
//
// How it is faster: templates are compiled once per case into plain JS
// functions (includes inlined at compile time, scope lookups resolved
// statically), Markdown is rendered in a single pass without token objects,
// front matter is parsed by scanning indexes instead of splitting and
// re-joining the whole body, and slugify results are memoized.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESC_MAP[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left. Pure-ASCII text skips the normalisation: NFKD is the identity on it
 * and it holds no combining marks.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  while (out.endsWith('-')) out = out.slice(0, -1);
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a code unit is JavaScript whitespace (the \s set). */
function isWS(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    let c = text.charCodeAt(i);
    while (i < len && (c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
      || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff)) { i++; if (i < len) c = text.charCodeAt(i); }
    if (i >= len) break;
    n++;
    while (i < len && !((c = text.charCodeAt(i)) === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
      || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff)) i++;
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The front matter is
 * found by scanning for the closing line; only that short region is split,
 * the body is a slice, never split and re-joined.
 */
function parseFrontMatter(text) {
  const nl1 = text.indexOf('\n');
  const first = nl1 === -1 ? text : text.slice(0, nl1);
  if (first !== '---') return { error: 'no front matter' };
  let closeStart = -1;
  let closeEnd = -1;
  let pos = nl1 === -1 ? text.length : nl1;
  while (true) {
    const idx = text.indexOf('\n---', pos);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) { closeStart = idx + 1; closeEnd = after; break; }
    pos = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const region = text.slice(nl1 + 1, closeStart);
  const lines = region === '' ? [] : region.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// --------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence's language, or null when `line` does not open one. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const end = j;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? line.slice(3, end) : null;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after them. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || (line.charCodeAt(n) !== 32 && line.charCodeAt(n) !== 9)) return null;
  let j = n;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  const text = trimLine(line.slice(j));
  return text === '' ? null : { depth: n, text };
}

/** Whether `line` is a thematic break: `---` or `***`, spaces or tabs after. */
function isHR(line) {
  if (line.length < 3) return false;
  const h = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const s = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!h && !s) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  if (isBlank(line)) return true;
  const c = line.charCodeAt(0);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  return false;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  return n >= 2 && n < line.length && !isWS(line.charCodeAt(n));
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. An escape pair consumes the backslash and the next character,
 * so a match is escaped exactly when an odd run of backslashes stands right
 * before it (the run cannot reach past `from`: the character before `from`
 * is never a backslash in either call).
 */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let b = 0;
    let k = j - 1;
    while (k >= 0 && s.charCodeAt(k) === 92) { b++; k--; }
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    let k = j - 1;
    while (k >= 0 && s.charCodeAt(k) === 92) { b++; k--; }
    if (b % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  let lit = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      out += esc(s.slice(lit, i)) + s[i + 1];
      i += 2;
      lit = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += esc(s.slice(lit, i)) + '<code>' + esc(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        lit = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += esc(s.slice(lit, i)) + '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          i = j + 2;
          lit = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += esc(s.slice(lit, i)) + '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        i = j + 1;
        lit = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        out += esc(s.slice(lit, i)) + '<a href="' + esc(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        i = m + 1;
        lit = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out + esc(s.slice(lit));
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading) and
 * its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let ls = 0;
  while (ls < n) {
    let le = src.indexOf('\n', ls);
    if (le === -1) le = n;
    const line = src.slice(ls, le);
    const next = le + 1;
    if (isBlank(line)) { ls = next; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      ls = next;
      while (ls < n) {
        let e2 = src.indexOf('\n', ls);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(ls, e2);
        if (isFenceClose(l2)) { ls = e2 + 1; break; }
        body.push(l2);
        ls = e2 + 1;
      }
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      let code = '';
      for (const l of body) code += esc(l) + '\n';
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      ls = next;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>');
      ls = next;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      ls = next;
      let first = line;
      while (true) {
        let q = first.slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        qlines.push(trimLine(q));
        if (ls >= n) break;
        let e2 = src.indexOf('\n', ls);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(ls, e2);
        if (l2.charCodeAt(0) !== 62) break;
        first = l2;
        ls = e2 + 1;
      }
      const kept = qlines.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32;
    let ordered = null;
    if (!bullet) {
      let d = 0;
      while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) ordered = { start: Number(line.slice(0, d)), rest: line.slice(d + 2) };
    }
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let cur = isOrdered ? trimLine(ordered.rest) : trimLine(line.slice(2));
      ls = next;
      while (ls < n) {
        let e2 = src.indexOf('\n', ls);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(ls, e2);
        const b2 = (l2.charCodeAt(0) === 45 || l2.charCodeAt(0) === 42) && l2.charCodeAt(1) === 32;
        let o2 = null;
        if (!b2 && isOrdered) {
          let d = 0;
          while (d < l2.length && l2.charCodeAt(d) >= 48 && l2.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d <= 9 && l2.charCodeAt(d) === 46 && l2.charCodeAt(d + 1) === 32) o2 = l2.slice(d + 2);
        }
        if (isOrdered ? o2 !== null : b2) {
          items.push(cur);
          cur = trimLine(isOrdered ? o2 : l2.slice(2));
          ls = e2 + 1;
        } else if (isContinued(l2)) {
          cur += '\n' + trimLine(l2);
          ls = e2 + 1;
        } else break;
      }
      items.push(cur);
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let lis = '';
      for (const item of items) lis += `<li>${inline(item, env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    let text = trimLine(line);
    ls = next;
    while (ls < n) {
      let e2 = src.indexOf('\n', ls);
      if (e2 === -1) e2 = n;
      const l2 = src.slice(ls, e2);
      if (endsParagraph(l2)) break;
      text += '\n' + trimLine(l2);
      ls = e2 + 1;
    }
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// -------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ------------------------------------------------------- template compiler

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The value at one more segment of `v`: an own property of an object, else
 * undefined (a string, number or boolean in the middle of a path, and null,
 * give undefined too).
 */
function seg(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/**
 * A path compiled to a JS expression. The first name is read from the
 * innermost enclosing loop that binds it (`loop` always means that loop's
 * loop object, even when a loop variable is itself named `loop`), else from
 * the root values R; each next name goes through seg().
 */
function pathExpr(path, cx) {
  let expr;
  const first = path[0];
  if (first === 'loop') {
    expr = 'R.loop';
    for (let i = cx.bindings.length - 1; i >= 0; i--) {
      if (cx.bindings[i].loopObj !== undefined) { expr = cx.bindings[i].loopObj; break; }
    }
  } else {
    expr = 'R.' + first;
    for (let i = cx.bindings.length - 1; i >= 0; i--) {
      if (cx.bindings[i].name === first) { expr = cx.bindings[i].v; break; }
    }
  }
  for (let k = 1; k < path.length; k++) expr = `seg(${expr},${JSON.stringify(path[k])})`;
  return expr;
}

/** `nodes` compiled into `parts` as JS statements appending to __o. */
function emitNodes(nodes, depth, cx, parts) {
  for (const n of nodes) {
    if (n.kind === 'text') parts.push('__o+=' + JSON.stringify(n.text) + ';\n');
    else if (n.kind === 'var') parts.push('__o+=esc(txt(' + pathExpr(n.path, cx) + '));\n');
    else if (n.kind === 'raw') parts.push('__o+=txt(' + pathExpr(n.path, cx) + ');\n');
    else if (n.kind === 'if') {
      parts.push('if(tru(' + pathExpr(n.path, cx) + ')!==' + (n.not ? 'true' : 'false') + '){\n');
      emitNodes(n.then, depth, cx, parts);
      if (n.else !== null) {
        parts.push('}else{\n');
        emitNodes(n.else, depth, cx, parts);
      }
      parts.push('}\n');
    } else if (n.kind === 'for') {
      const id = cx.uid++;
      const xs = '__x' + id;
      const k = '__k' + id;
      const v = '__v' + id;
      const L = '__L' + id;
      const path = pathExpr(n.path, cx);
      cx.bindings.push({ name: n.name, v, loopObj: L });
      parts.push('{const ' + xs + '=' + path + ';if(Array.isArray(' + xs + ')){for(let ' + k + '=0;' + k + '<' + xs + '.length;' + k + '++){const ' + v + '=' + xs + '[' + k + '];const ' + L + '={index:' + k + '+1,first:' + k + '===0,last:' + k + '===' + xs + '.length-1,length:' + xs + '.length};\n');
      emitNodes(n.body, depth, cx, parts);
      parts.push('}}}\n');
      cx.bindings.pop();
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const sub = cx.templates.get(n.name);
        if (sub !== undefined) emitNodes(sub, depth + 1, cx, parts);
      }
    }
  }
}

/** A template's nodes compiled to a render function (R, esc, txt, tru, seg) -> string. */
function compileTemplate(nodes, templates) {
  const cx = { uid: 0, bindings: [], templates };
  const parts = [];
  emitNodes(nodes, 0, cx, parts);
  return new Function('R', 'esc', 'txt', 'tru', 'seg', 'let __o="";\n' + parts.join('') + 'return __o;');
}

// ------------------------------------------------------------------ build

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');

  // 2. Templates, parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map();
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    let fn = compiled.get(name);
    if (fn === undefined) {
      fn = compileTemplate(nodes, templates);
      compiled.set(name, fn);
    }
    const R = Object.create(null);
    R.site = site;
    R.tags = allTags;
    R.recent = recent;
    Object.assign(R, vars);
    return fn(R, esc, textOf, truthy, seg);
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2b. Each source's front matter, in the checks' order.
  let kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const nNonPost = kept.filter((s) => !s.post).length;

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // 5. The posts, newest first and then by slug; each post's newer and
  // older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const npages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= npages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: npages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === npages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${nNonPost} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
