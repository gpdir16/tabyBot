---
name: docx
description: "Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of 'Word doc', 'word document', '.docx', or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads. Also use when extracting or reorganizing content from .docx files, inserting or replacing images in documents, performing find-and-replace in Word files, working with tracked changes or comments, or converting content into a polished Word document. If the user asks for a 'report', 'memo', 'letter', 'template', or similar deliverable as a Word or .docx file, use this skill. Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation."
---

# DOCX creation, editing, and analysis

## Overview

A .docx file is a ZIP archive containing XML files.

## tabyAgent tools

- **`terminal_run`** — run all scripts (Python, pandoc, npm, LibreOffice).
- **`file_read`** — read extracted XML or text output.
- **`file_patch`** — edit XML files (unified diff with exact context lines).
- **`telegram_send_file`** — send the final .docx to the user.

All script paths below are relative to this skill directory: `{{SYSTEM_SKILLS_DIR}}/docx/scripts/`.

## Quick Reference

| Task                   | Approach                                         |
| ---------------------- | ------------------------------------------------ |
| Read/analyze content   | `pandoc` or unpack for raw XML                   |
| Create new document    | Use `docx-js` — see Creating New Documents below |
| Edit existing document | Unpack → edit XML → repack                       |

### Converting .doc to .docx

Legacy `.doc` files must be converted before editing:

```bash
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/office/soffice.py --headless --convert-to docx document.doc
```

### Reading Content

```bash
# Text extraction with tracked changes
pandoc --track-changes=all document.docx -o output.md

# Raw XML access
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/office/unpack.py document.docx unpacked/
```

### Converting to Images

```bash
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/office/soffice.py --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

### Accepting Tracked Changes

```bash
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/accept_changes.py input.docx output.docx
```

---

## Creating New Documents

Generate .docx files with JavaScript, then validate. Install: `npm install -g docx`

### Setup

```javascript
const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    ImageRun,
    Header,
    Footer,
    AlignmentType,
    PageOrientation,
    LevelFormat,
    ExternalHyperlink,
    InternalHyperlink,
    Bookmark,
    FootnoteReferenceRun,
    PositionalTab,
    PositionalTabAlignment,
    PositionalTabRelativeTo,
    PositionalTabLeader,
    TabStopType,
    TabStopPosition,
    Column,
    SectionType,
    TableOfContents,
    HeadingLevel,
    BorderStyle,
    WidthType,
    ShadingType,
    VerticalAlign,
    PageNumber,
    PageBreak,
} = require("docx");

const doc = new Document({
    sections: [
        {
            children: [
                /* content */
            ],
        },
    ],
});
Packer.toBuffer(doc).then((buffer) => fs.writeFileSync("doc.docx", buffer));
```

### Validation

After creating the file, validate it. If validation fails, unpack, fix the XML, and repack.

```bash
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/office/validate.py doc.docx
```

### Page Size

```javascript
// CRITICAL: docx-js defaults to A4, not US Letter
// Always set page size explicitly for consistent results
sections: [
    {
        properties: {
            page: {
                size: {
                    width: 12240, // 8.5 inches in DXA
                    height: 15840, // 11 inches in DXA
                },
                margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }, // 1 inch margins
            },
        },
        children: [
            /* content */
        ],
    },
];
```

**Common page sizes (DXA units, 1440 DXA = 1 inch):**

| Paper        | Width  | Height | Content Width (1" margins) |
| ------------ | ------ | ------ | -------------------------- |
| US Letter    | 12,240 | 15,840 | 9,360                      |
| A4 (default) | 11,906 | 16,838 | 9,026                      |

**Landscape orientation:** docx-js swaps width/height internally, so pass portrait dimensions and let it handle the swap:

```javascript
size: {
  width: 12240,   // Pass SHORT edge as width
  height: 15840,  // Pass LONG edge as height
  orientation: PageOrientation.LANDSCAPE  // docx-js swaps them in the XML
},
```

### Styles (Override Built-in Headings)

Use Arial as the default font (universally supported). Keep titles black for readability.

```javascript
const doc = new Document({
    styles: {
        default: { document: { run: { font: "Arial", size: 24 } } }, // 12pt default
        paragraphStyles: [
            {
                id: "Heading1",
                name: "Heading 1",
                basedOn: "Normal",
                next: "Normal",
                quickFormat: true,
                run: { size: 32, bold: true, font: "Arial" },
                paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 },
            },
            {
                id: "Heading2",
                name: "Heading 2",
                basedOn: "Normal",
                next: "Normal",
                quickFormat: true,
                run: { size: 28, bold: true, font: "Arial" },
                paragraph: { spacing: { before: 180, after: 180 }, outlineLevel: 1 },
            },
        ],
    },
    sections: [
        {
            children: [new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Title")] })],
        },
    ],
});
```

### Lists (NEVER use unicode bullets)

```javascript
const doc = new Document({
    numbering: {
        config: [
            {
                reference: "bullets",
                levels: [
                    {
                        level: 0,
                        format: LevelFormat.BULLET,
                        text: "•",
                        alignment: AlignmentType.LEFT,
                        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
                    },
                ],
            },
            {
                reference: "numbers",
                levels: [
                    {
                        level: 0,
                        format: LevelFormat.DECIMAL,
                        text: "%1.",
                        alignment: AlignmentType.LEFT,
                        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
                    },
                ],
            },
        ],
    },
    sections: [
        {
            children: [
                new Paragraph({ numbering: { reference: "bullets", level: 0 }, children: [new TextRun("Bullet item")] }),
                new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun("Numbered item")] }),
            ],
        },
    ],
});
```

### Tables

**CRITICAL: Tables need dual widths** — set both `columnWidths` on the table AND `width` on each cell.

```javascript
const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [4680, 4680],
    rows: [
        new TableRow({
            children: [
                new TableCell({
                    borders,
                    width: { size: 4680, type: WidthType.DXA },
                    shading: { fill: "D5E8F0", type: ShadingType.CLEAR },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [new Paragraph({ children: [new TextRun("Cell")] })],
                }),
            ],
        }),
    ],
});
```

**Width rules:**

- **Always use `WidthType.DXA`** — never `WidthType.PERCENTAGE` (incompatible with Google Docs)
- Table width must equal the sum of `columnWidths`
- Cell `width` must match corresponding `columnWidth`
- For full-width tables: use content width (page width minus left and right margins)

### Images

```javascript
new Paragraph({
    children: [
        new ImageRun({
            type: "png",
            data: fs.readFileSync("image.png"),
            transformation: { width: 200, height: 150 },
            altText: { title: "Title", description: "Desc", name: "Name" },
        }),
    ],
});
```

### Page Breaks

```javascript
new Paragraph({ children: [new PageBreak()] });
```

### Hyperlinks

```javascript
new Paragraph({
    children: [
        new ExternalHyperlink({
            children: [new TextRun({ text: "Click here", style: "Hyperlink" })],
            link: "https://example.com",
        }),
    ],
});
```

### Table of Contents

```javascript
new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" });
```

### Headers/Footers

```javascript
sections: [
    {
        properties: {
            page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
        },
        headers: {
            default: new Header({ children: [new Paragraph({ children: [new TextRun("Header")] })] }),
        },
        footers: {
            default: new Footer({
                children: [
                    new Paragraph({
                        children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })],
                    }),
                ],
            }),
        },
        children: [
            /* content */
        ],
    },
];
```

### Critical Rules for docx-js

- **Set page size explicitly** — docx-js defaults to A4; use US Letter (12240 x 15840 DXA) for US documents
- **Never use `\n`** — use separate Paragraph elements
- **Never use unicode bullets** — use `LevelFormat.BULLET` with numbering config
- **PageBreak must be in Paragraph** — standalone creates invalid XML
- **ImageRun requires `type`** — always specify png/jpg/etc
- **Always set table `width` with DXA** — never use `WidthType.PERCENTAGE`
- **Tables need dual widths** — `columnWidths` array AND cell `width`, both must match
- **Use `ShadingType.CLEAR`** — never SOLID for table shading
- **TOC requires HeadingLevel only** — no custom styles on heading paragraphs
- **Override built-in styles** — use exact IDs: "Heading1", "Heading2", etc.
- **Include `outlineLevel`** — required for TOC (0 for H1, 1 for H2, etc.)

---

## Editing Existing Documents

**Follow all 3 steps in order.**

### Step 1: Unpack

```bash
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/office/unpack.py document.docx unpacked/
```

### Step 2: Edit XML

Edit files in `unpacked/word/` using `file_read` and `file_patch`.

**Use "Claude" as the author** for tracked changes and comments, unless the user explicitly requests a different name.

**Use `file_patch` directly for string replacement.** Do not write Python scripts for simple edits — `file_patch` with unified diff shows exactly what is being replaced.

**CRITICAL: Use smart quotes for new content.** When adding text with apostrophes or quotes, use XML entities:

```xml
<w:t>Here&#x2019;s a quote: &#x201C;Hello&#x201D;</w:t>
```

| Entity     | Character                     |
| ---------- | ----------------------------- |
| `&#x2018;` | ‘ (left single)               |
| `&#x2019;` | ’ (right single / apostrophe) |
| `&#x201C;` | “ (left double)               |
| `&#x201D;` | ” (right double)              |

**Adding comments:** Use `comment.py` to handle boilerplate across multiple XML files:

```bash
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/comment.py unpacked/ 0 "Comment text with &amp; and &#x2019;"
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/comment.py unpacked/ 1 "Reply text" --parent 0
```

Then add markers to document.xml (see Comments in XML Reference below).

### Step 3: Pack

```bash
python {{SYSTEM_SKILLS_DIR}}/docx/scripts/office/pack.py unpacked/ output.docx --original document.docx
```

### Common Pitfalls

- **Replace entire `<w:r>` elements**: When adding tracked changes, replace the whole `<w:r>...</w:r>` block with `<w:del>...<w:ins>...` as siblings. Don't inject tracked change tags inside a run.
- **Preserve `<w:rPr>` formatting**: Copy the original run's `<w:rPr>` block into your tracked change runs to maintain bold, font size, etc.

---

## XML Reference

### Tracked Changes

**Insertion:**

```xml
<w:ins w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:t>inserted text</w:t></w:r>
</w:ins>
```

**Deletion:**

```xml
<w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
  <w:r><w:delText>deleted text</w:delText></w:r>
</w:del>
```

**Inside `<w:del>`**: Use `<w:delText>` instead of `<w:t>`.

**Minimal edits** — only mark what changes:

```xml
<w:r><w:t>The term is </w:t></w:r>
<w:del w:id="1" w:author="Claude" w:date="...">
  <w:r><w:delText>30</w:delText></w:r>
</w:del>
<w:ins w:id="2" w:author="Claude" w:date="...">
  <w:r><w:t>60</w:t></w:r>
</w:ins>
<w:r><w:t> days.</w:t></w:r>
```

**Deleting entire paragraphs** — also mark the paragraph mark as deleted so it merges with the next paragraph. Add `<w:del/>` inside `<w:pPr><w:rPr>`:

```xml
<w:p>
  <w:pPr>
    <w:rPr>
      <w:del w:id="1" w:author="Claude" w:date="2025-01-01T00:00:00Z"/>
    </w:rPr>
  </w:pPr>
  <w:del w:id="2" w:author="Claude" w:date="2025-01-01T00:00:00Z">
    <w:r><w:delText>Entire paragraph content being deleted...</w:delText></w:r>
  </w:del>
</w:p>
```

### Comments

After running `comment.py`, add markers to document.xml.

**CRITICAL: `<w:commentRangeStart>` and `<w:commentRangeEnd>` are siblings of `<w:r>`, never inside `<w:r>`.**

```xml
<w:commentRangeStart w:id="0"/>
<w:r><w:t>text</w:t></w:r>
<w:commentRangeEnd w:id="0"/>
<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>
```

---

## Sending the result

After creating or editing the .docx, send it to the user:

```
telegram_send_file(path="<output.docx>")
```

---

## Dependencies

- **pandoc**: Text extraction
- **docx**: `npm install -g docx` (new documents)
- **LibreOffice**: PDF conversion (auto-configured via `scripts/office/soffice.py`)
- **Poppler**: `pdftoppm` for images
