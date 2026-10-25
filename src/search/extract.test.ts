import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  type Extraction,
  extract,
  isIgnored,
  kindOf,
  tools,
} from "./extract.ts";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "golem-extract-"));
});
afterAll(() => rm(directory, { recursive: true, force: true }));

const texts = (extraction: Extraction) =>
  extraction.segments.map((segment) => segment.text).join("\n");

async function zip(
  name: string,
  files: Record<string, string>
): Promise<string> {
  const path = join(directory, name);
  await Bun.write(
    path,
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([file, text]) => [file, strToU8(text)])
      )
    )
  );
  return path;
}

/** A one-page PDF with real text lines, its byte offsets computed so the cross-reference table is valid. */
async function pdf(name: string, lines: readonly string[]): Promise<string> {
  const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info << /Title (Dental plan) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  const path = join(directory, name);
  await Bun.write(path, body);
  return path;
}

async function ffmpeg(name: string, ...args: string[]): Promise<string> {
  const path = join(directory, name);
  const child = Bun.spawn([tools.ffmpeg!, "-v", "error", "-y", ...args, path], {
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  return path;
}

test("file kinds and ignored files", () => {
  expect(
    ["a.pdf", "b.docx", "c.HEIC", "d.m4a", "e.mov", "f.zip"].map(kindOf)
  ).toEqual(["pdf", "document", "image", "audio", "video", "other"]);
  expect(
    ["~$report.docx", ".DS_Store", "movie.mp4.part", "notes.md"].map(isIgnored)
  ).toEqual([true, true, true, false]);
});

test("Office files, HTML, and RTF become text", async () => {
  const docx = await zip("letter.docx", {
    "word/document.xml":
      "<w:document><w:body><w:p><w:r><w:t>Dear school,</w:t></w:r></w:p><w:p><w:r><w:t>Anna is ill &amp; stays home.</w:t></w:r></w:p></w:body></w:document>",
  });
  expect(texts(await extract(docx))).toBe(
    "Dear school,\nAnna is ill & stays home."
  );

  const xlsx = await zip("budget.xlsx", {
    "xl/workbook.xml":
      '<workbook><sheets><sheet name="October" sheetId="1"/></sheets></workbook>',
    "xl/sharedStrings.xml":
      "<sst><si><t>Groceries</t></si><si><t>Rent</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>412.5</v></c></row><row><c t="s"><v>1</v></c><c><v>1200</v></c></row></sheetData></worksheet>',
  });
  expect(texts(await extract(xlsx))).toBe(
    "October\nGroceries\t412.5\nRent\t1200"
  );

  const pptx = await zip("trip.pptx", {
    "ppt/slides/slide1.xml":
      "<p:sld><a:p><a:r><a:t>Cabin trip</a:t></a:r></a:p></p:sld>",
    "ppt/notesSlides/notesSlide1.xml":
      "<p:notes><a:p><a:r><a:t>Book the boat</a:t></a:r></a:p></p:notes>",
  });
  expect(texts(await extract(pptx))).toBe("Cabin trip\nBook the boat");

  const html = join(directory, "page.html");
  await Bun.write(
    html,
    "<html><head><style>p{}</style></head><body><p>Swimming lessons</p><p>Thursday&nbsp;5pm</p></body></html>"
  );
  expect(texts(await extract(html))).toBe("Swimming lessons\n Thursday 5pm");

  const markdown = join(directory, "note.md");
  await Bun.write(markdown, "# Wifi\n\nThe password is on the router.");
  expect((await extract(markdown)).title).toBe("Wifi");
});

test("a PDF is read page by page, with its title", async () => {
  const extraction = await extract(
    await pdf("plan.pdf", [
      "The dental plan covers two checkups a year for every child,",
      "and fillings at half price. Book the checkups in spring and",
      "in autumn, and bring the insurance card to every visit. The",
      "plan renews each January unless we cancel it in December.",
    ])
  );
  expect(extraction.title).toBe("Dental plan");
  expect(extraction.segments[0]).toMatchObject({
    key: "page:1",
    modality: "text",
    loc: 1,
  });
  expect(texts(extraction)).toContain("two checkups a year");
});

test.skipIf(!tools.ffmpeg)(
  "pictures, audio, and video become media segments",
  async () => {
    const picture = await ffmpeg(
      "photo.png",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1600x1200:duration=1",
      "-frames:v",
      "1"
    );
    const image = (await extract(picture)).segments[0]!;
    expect(image.modality).toBe("image");
    expect(
      "media" in image && image.media[0] === 0xff && image.media[1] === 0xd8
    ).toBe(true); // a JPEG

    const tone = await ffmpeg(
      "voice.m4a",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=40"
    );
    const windows = (await extract(tone)).segments;
    expect(windows.map((segment) => [segment.modality, segment.loc])).toEqual([
      ["audio", 0],
      ["audio", 25],
    ]);

    const silence = await ffmpeg(
      "silence.wav",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      "10"
    );
    expect((await extract(silence)).segments).toEqual([]);

    const movie = await ffmpeg(
      "movie.mp4",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x240:duration=9",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=9",
      "-shortest"
    );
    const kinds = (await extract(movie)).segments.map(
      (segment) => segment.modality
    );
    expect(
      kinds.filter((kind) => kind === "image").length
    ).toBeGreaterThanOrEqual(1);
    expect(kinds).toContain("audio");
  }
);

/** Replaces external tools while `body` runs, then puts the real ones back. */
async function withTools(
  changes: Partial<typeof tools>,
  body: () => Promise<void>
): Promise<void> {
  const saved = { ...tools };
  Object.assign(tools, changes);
  try {
    await body();
  } finally {
    Object.assign(tools, saved);
  }
}

/** A shell script that stands in for an external tool. */
async function fakeTool(name: string, script: string): Promise<string> {
  const path = join(directory, name);
  await Bun.write(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Writes the last argument's file, as pdftoppm, sips, and similar tools do. */
const WRITE_LAST = 'for last; do :; done\nprintf "$CONTENT" > "$last"';

test("OpenDocument files become text", async () => {
  const odt = await zip("letter.odt", {
    "content.xml":
      "<office:text><text:h>Packing list</text:h><text:p>Boots<text:tab/>and<text:s/>socks</text:p></office:text>",
  });
  expect(texts(await extract(odt))).toBe("Packing list\nBoots and socks");

  const ods = await zip("chores.ods", {
    "content.xml":
      "<table:table><table:table-row><table:table-cell>Dishes</table:table-cell><table:table-cell>Otto</table:table-cell></table:table-row></table:table>",
  });
  expect(texts(await extract(ods))).toBe("Dishes Otto");

  const odp = await zip("talk.odp", {
    "content.xml":
      "<draw:page><text:p>Garden plan</text:p></draw:page><draw:page><text:p>Tomatoes</text:p></draw:page>",
  });
  expect(texts(await extract(odp))).toBe("Garden plan\n\nTomatoes");
});

test("spreadsheets and slides keep their order, cells, and entities", async () => {
  const xlsx = await zip("accounts.xlsx", {
    "xl/workbook.xml":
      '<workbook><sheets><sheet name="Q&amp;A"/></sheets></workbook>',
    "xl/worksheets/sheet10.xml":
      "<worksheet><sheetData><row><c><v>10</v></c></row></sheetData></worksheet>",
    "xl/worksheets/sheet2.xml":
      '<worksheet><sheetData><row><c t="inlineStr"><is><t>Caf&#233; &#x2615;</t></is></c><c/></row></sheetData></worksheet>',
  });
  expect(texts(await extract(xlsx))).toBe("Q&A\nCafé ☕\t\n\nSheet 2\n10");

  const pptx = await zip("slides.pptx", {
    "ppt/slides/slide10.xml":
      "<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide2.xml":
      "<p:sld><a:p><a:r><a:t>Fish &lt;3 &quot;chips&quot;</a:t></a:r></a:p></p:sld>",
  });
  expect(texts(await extract(pptx))).toBe('Fish <3 "chips"\n\nLast');
});

test("a broken Office file, an unknown file, and a very large file give no text", async () => {
  const empty = await zip("empty.docx", { "other.xml": "<x/>" });
  await expect(extract(empty)).rejects.toThrow("no word/document.xml inside");

  const archive = join(directory, "photos.zip");
  await Bun.write(archive, "zip");
  expect(await extract(archive)).toEqual({ segments: [] });

  const large = join(directory, "huge.txt");
  await Bun.write(large, "");
  await truncate(large, 50_000_001); // sparse: it uses no disk space
  expect(await extract(large)).toEqual({
    segments: [],
    note: "too large to read",
  });
});

test("RTF is read without textutil, and a legacy Word file needs it", async () => {
  const rtf = join(directory, "recipe.rtf");
  await Bun.write(
    rtf,
    "{\\rtf1\\ansi{\\fonttbl\\f0 Helvetica;}{\\*\\generator Word;}\\f0\\b Pancakes\\b0\\par Two eggs}"
  );
  const doc = join(directory, "old.doc");
  await Bun.write(doc, "binary");
  await withTools({ textutil: null }, async () => {
    expect(texts(await extract(rtf))).toBe("Helvetica;Pancakes\n Two eggs");
    await expect(extract(doc)).rejects.toThrow("legacy Word files need macOS");
  });
});

test.skipIf(!tools.textutil)("textutil reads RTF on macOS", async () => {
  const rtf = join(directory, "macos.rtf");
  await Bun.write(rtf, "{\\rtf1\\ansi Bake at 180 degrees\\par}");
  expect(texts(await extract(rtf))).toBe("Bake at 180 degrees");
});

test("a scanned PDF page becomes a picture with its OCR text", async () => {
  const scan = await pdf("scan.pdf", ["Receipt 42"]);
  const pdftoppm = await fakeTool(
    "pdftoppm",
    `CONTENT='\\377\\330page\\377\\331'\n${WRITE_LAST}.jpg`
  );
  const tesseract = await fakeTool(
    "tesseract",
    [
      'if [ "$1" = "--list-langs" ]; then',
      '  printf "List of available languages (3):\\nces\\neng\\nosd\\n"',
      "  exit 0",
      "fi",
      'printf "Total 12.50 EUR ($6)"',
    ].join("\n")
  );
  await withTools({ pdftoppm, tesseract }, async () => {
    const extraction = await extract(scan);
    expect(extraction.note).toBeUndefined();
    expect(
      extraction.segments.map((segment) => [
        segment.key,
        segment.modality,
        segment.text,
      ])
    ).toEqual([
      ["page:1:text", "none", "Receipt 42"],
      ["page:1:image", "image", "Page 1"],
      ["page:1:ocr", "none", "Total 12.50 EUR (ces+eng)"],
    ]);
    const image = extraction.segments[1]!;
    expect(
      "media" in image && new TextDecoder("latin1").decode(image.media)
    ).toBe("\xff\xd8page\xff\xd9");
  });

  // A tool that fails counts as a missing tool.
  const failing = await fakeTool("tool-failing", "exit 1");
  await withTools({ tesseract: failing }, async () => {
    expect(
      (await extract(scan)).segments.map((segment) => segment.key)
    ).not.toContain("page:1:ocr");
  });
  for (const renderer of [null, failing]) {
    await withTools({ pdftoppm: renderer }, async () => {
      const extraction = await extract(scan);
      expect(extraction.note).toBe("1 scanned pages need poppler (pdftoppm)");
      expect(extraction.segments.map((segment) => segment.key)).toEqual([
        "page:1:text",
      ]);
    });
  }
});

test("a short PDF page of prose keeps a text vector, and a long page keeps all its words", async () => {
  await withTools({ pdftoppm: null }, async () => {
    const short = await extract(
      await pdf("short.pdf", ["Dear Anna, the swimming lessons start in May."])
    );
    expect(short.segments[0]).toMatchObject({
      key: "page:1:text",
      modality: "text",
    });
  });

  const line =
    "The family budget lists rent, food, school costs, and the savings for the summer trip to the sea. ";
  const long = await extract(
    await pdf(
      "long.pdf",
      Array.from({ length: 45 }, () => line)
    )
  );
  expect(
    long.segments.map((segment) => [segment.key, segment.modality])
  ).toEqual([
    ["page:1", "text"],
    ["page:1:rest", "none"],
  ]);
  expect(long.segments[0]!.text.length).toBe(4000);
});

test("a screenshot gets OCR text, and sips converts pictures when ffmpeg cannot", async () => {
  const fakeFfmpeg = await fakeTool(
    "ffmpeg",
    "printf '\\377\\330shot\\377\\331'"
  );
  const tesseract = await fakeTool(
    "tesseract-screen",
    'if [ "$1" = "--list-langs" ]; then exit 1; fi\nprintf "  Error 404  "'
  );
  const screenshot = join(directory, "Screenshot 2026-10-01.jpg");
  await Bun.write(screenshot, "jpeg");
  await withTools({ ffmpeg: fakeFfmpeg, tesseract }, async () => {
    expect(
      (await extract(screenshot)).segments.map((segment) => [
        segment.key,
        segment.text,
      ])
    ).toEqual([
      ["image", "Picture"],
      ["ocr", "Error 404"],
    ]);
  });

  const failing = await fakeTool("ffmpeg-failing", "exit 1");
  const sips = await fakeTool(
    "sips",
    `CONTENT='\\377\\330sips\\377\\331'\n${WRITE_LAST}`
  );
  const photo = join(directory, "beach.heic");
  await Bun.write(photo, "heic");
  await withTools({ ffmpeg: failing, sips }, async () => {
    const [image] = (await extract(photo)).segments;
    expect(image?.modality).toBe("image");
    expect(image && "media" in image && image.media.length).toBe(8);
  });

  const broken = await fakeTool("sips-failing", "exit 1");
  for (const converter of [null, broken]) {
    await withTools({ ffmpeg: null, sips: converter }, async () => {
      expect(await extract(photo)).toEqual({
        segments: [],
        note: "pictures need ffmpeg",
      });
    });
  }
});

test("without ffmpeg, audio and video give a note, and empty audio gives no segments", async () => {
  const song = join(directory, "song.mp3");
  const clip = join(directory, "clip.mov");
  await Bun.write(song, "mp3");
  await Bun.write(clip, "mov");
  await withTools({ ffmpeg: null, sips: null }, async () => {
    expect(await extract(song)).toEqual({
      segments: [],
      note: "audio needs ffmpeg",
    });
    expect(await extract(clip)).toEqual({
      segments: [],
      note: "video needs ffmpeg",
    });
  });
  const silent = await fakeTool("ffmpeg-silent", "exit 0");
  await withTools({ ffmpeg: silent }, async () => {
    expect(await extract(song)).toEqual({ segments: [] });
  });
});

test.skipIf(!tools.ffmpeg)(
  "audio that ends in silence keeps only the windows with sound",
  async () => {
    const recording = await ffmpeg(
      "fade.wav",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=20",
      "-af",
      "apad=whole_dur=51.5"
    );
    const windows = (await extract(recording)).segments;
    expect(windows.map((segment) => [segment.key, segment.text])).toEqual([
      ["audio:0", "0:00–0:30"],
    ]);
  }
);
