// solve.js — a fast drop-in for makefun-site 1.0.0.
// Pure JavaScript, no dependencies, no WASM, no native addons.
// Written fresh in this session from the competition's README semantics:
// front matter, template dialect, Markdown subset, slug rule and report
// behave exactly like the reference; only the implementation is faster:
//  - single-pass index-based Markdown scanner with bulk-run escaping
//  - templates compiled to JS functions (new Function) with static scope
//    resolution and inlined includes (dynamic tree-walk fallback only for
//    cyclic / over-deep include chains, which the generator never emits)
//  - per-build memoised slugify (pure function of its input string)
//  - index-based front-matter parsing (body kept as a slice, never re-joined)
//  - allocation-free word counting

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text ----

const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

// Null-prototype object: direct property reads are then exactly the
// reference's own-property lookups (no inherited 'toString' etc. leaking in).
function np(obj) {
  return Object.assign(Object.create(null), obj);
}

const ASCII_RE = /^[\x00-\x7F]*$/;
const MARK_RE = /\p{M}/gu;
const SLUG_MAX = 64;
function slugifyRaw(text) {
  let plain = text;
  if (!ASCII_RE.test(text)) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = -1;
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCodePoint(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

// Count runs of non-whitespace exactly like /\S+/g would, without building
// a match array. Whitespace set is JS WhiteSpace + LineTerminator.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 32) {
      if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (c < 160) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (
      c === 160 || c === 1680 || (c >= 8192 && c <= 8202) || c === 8232 ||
      c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
    ) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------- front matter ----

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WS_TAIL_RE = /[ \t]+$/;

function daysIn(y, m) {
  return [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function stringOf(raw) {
  if (!raw.startsWith('"')) {
    if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
    return { value: raw };
  }
  if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
        return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      }
      out += n;
      i++;
      continue;
    }
    if (c === '"') return { error: 'a quoted string holds a stray quote' };
    out += c;
  }
  return { value: out };
}

const TAG_RE = /^[^"[\]]+$/;

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const v = stringOf(raw);
      if ('error' in v) return { error: `key "${key}": ${v.error}` };
      return { value: v.value };
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft': {
      if (raw !== 'true' && raw !== 'false') return { error: 'key "draft": true or false' };
      return { value: raw === 'true' };
    }
    case 'layout': {
      if (!NAME_RE.test(raw)) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (!SLUG_RE.test(raw) || raw.length > 64) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Index-based front-matter parse. The body is returned as a slice of the
// original text (never split + re-joined), and only the small front-matter
// section is ever split into lines.
function parseFrontMatter(text) {
  let e = text.indexOf('\n');
  const first = e === -1 ? text : text.slice(0, e);
  if (first !== '---') return { error: 'no front matter' };
  let pos = e === -1 ? text.length : e + 1;
  // find the closing '---' line (1-based line numbers)
  let closeLine = -1;
  let closeEnd = -1;
  let scan = pos;
  let lineNo = 2;
  while (scan <= text.length) {
    const le = text.indexOf('\n', scan);
    const line = le === -1 ? text.slice(scan) : text.slice(scan, le);
    if (line === '---') {
      closeLine = lineNo;
      closeEnd = le === -1 ? text.length : le + 1;
      break;
    }
    if (le === -1) break;
    scan = le + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = pos;
  let n = 2;
  while (n < closeLine) {
    const le = text.indexOf('\n', p);
    const line = text.slice(p, le);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE_RE.exec(line);
      if (m === null) return { error: `line ${n} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(WS_TAIL_RE, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return { error: v.error };
      data[key] = v.value;
    }
    p = le + 1;
    n++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// -------------------------------------------------------------- markdown ----

const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS_RE = /\s/;
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Single-pass inline renderer. Plain runs are sliced in bulk; only the
// markup characters are handled one by one. Unmatched openers stay in the
// plain run, exactly like the reference.
function inline(s, link) {
  const out = [];
  const len = s.length;
  let i = 0;
  let run = 0;
  while (i < len) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash
      const n = i + 1 < len ? s[i + 1] : '';
      if (i + 1 < len && ESCAPABLE.has(n)) {
        if (run < i) out.push(s.slice(run, i));
        out.push(n);
        i += 2;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      // backtick code span: closer is the next backtick, escapes not skipped
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      // star: strong (** ... **) or emphasis (* ... *)
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (run < i) out.push(s.slice(run, i));
          out.push('<strong>', inline(s.slice(i + 2, j), link), '</strong>');
          i = j + 2;
          run = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<em>', inline(s.slice(i + 1, j), link), '</em>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      // link [text](target)
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (run < i) out.push(s.slice(run, i));
        out.push('<a href="', escapeHtml(link(target)), '">', inline(s.slice(i + 1, k), link), '</a>');
        i = m + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 38) {
      if (run < i) out.push(s.slice(run, i));
      out.push('&amp;');
      i++;
      run = i;
      continue;
    }
    if (c === 60) {
      if (run < i) out.push(s.slice(run, i));
      out.push('&lt;');
      i++;
      run = i;
      continue;
    }
    if (c === 62) {
      if (run < i) out.push(s.slice(run, i));
      out.push('&gt;');
      i++;
      run = i;
      continue;
    }
    if (c === 34) {
      if (run < i) out.push(s.slice(run, i));
      out.push('&quot;');
      i++;
      run = i;
      continue;
    }
    if (c === 39) {
      if (run < i) out.push(s.slice(run, i));
      out.push('&#39;');
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (run < len) out.push(s.slice(run, len));
  return out.join('');
}

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  if (isBlank(line)) return true;
  if (line.charCodeAt(0) === 96 && FENCE_OPEN_RE.test(line)) return true;
  if (line.charCodeAt(0) === 35 && headingOf(line) !== null) return true;
  if ((line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && HR_RE.test(line)) return true;
  return false;
}

// Index-based block scanner: lines are located with indexOf, never split
// into an array up front. Returns { html, toc, excerpt }.
function renderMarkdown(src, link, slugify) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const len = src.length;
  let pos = 0;
  while (pos < len) {
    let e = src.indexOf('\n', pos);
    if (e === -1) e = len;
    const line = src.slice(pos, e);
    const next = e + 1;
    if (isBlank(line)) {
      pos = next;
      continue;
    }
    const first = line.charCodeAt(0);
    if (first === 96) {
      const fm = FENCE_OPEN_RE.exec(line);
      if (fm !== null) {
        const lang = fm[1];
        const body = [];
        pos = next;
        while (pos < len) {
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = len;
          const l2 = src.slice(pos, e2);
          if (FENCE_CLOSE_RE.test(l2)) {
            pos = e2 + 1;
            break;
          }
          body.push(l2);
          pos = e2 + 1;
        }
        if (pos > len) pos = len;
        let code = '';
        for (const l of body) code += escapeHtml(l) + '\n';
        blocks.push(
          `<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${code}</code></pre>`,
        );
        continue;
      }
    }
    if (first === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inline(h.text, link);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push(np({ level: h.depth, id, html }));
        pos = next;
        continue;
      }
    }
    if ((first === 45 || first === 42) && HR_RE.test(line)) {
      blocks.push('<hr>');
      pos = next;
      continue;
    }
    if (first === 62) {
      const qlines = [];
      let p2 = pos;
      while (p2 < len) {
        let e2 = src.indexOf('\n', p2);
        if (e2 === -1) e2 = len;
        const l2 = src.slice(p2, e2);
        if (l2.charCodeAt(0) !== 62) break;
        qlines.push(trimLine(l2.replace(/^> ?/, '')));
        p2 = e2 + 1;
      }
      pos = p2;
      const kept = qlines.filter((l) => l !== '');
      blocks.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`,
      );
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet === null ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      let p2 = pos;
      while (p2 < len) {
        let e2 = src.indexOf('\n', p2);
        if (e2 === -1) e2 = len;
        const l2 = src.slice(p2, e2);
        const mm = marker.exec(l2);
        if (mm !== null) {
          items.push([trimLine(isOrdered ? mm[2] : mm[1])]);
          p2 = e2 + 1;
        } else if (CONTINUED_RE.test(l2)) {
          items[items.length - 1].push(trimLine(l2));
          p2 = e2 + 1;
        } else break;
      }
      pos = p2;
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (const item of items) lis += `<li>${inline(item.join('\n'), link)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    // paragraph
    const parts = [trimLine(line)];
    pos = next;
    while (pos < len) {
      let e2 = src.indexOf('\n', pos);
      if (e2 === -1) e2 = len;
      const l2 = src.slice(pos, e2);
      if (endsParagraph(l2)) break;
      parts.push(trimLine(l2));
      pos = e2 + 1;
    }
    const html = inline(parts.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------- templates ----

class TemplateError extends Error {}
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let i = 0;
  let text = '';
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    const raw = src[open + 2] === '{';
    const close = raw
      ? src.indexOf('}}}', open + 3)
      : src.indexOf(next === '%' ? '%}' : '}}', open + 2);
    if (close === -1) {
      if (raw) throw new TemplateError(`template "${name}": a {{{ is not closed`);
      if (next === '%') throw new TemplateError(`template "${name}": a {% is not closed`);
      throw new TemplateError(`template "${name}": a {{ is not closed`);
    }
    text += src.slice(i, open);
    if (next === '%') {
      const lineStart = src.lastIndexOf('\n', open - 1) + 1;
      const nl = src.indexOf('\n', close + 2);
      const lineEnd = nl === -1 ? src.length : nl;
      if (
        /^[ \t]*$/.test(src.slice(lineStart, open)) &&
        /^[ \t]*$/.test(src.slice(close + 2, lineEnd))
      ) {
        text = text.slice(0, text.length - (open - lineStart));
        tokens.push({ kind: 'text', text });
        text = '';
        tokens.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
        i = nl === -1 ? src.length : nl + 1;
        continue;
      }
      tokens.push({ kind: 'text', text });
      text = '';
      tokens.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
      i = close + 2;
      continue;
    }
    tokens.push({ kind: 'text', text });
    text = '';
    tokens.push({
      kind: raw ? 'raw' : 'var',
      path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
    });
    i = close + (raw ? 3 : 2);
  }
  tokens.push({ kind: 'text', text });
  return tokens;
}

function bodyOf(node) {
  if (node.kind === 'root' || node.kind === 'for') return node.body;
  return node.else ?? node.then;
}

function parseTemplate(name, src) {
  const tokens = tokenize(name, src);
  const root = { kind: 'root', body: [] };
  const stack = [root];
  for (const t of tokens) {
    if (t.kind === 'text') {
      if (t.text !== '') bodyOf(stack[stack.length - 1]).push({ kind: 'text', text: t.text });
      continue;
    }
    if (t.kind === 'var' || t.kind === 'raw') {
      bodyOf(stack[stack.length - 1]).push({ kind: t.kind, path: t.path });
      continue;
    }
    const top = stack[stack.length - 1];
    const tag = t.tag;
    let m = FOR_RE.exec(tag);
    if (m !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      bodyOf(top).push(node);
      stack.push(node);
      continue;
    }
    m = IF_RE.exec(tag);
    if (m !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      bodyOf(top).push(node);
      stack.push(node);
      continue;
    }
    m = INCLUDE_RE.exec(tag);
    if (m !== null) {
      bodyOf(top).push({ kind: 'include', name: m[1] });
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) {
        throw new TemplateError(`template "${name}": an else outside an if`);
      }
      top.else = [];
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      continue;
    }
    throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length !== 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(`template "${name}": a ${top.kind} is not closed`);
  }
  return root.body;
}

// ---- runtime value helpers (shared by generated code and the fallback) ----

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map((x) => textOf(x)).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// escapeHtml(textOf(v)) as one call: numbers and booleans never hold an
// escapable character, so they skip the escape scan.
function escText(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(v.map(textOf).join(', '));
  return '';
}

// Guarded property read. All template-visible data objects are
// null-prototype, so a direct read is exactly the reference's own-property
// lookup; only null / non-object intermediates need the guard.
function g(v, k) {
  return v !== null && typeof v === 'object' ? v[k] : undefined;
}

function loopObj(k, len) {
  return np({ index: k + 1, first: k === 0, last: k === len - 1, length: len });
}

// One loop object per for-loop execution, mutated per item. Templates can
// only read it (never store it), so reusing it is indistinguishable from
// the reference's fresh object per item, and it removes one allocation
// per loop item.
function loopObj0(len) {
  return np({ index: 1, first: true, last: len === 1, length: len });
}

// Dynamic (tree-walk) renderer — used only for cyclic or over-deep include
// chains, which the generator never emits. Kept for exactness.
function lookupDyn(scope, path) {
  for (let s = scope; s !== null; s = s.parent) {
    if (Object.hasOwn(s.vars, path[0])) {
      let v = s.vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function renderNodesDyn(nodes, scope, H, depth) {
  let out = '';
  for (const n of nodes) {
    if (n.kind === 'text') out += n.text;
    else if (n.kind === 'var') out += escapeHtml(textOf(lookupDyn(scope, n.path)));
    else if (n.kind === 'raw') out += textOf(lookupDyn(scope, n.path));
    else if (n.kind === 'if') {
      const v = truthy(lookupDyn(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodesDyn(branch, scope, H, depth);
    } else if (n.kind === 'for') {
      const xs = lookupDyn(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          out += renderNodesDyn(
            n.body,
            { vars: { [n.name]: xs[k], loop: loopObj(k, xs.length) }, parent: scope },
            H,
            depth,
          );
        }
      }
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const target = H.nodes.get(n.name);
        if (target !== undefined) out += renderNodesDyn(target, scope, H, depth + 1);
      }
    }
  }
  return out;
}

// ---- static compilation ----

// Resolve a path to a JS expression. First segment: innermost loop binding
// (a JS local), 'loop' (innermost loop object), else a top-level var
// (direct read on the null-prototype vars object). Later segments go
// through the guarded read.
function expr(path, scope) {
  let base;
  const first = path[0];
  if (first === 'loop') {
    base = scope.length === 0 ? 'undefined' : scope[scope.length - 1].l;
  } else {
    let found = null;
    for (let i = scope.length - 1; i >= 0; i--) {
      if (scope[i].name === first) {
        found = scope[i];
        break;
      }
    }
    base = found !== null ? found.v : `V.${first}`;
  }
  let out = base;
  for (let k = 1; k < path.length; k++) out = `H.g(${out}, ${JSON.stringify(path[k])})`;
  return out;
}

// Frame object for a dynamic include call: exactly the loop bindings
// visible at this point, innermost last so it wins on duplicate keys.
function frameObj(scope) {
  if (scope.length === 0) return '{}';
  const parts = [];
  for (const f of scope) parts.push(`${JSON.stringify(f.name)}: ${f.v}`);
  parts.push(`loop: ${scope[scope.length - 1].l}`);
  return `{ ${parts.join(', ')} }`;
}

function genNodes(nodes, scope, off, stack, ctx, lines) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        lines.push(`o.push(${JSON.stringify(n.text)});`);
        break;
      case 'var':
        lines.push(`o.push(H.escText(${expr(n.path, scope)}));`);
        break;
      case 'raw':
        lines.push(`o.push(H.text(${expr(n.path, scope)}));`);
        break;
      case 'if':
        lines.push(`if (H.truthy(${expr(n.path, scope)}) !== ${n.not ? 'true' : 'false'}) {`);
        genNodes(n.then, scope, off, stack, ctx, lines);
        lines.push('}');
        if (n.else !== null) {
          lines.push('else {');
          genNodes(n.else, scope, off, stack, ctx, lines);
          lines.push('}');
        }
        break;
      case 'for': {
        const id = ctx.id++;
        lines.push(
          `{ const _x${id} = ${expr(n.path, scope)}; if (Array.isArray(_x${id})) { const _l${id} = H.loop0(_x${id}.length); for (let _k${id} = 0; _k${id} < _x${id}.length; _k${id}++) { const _v${id} = _x${id}[_k${id}]; _l${id}.index = _k${id} + 1; _l${id}.first = _k${id} === 0; _l${id}.last = _k${id} === _x${id}.length - 1;`,
        );
        genNodes(
          n.body,
          [...scope, { name: n.name, v: `_v${id}`, l: `_l${id}` }],
          off,
          stack,
          ctx,
          lines,
        );
        lines.push('} } }');
        break;
      }
      case 'include': {
        const target = ctx.templates.get(n.name);
        if (target === undefined) break; // missing template renders nothing
        if (stack.includes(n.name)) {
          // cyclic include: dynamic fallback
          lines.push(`o.push(H.inc(${JSON.stringify(n.name)}, V, ${frameObj(scope)}, D + ${off}));`);
          break;
        }
        if (off >= INCLUDE_DEPTH) break; // depth already >= 8: never renders
        lines.push(`if (D + ${off} < ${INCLUDE_DEPTH}) {`);
        genNodes(target, scope, off + 1, [...stack, n.name], ctx, lines);
        lines.push('}');
        break;
      }
    }
  }
}

function compileTemplate(name, nodes, templates) {
  const ctx = { templates, id: 0 };
  const lines = ['const o = [];'];
  genNodes(nodes, [], 0, [name], ctx, lines);
  lines.push('return o.join("");');
  return new Function('V', 'D', 'H', lines.join('\n'));
}

// -------------------------------------------------------------- pipeline ----

const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CR_RE = /\r\n?/g;

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function build(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

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

  const H = {
    esc: escapeHtml,
    text: textOf,
    escText,
    truthy,
    g,
    loop: loopObj,
    loop0: loopObj0,
    nodes: templates,
    fns: new Map(),
  };
  H.inc = (name, V, F, curDepth) => {
    if (curDepth >= INCLUDE_DEPTH) return '';
    const nodes = H.nodes.get(name);
    if (nodes === undefined) return '';
    return renderNodesDyn(nodes, { vars: F, parent: { vars: V, parent: null } }, H, curDepth + 1);
  };
  // fns fills lazily in render(); see layouts.

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    fns: H.fns,
    H,
    sources: [],
    statics: [],
    bySource: new Map(),
    posts: [],
    pages: [],
    tags: [],
    report,
    broken: new Set(),
    output: {},
  };

  // readSources
  {
    const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) {
        b.sources.push({
          path: f.path,
          text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CR_RE, '\n'),
        });
      } else {
        b.statics.push({ path: f.path, content: f.content });
      }
    }
  }

  // frontMatter
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      s.refused = true;
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      s.refused = true;
      continue;
    }
    if (s.post && s.data.date === undefined) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      s.refused = true;
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      s.refused = true;
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      s.refused = true;
      continue;
    }
  }
  b.sources = b.sources.filter((s) => !s.refused);

  // permalinks
  {
    const taken = new Map();
    const takenIn = (dir) => {
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      return set;
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.dir = dir;
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // markdown
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const link = (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      };
      const md = renderMarkdown(s.body, link, slugify);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
      s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    }
  }

  // collections
  b.posts = b.sources.filter((s) => s.post);
  b.posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.pages = b.sources.filter((s) => !s.post);
  for (let i = 0; i < b.posts.length; i++) {
    b.posts[i].newer = i > 0 ? b.posts[i - 1] : null;
    b.posts[i].older = i < b.posts.length - 1 ? b.posts[i + 1] : null;
  }

  // tags
  {
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const sl = slugify(name);
        if (seen.has(sl)) continue;
        seen.add(sl);
        out.push(name);
      }
      return out;
    };
    const bySlug = new Map();
    for (const p of b.posts) {
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        let t = bySlug.get(slug);
        if (t === undefined) {
          t = np({ name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
          bySlug.set(slug, t);
        }
        t.posts.push(p);
      }
    }
    b.tags = [...bySlug.values()].sort(
      (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
    );
    for (const s of b.sources) {
      s.tagRefs = ownTags(s).map(
        (name) => bySlug.get(slugify(name)) ?? np({ name, slug: slugify(name), url: '', posts: [] }),
      );
    }
  }

  // layouts
  {
    const cardOf = (s) => np({
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagRefs.map((t) => np({ name: t.name, slug: t.slug, url: t.url })),
    });
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const linkOf = (s) => (s === null ? null : np({
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    }));
    const pageOf = (s) => np({
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    });
    const tagOf = (t) => np({
      name: t.name,
      slug: t.slug,
      url: t.url,
      count: t.posts.length,
      posts: t.posts.map((p) => b.cards.get(p)),
    });
    const site = np({ title: b.input.site.title, base_url: b.base });
    const allTags = b.tags.map((t) => np({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    // Templates compile lazily: only the render targets (layouts, index,
    // tag, tags) ever run as functions — partials are inlined at their
    // include sites, so compiling them would be dead work.
    const render = (name, vars) => {
      let fn = b.fns.get(name);
      if (fn === undefined) {
        const nodes = b.templates.get(name);
        if (nodes === undefined) return null;
        fn = compileTemplate(name, nodes, b.templates);
        b.fns.set(name, fn);
      }
      return fn(np({ site, tags: allTags, recent, ...vars }), 0, b.H);
    };
    for (const s of b.sources) {
      const html = render(s.layout, { page: pageOf(s) });
      b.output[`${s.outDir}/index.html`] = html;
    }
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const pager = np({
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      });
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager,
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) {
        b.report.push(`shadowed ${f.path}: a built page has its path`);
        continue;
      }
      b.output[f.path] = f.content;
    }
  }

  // report
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    lines.push(
      `built ${b.pages.length} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`,
    );
    b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

export function run(input) {
  return build(input);
}
