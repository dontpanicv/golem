import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { type Extraction, extract, isIgnored, kindOf, tools } from "../src/search/extract.ts";

let directory: string;
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "golem-extract-"));
});
afterAll(() => rm(directory, { recursive: true, force: true }));

const texts = (extraction: Extraction) => extraction.segments.map((segment) => segment.text).join("\n");

async function zip(name: string, files: Record<string, string>): Promise<string> {
	const path = join(directory, name);
	await Bun.write(path, zipSync(Object.fromEntries(Object.entries(files).map(([file, text]) => [file, strToU8(text)]))));
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
	const child = Bun.spawn([tools.ffmpeg!, "-v", "error", "-y", ...args, path], { stderr: "pipe" });
	expect(await child.exited).toBe(0);
	return path;
}

test("file kinds and ignored files", () => {
	expect(["a.pdf", "b.docx", "c.HEIC", "d.m4a", "e.mov", "f.zip"].map(kindOf)).toEqual(["pdf", "document", "image", "audio", "video", "other"]);
	expect(["~$report.docx", ".DS_Store", "movie.mp4.part", "notes.md"].map(isIgnored)).toEqual([true, true, true, false]);
});

test("Office files, HTML, and RTF become text", async () => {
	const docx = await zip("letter.docx", { "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Dear school,</w:t></w:r></w:p><w:p><w:r><w:t>Anna is ill &amp; stays home.</w:t></w:r></w:p></w:body></w:document>" });
	expect(texts(await extract(docx))).toBe("Dear school,\nAnna is ill & stays home.");

	const xlsx = await zip("budget.xlsx", {
		"xl/workbook.xml": '<workbook><sheets><sheet name="October" sheetId="1"/></sheets></workbook>',
		"xl/sharedStrings.xml": "<sst><si><t>Groceries</t></si><si><t>Rent</t></si></sst>",
		"xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>412.5</v></c></row><row><c t="s"><v>1</v></c><c><v>1200</v></c></row></sheetData></worksheet>',
	});
	expect(texts(await extract(xlsx))).toBe("October\nGroceries\t412.5\nRent\t1200");

	const pptx = await zip("trip.pptx", {
		"ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Cabin trip</a:t></a:r></a:p></p:sld>",
		"ppt/notesSlides/notesSlide1.xml": "<p:notes><a:p><a:r><a:t>Book the boat</a:t></a:r></a:p></p:notes>",
	});
	expect(texts(await extract(pptx))).toBe("Cabin trip\nBook the boat");

	const html = join(directory, "page.html");
	await Bun.write(html, "<html><head><style>p{}</style></head><body><p>Swimming lessons</p><p>Thursday&nbsp;5pm</p></body></html>");
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
		]),
	);
	expect(extraction.title).toBe("Dental plan");
	expect(extraction.segments[0]).toMatchObject({ key: "page:1", modality: "text", loc: 1 });
	expect(texts(extraction)).toContain("two checkups a year");
});

test.skipIf(!tools.ffmpeg)("pictures, audio, and video become media segments", async () => {
	const picture = await ffmpeg("photo.png", "-f", "lavfi", "-i", "testsrc2=size=1600x1200:duration=1", "-frames:v", "1");
	const image = (await extract(picture)).segments[0]!;
	expect(image.modality).toBe("image");
	expect("media" in image && image.media[0] === 0xff && image.media[1] === 0xd8).toBe(true); // a JPEG

	const tone = await ffmpeg("voice.m4a", "-f", "lavfi", "-i", "sine=frequency=440:duration=40");
	const windows = (await extract(tone)).segments;
	expect(windows.map((segment) => [segment.modality, segment.loc])).toEqual([
		["audio", 0],
		["audio", 25],
	]);

	const silence = await ffmpeg("silence.wav", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "10");
	expect((await extract(silence)).segments).toEqual([]);

	const movie = await ffmpeg("movie.mp4", "-f", "lavfi", "-i", "testsrc2=size=320x240:duration=9", "-f", "lavfi", "-i", "sine=duration=9", "-shortest");
	const kinds = (await extract(movie)).segments.map((segment) => segment.modality);
	expect(kinds.filter((kind) => kind === "image").length).toBeGreaterThanOrEqual(1);
	expect(kinds).toContain("audio");
});
