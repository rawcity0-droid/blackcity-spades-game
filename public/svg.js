// Tiny SVG builder shared by the card art modules. Builds elements with createElementNS (no innerHTML).

const NS = 'http://www.w3.org/2000/svg';

/** s('rect', {x: 1, fill: 'red'}, child, ...) -> SVGElement. Strings become text nodes. */
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
}

export { NS };
