---
name: pdf
description: "Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill."
---

# PDF Processing Guide

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features, JavaScript libraries, and detailed examples, see `reference.md`. If you need to fill out a PDF form, read `forms.md` and follow its instructions.

## tabyAgent tools

- **`terminal_run`** — run all scripts and CLI tools (Python, qpdf, pdftotext, etc.).
- **`file_read`** — read extracted text or reference files.
- **`file_patch`** — edit scripts or config files.
- **`telegram_send_file`** — send the final PDF to the user.

All script paths below are relative to this skill directory: `{{SYSTEM_SKILLS_DIR}}/pdf/scripts/`.

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

text = ""
for page in reader.pages:
    text += page.extract_text()
```

## Python Libraries

### pypdf — Basic Operations

#### Merge PDFs

```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF

```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Rotate Pages

```python
reader = PdfReader("input.pdf")
writer = PdfWriter()

page = reader.pages[0]
page.rotate(90)
writer.add_page(page)

with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### pdfplumber — Text and Table Extraction

#### Extract Text with Layout

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        print(text)
```

#### Extract Tables

```python
with pdfplumber.open("document.pdf") as pdf:
    for i, page in enumerate(pdf.pages):
        tables = page.extract_tables()
        for j, table in enumerate(tables):
            print(f"Table {j+1} on page {i+1}:")
            for row in table:
                print(row)
```

### reportlab — Create PDFs

#### Basic PDF Creation

```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter

c.drawString(100, height - 100, "Hello World!")
c.save()
```

#### Create PDF with Multiple Pages

```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

story.append(Paragraph("Report Title", styles['Title']))
story.append(Spacer(1, 12))
story.append(Paragraph("Body text here.", styles['Normal']))
story.append(PageBreak())
story.append(Paragraph("Page 2", styles['Heading1']))

doc.build(story)
```

#### Subscripts and Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters in ReportLab PDFs — they render as black boxes. Use ReportLab's XML markup tags:

```python
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```

## Command-Line Tools

### pdftotext (poppler-utils)

```bash
pdftotext input.pdf output.txt
pdftotext -layout input.pdf output.txt
pdftotext -f 1 -l 5 input.pdf output.txt  # Pages 1-5
```

### qpdf

```bash
# Merge PDFs
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split pages
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf

# Rotate pages
qpdf input.pdf output.pdf --rotate=+90:1

# Remove password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf
```

## Common Tasks

### Extract Text from Scanned PDFs (OCR)

```python
# Requires: pip install pytesseract pdf2image
import pytesseract
from pdf2image import convert_from_path

images = convert_from_path('scanned.pdf')

text = ""
for i, image in enumerate(images):
    text += f"Page {i+1}:\n"
    text += pytesseract.image_to_string(image)
    text += "\n\n"
```

### Add Watermark

```python
from pypdf import PdfReader, PdfWriter

watermark = PdfReader("watermark.pdf").pages[0]
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Convert PDF to Images

```bash
python {{SYSTEM_SKILLS_DIR}}/pdf/scripts/convert_pdf_to_images.py document.pdf output_dir/
```

### Password Protection

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()

for page in reader.pages:
    writer.add_page(page)

writer.encrypt("userpassword", "ownerpassword")

with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

### Fill PDF Forms

For fillable PDF forms, read `forms.md` with `file_read` first, then use the provided scripts:

```bash
python {{SYSTEM_SKILLS_DIR}}/pdf/scripts/check_fillable_fields.py form.pdf
python {{SYSTEM_SKILLS_DIR}}/pdf/scripts/extract_form_field_info.py form.pdf
python {{SYSTEM_SKILLS_DIR}}/pdf/scripts/fill_fillable_fields.py form.pdf output.pdf data.json
```

For annotation-based form filling:

```bash
python {{SYSTEM_SKILLS_DIR}}/pdf/scripts/fill_pdf_form_with_annotations.py form.pdf output.pdf data.json
```

## Quick Reference

| Task               | Best Tool      | Command/Code               |
| ------------------ | -------------- | -------------------------- |
| Merge PDFs         | pypdf          | `writer.add_page(page)`    |
| Split PDFs         | pypdf          | One page per file          |
| Extract text       | pdfplumber     | `page.extract_text()`      |
| Extract tables     | pdfplumber     | `page.extract_tables()`    |
| Create PDFs        | reportlab      | Canvas or Platypus         |
| Command line merge | qpdf           | `qpdf --empty --pages ...` |
| OCR scanned PDFs   | pytesseract    | Convert to image first     |
| Fill PDF forms     | see `forms.md` | Use provided scripts       |

## Sending the result

After creating or editing the PDF, send it to the user:

```
telegram_send_file(path="<output.pdf>")
```

## Dependencies

- `pip install pypdf pdfplumber reportlab pytesseract pdf2image Pillow`
- `qpdf` — command-line merge/split/rotate
- `pdftotext` (poppler-utils) — text extraction
- `pdftoppm` (poppler-utils) — PDF to images

## Reference files

- **`forms.md`** — PDF form filling guide (read with `file_read` before filling forms)
- **`reference.md`** — Advanced PDF operations (read with `file_read` when needed)
