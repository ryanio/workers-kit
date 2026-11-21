/**
 * A tiny element builder, so a card template needs no React and no JSX.
 *
 * satori reads plain `{ type, props: { style, children } }` objects, which is
 * all these make. Nothing here parses markup, so a name like `<b>hi</b>` is
 * drawn as those eight characters rather than as bold text, and a template
 * cannot be made to inject anything by what it is handed.
 *
 * Text is only ever a string child of its own box, which is what `text` is
 * for: satori lays out a text node as glyphs only when it is the sole child of
 * its element.
 */

export type Style = Record<string, string | number>;

export interface El {
  type: string;
  props: { style?: Style; children?: Child } & Record<string, unknown>;
}

type Child = El | string | (El | string)[];

/** A child that may be left out, so a template can write `cond && text(...)`. */
export type Kid = El | string | null | false | undefined;

/**
 * One element. satori lays out with flexbox only and treats a `div` with no
 * `display` as a block, which silently stacks several children on top of each
 * other, so every `div` gets `display: flex` unless the style says otherwise.
 */
export function h(
  type: string,
  props: Record<string, unknown> & { style?: Style },
  ...kids: Kid[]
): El {
  const children = kids.filter(
    (kid): kid is El | string =>
      kid !== null && kid !== false && kid !== undefined && kid !== "",
  );
  const style =
    type === "div" ? { display: "flex", ...props.style } : props.style;
  const el: El = { type, props: { ...props, ...(style ? { style } : {}) } };
  if (children.length === 1 && children[0] !== undefined) {
    el.props.children = children[0];
  } else if (children.length > 1) {
    el.props.children = children;
  }
  return el;
}

/** A flex box. */
export function div(style: Style, ...kids: Kid[]): El {
  return h("div", { style }, ...kids);
}

/** One run of text in a box of its own. */
export function text(style: Style, content: string): El {
  return h("div", { style }, content);
}

/** A picture at a fixed size. `src` may be a URL or a data URI. */
export function img(
  src: string,
  width: number,
  height: number,
  style: Style = {},
): El {
  return h("img", {
    src,
    width,
    height,
    style: { width, height, ...style },
  });
}

/**
 * Inline SVG markup drawn in a box: a mark, a border, an ornament. It goes in
 * as a data URI because satori draws an `<img>` but not an `<svg>` child, so
 * only pass markup you wrote. Characters outside the data URI's own grammar
 * are percent-encoded; the markup itself is not escaped.
 */
export function svgImage(
  markup: string,
  width: number,
  height: number,
  style: Style = {},
): El {
  return img(
    `data:image/svg+xml;utf8,${encodeURIComponent(markup)}`,
    width,
    height,
    style,
  );
}

/** Base64 of some bytes, for a data URI. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** A `data:` URI for bytes of a known type. */
export function dataUri(type: string, bytes: Uint8Array): string {
  return `data:${type};base64,${base64(bytes)}`;
}
