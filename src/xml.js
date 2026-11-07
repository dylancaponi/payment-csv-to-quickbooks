// Minimal XML reader for bank statement files (camt.053). No DOM, no
// dependencies, same code in browsers and Node. Handles the XML declaration,
// comments, processing instructions, CDATA, attributes, self-closing tags,
// namespace prefixes (dropped: <ns2:Ntry> is read as Ntry) and the five
// named entities plus numeric character references. A DOCTYPE is refused
// (bank files never have one, and it is how entity-expansion attacks work).
import { fail } from './errors.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : all;
  });
}

const local = (name) => { const i = name.indexOf(':'); return i >= 0 ? name.slice(i + 1) : name; };

// Returns the root element: { name, attrs, children: [element], text }.
// Exactly one root element is allowed; anything after it other than
// whitespace, comments and processing instructions is refused.
export function parseXml(input) {
  const roots = parseXmlDocuments(input, false);
  return roots[0];
}

// Several XML documents pasted into one file (for example daily bank files
// joined with cat): returns every top-level element, in order. Text outside
// the elements is refused, never ignored.
export function parseXmlAll(input) {
  return parseXmlDocuments(input, true);
}

function parseXmlDocuments(input, many) {
  const s = String(input).replace(/^﻿/, '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const bad = (why) => fail('BAD_FILE', `This XML file is damaged or cut off (${why}). Download the statement again and upload the original file.`);
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += decode(s.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decode(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); if (e < 0) bad('an unclosed comment'); i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt + 9); if (e < 0) bad('an unclosed CDATA section'); stack[stack.length - 1].text += s.slice(lt + 9, e); i = e + 3; continue; }
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt + 2); if (e < 0) bad('an unclosed declaration'); i = e + 2; continue; }
    if (s.startsWith('<!', lt)) fail('BAD_FILE', 'This XML file has a DOCTYPE declaration. Bank statement files do not, so it was not read.');
    // Tag end: the first ">" outside a quoted attribute value (">" is legal
    // inside one).
    let gt = -1;
    for (let j = lt + 1, quote = ''; j < s.length; j++) {
      const ch = s[j];
      if (quote) { if (ch === quote) quote = ''; } else if (ch === '"' || ch === "'") quote = ch; else if (ch === '>') { gt = j; break; }
    }
    if (gt < 0) bad('a tag that never ends');
    const body = s.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = local(body.slice(1).trim());
      const top = stack.pop();
      if (!top || top === root || top.name !== name) bad(`the closing tag </${name}> does not match`);
      continue;
    }
    const selfClose = body.endsWith('/');
    const inner = selfClose ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) bad('an empty tag');
    const el = { name: local(m[1]), attrs: {}, children: [], text: '' };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    const rest = inner.slice(m[1].length);
    while ((a = attrRe.exec(rest))) el.attrs[local(a[1])] = decode(a[3] !== undefined ? a[3] : a[4]);
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (stack.length !== 1) bad(`<${stack[stack.length - 1].name}> is never closed`);
  if (!root.children.length) bad('no elements');
  if (root.text.trim()) fail('BAD_FILE', `This XML file has text outside its elements ("${root.text.trim().slice(0, 40)}"). The file may be damaged or several files may have been joined. Upload the original file.`);
  if (!many && root.children.length > 1) fail('BAD_FILE', `This XML file holds ${root.children.length} top-level elements, but an XML file has exactly one. Several files may have been joined; upload them one at a time.`);
  return root.children;
}

// Path helpers: child(el, 'A', 'B') follows first matches; all(el, 'A')
// lists direct children named A; text(el, ...path) is trimmed text or ''.
export function child(el, ...path) {
  let cur = el;
  for (const p of path) {
    if (!cur) return null;
    cur = cur.children.find((c) => c.name === p) || null;
  }
  return cur;
}

export function all(el, name) {
  return el ? el.children.filter((c) => c.name === name) : [];
}

export function text(el, ...path) {
  const c = child(el, ...path);
  return c ? c.text.trim() : '';
}
