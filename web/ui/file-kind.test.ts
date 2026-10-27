import { expect, test } from "bun:test";
import {
  COLUMN_LIMIT,
  decodeText,
  dispositionName,
  fileKind,
  imageType,
  parseDelimited,
  ROW_LIMIT,
} from "./file-kind.ts";

test("a CSV keeps the head and ROW_LIMIT rows, each with COLUMN_LIMIT fields at most", () => {
  expect(parseDelimited(",".repeat(10_000), ",")[0]).toHaveLength(COLUMN_LIMIT);
  expect(parseDelimited("a\n".repeat(10_000), ",")).toHaveLength(ROW_LIMIT + 1);
});

test("a file's kind comes from its extension, and any other file may be text", () => {
  expect(fileKind("Photo.JPG")).toBe("image");
  expect(imageType("logo.svg")).toBe("image/svg+xml");
  expect(fileKind("report.pdf")).toBe("pdf");
  expect(fileKind("notes.md")).toBe("markdown");
  expect(fileKind("budget.xlsx")).toBe("sheet");
  expect(fileKind("deck.pptx")).toBe("slides");
  expect(fileKind("letter.docx")).toBe("document");
  expect(fileKind("main.ts")).toBe("text");
  expect(fileKind("Makefile")).toBe("text");
  expect(fileKind(".env")).toBe("text");
});

test("CSV fields can hold quotes, delimiters, and line breaks", () => {
  expect(
    parseDelimited(
      'name,note\r\n"Smith, J","said ""hi""\nthen left"\nKate,',
      ","
    )
  ).toEqual([
    ["name", "note"],
    ["Smith, J", 'said "hi"\nthen left'],
    ["Kate", ""],
  ]);
  expect(parseDelimited("a\tb\n", "\t")).toEqual([["a", "b"]]);
});

test("only UTF-8 bytes without NUL are text", () => {
  expect(decodeText(new TextEncoder().encode("Ahoj, světe").buffer)).toBe(
    "Ahoj, světe"
  );
  expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00]).buffer)).toBeNull();
  expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]).buffer)).toBeNull();
});

test("the name comes from either form of Content-Disposition", () => {
  expect(
    dispositionName("inline; filename*=UTF-8''P%C5%99ehled%202026.pdf")
  ).toBe("Přehled 2026.pdf");
  expect(dispositionName('attachment; filename="a.txt"')).toBe("a.txt");
  expect(dispositionName(null)).toBeUndefined();
});
