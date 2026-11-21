import { describe, expect, it } from "vitest";
import { base64, dataUri, div, h, img, svgImage, text } from "../src/h.js";

describe("h", () => {
  it("gives a div flex, since satori stacks a block's children", () => {
    expect(div({ gap: 8 }).props.style).toEqual({ display: "flex", gap: 8 });
  });

  it("lets a style say otherwise", () => {
    expect(div({ display: "none" }).props.style).toEqual({ display: "none" });
  });

  it("leaves an element that is not a div alone", () => {
    expect(h("span", { style: { color: "red" } }).props.style).toEqual({
      color: "red",
    });
  });

  it("writes one child bare and several as an array", () => {
    expect(div({}, "only").props.children).toBe("only");
    expect(div({}, "one", "two").props.children).toEqual(["one", "two"]);
  });

  it("has no children key at all when there are none", () => {
    expect(div({})).not.toHaveProperty("props.children");
  });

  it("drops the children a template conditioned away", () => {
    const hidden = false;
    expect(
      div({}, "kept", hidden && text({}, "no"), null, undefined, "").props
        .children,
    ).toBe("kept");
  });

  it("keeps a zero, which a layout may well mean", () => {
    expect(div({}, "0").props.children).toBe("0");
  });
});

describe("text", () => {
  it("is a string on its own, which is the only shape satori lays out as glyphs", () => {
    const el = text({ fontSize: 40 }, "Hello");
    expect(el.props.children).toBe("Hello");
    expect(el.type).toBe("div");
  });

  it("does not read markup, so a name cannot smuggle in elements", () => {
    expect(text({}, "<b>hi</b>").props.children).toBe("<b>hi</b>");
  });
});

describe("img", () => {
  it("sets the size as attributes and in the style", () => {
    const el = img("https://example.com/a.png", 64, 48, { borderRadius: 8 });
    expect(el.props).toMatchObject({
      src: "https://example.com/a.png",
      width: 64,
      height: 48,
      style: { width: 64, height: 48, borderRadius: 8 },
    });
  });
});

describe("svgImage", () => {
  it("wraps markup in a data URI, encoding what the grammar would break on", () => {
    const el = svgImage('<svg><path d="M0 0h4v4H0z"/></svg>', 4, 4);
    expect(el.props.src).toBe(
      "data:image/svg+xml;utf8,%3Csvg%3E%3Cpath%20d%3D%22M0%200h4v4H0z%22%2F%3E%3C%2Fsvg%3E",
    );
  });

  it("round trips through a URL parser, which is what resvg hands it to", () => {
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#abc"/></svg>';
    const src = svgImage(markup, 10, 10).props.src as string;
    expect(
      decodeURIComponent(src.slice("data:image/svg+xml;utf8,".length)),
    ).toBe(markup);
  });
});

describe("base64 and dataUri", () => {
  it("encodes bytes the way a browser reads them back", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(base64(bytes)).toBe("3q2+7w==");
    expect(dataUri("image/png", bytes)).toBe("data:image/png;base64,3q2+7w==");
  });

  it("handles an empty picture without throwing", () => {
    expect(base64(new Uint8Array())).toBe("");
  });
});
