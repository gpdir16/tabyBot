---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions 'deck,' 'slides,' 'presentation,' or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
---

# PPTX Skill

## tabyAgent tools

- **`terminal_run`** — run all scripts (Python, markitdown, npm, LibreOffice).
- **`file_read`** — read extracted XML, reference files, or text output.
- **`file_patch`** — edit XML files (unified diff with exact context lines).
- **`telegram_send_file`** — send the final .pptx to the user.

All script paths below are relative to this skill directory: `{{SYSTEM_SKILLS_DIR}}/pptx/scripts/`.

## Quick Reference

| Task                         | Guide                                              |
| ---------------------------- | -------------------------------------------------- |
| Read/analyze content         | `python -m markitdown presentation.pptx`           |
| Edit or create from template | Read [editing.md](editing.md) with `file_read`     |
| Create from scratch          | Read [pptxgenjs.md](pptxgenjs.md) with `file_read` |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Visual overview (generates thumbnail grid)
python {{SYSTEM_SKILLS_DIR}}/pptx/scripts/thumbnail.py presentation.pptx

# Raw XML
python {{SYSTEM_SKILLS_DIR}}/pptx/scripts/office/unpack.py presentation.pptx unpacked/
```

---

## Editing Workflow

**Read `editing.md` with `file_read` for full details** — the file is at `{{SYSTEM_SKILLS_DIR}}/pptx/editing.md`.

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content with `file_read`/`file_patch` → clean → pack

Key scripts:

```bash
# Unpack
python {{SYSTEM_SKILLS_DIR}}/pptx/scripts/office/unpack.py presentation.pptx unpacked/

# Add a slide from another presentation
python {{SYSTEM_SKILLS_DIR}}/pptx/scripts/add_slide.py source.pptx unpacked/ --slide-index 0

# Clean up unused layouts/masters
python {{SYSTEM_SKILLS_DIR}}/pptx/scripts/clean.py unpacked/

# Pack back to .pptx
python {{SYSTEM_SKILLS_DIR}}/pptx/scripts/office/pack.py unpacked/ output.pptx --original presentation.pptx
```

---

## Creating from Scratch

**Read `pptxgenjs.md` with `file_read` for full details** — the file is at `{{SYSTEM_SKILLS_DIR}}/pptx/pptxgenjs.md`.

Use when no template or reference presentation is available. Uses `pptxgenjs` (`npm install -g pptxgenjs`).

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue.

| Theme                  | Primary               | Secondary             | Accent              |
| ---------------------- | --------------------- | --------------------- | ------------------- |
| **Midnight Executive** | `1E2761` (navy)       | `CADCFC` (ice blue)   | `FFFFFF` (white)    |
| **Forest & Moss**      | `2C5F2D` (forest)     | `97BC62` (moss)       | `F5F5F5` (cream)    |
| **Coral Energy**       | `F96167` (coral)      | `F9E795` (gold)       | `2F3C7E` (navy)     |
| **Warm Terracotta**    | `B85042` (terracotta) | `E7E8D1` (sand)       | `A7BEAE` (sage)     |
| **Ocean Gradient**     | `065A82` (deep blue)  | `1C7293` (teal)       | `21295C` (midnight) |
| **Charcoal Minimal**   | `36454F` (charcoal)   | `F2F2F2` (off-white)  | `212121` (black)    |
| **Teal Trust**         | `028090` (teal)       | `00A896` (seafoam)    | `02C39A` (mint)     |
| **Berry & Cream**      | `6D2E46` (berry)      | `A26769` (dusty rose) | `ECE2D0` (cream)    |
| **Sage Calm**          | `84B59F` (sage)       | `69A297` (eucalyptus) | `50808E` (slate)    |
| **Cherry Bold**        | `990011` (cherry)     | `FCF6F5` (off-white)  | `2F3C7E` (navy)     |

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**

- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**

- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

### Typography

**Choose an interesting font pairing** — don't default to Arial.

| Header Font  | Body Font     |
| ------------ | ------------- |
| Georgia      | Calibri       |
| Arial Black  | Arial         |
| Calibri      | Calibri Light |
| Cambria      | Calibri       |
| Trebuchet MS | Calibri       |
| Impact       | Arial         |
| Palatino     | Garamond      |
| Consolas     | Calibri       |

| Element        | Size          |
| -------------- | ------------- |
| Slide title    | 36-44pt bold  |
| Section header | 20-24pt bold  |
| Body text      | 14-16pt       |
| Captions       | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room—don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements
- **Don't forget text box padding** — set `margin: 0` on the text box or offset the shape
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides

---

## QA (Required)

**Assume there are problems. Your job is to find them.**

Your first render is almost never correct. Approach QA as a bug hunt, not a confirmation step.

### Content QA

```bash
python -m markitdown output.pptx
```

Check for missing content, typos, wrong order. Check for leftover placeholder text:

```bash
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum|this.*(page|slide).*layout"
```

### Visual QA

Convert slides to images for visual inspection:

```bash
python {{SYSTEM_SKILLS_DIR}}/pptx/scripts/office/soffice.py --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

Then use `file_read` on each slide image to inspect it. Look for:

- Overlapping elements (text through shapes, lines through words)
- Text overflow or cut off at edges/box boundaries
- Elements too close (< 0.3" gaps) or cards/sections nearly touching
- Uneven gaps (large empty area in one place, cramped in another)
- Insufficient margin from slide edges (< 0.5")
- Low-contrast text or icons
- Leftover placeholder content

### Verification Loop

1. Generate slides → Convert to images → Inspect
2. **List issues found** (if none found, look again more critically)
3. Fix issues
4. **Re-verify affected slides** — one fix often creates another problem
5. Repeat until a full pass reveals no new issues

**Do not declare success until you've completed at least one fix-and-verify cycle.**

---

## Sending the result

After creating or editing the .pptx, send it to the user:

```
telegram_send_file(path="<output.pptx>")
```

---

## Dependencies

- `pip install "markitdown[pptx]"` — text extraction
- `pip install Pillow` — thumbnail grids
- `npm install -g pptxgenjs` — creating from scratch
- LibreOffice (`soffice`) — PDF conversion (auto-configured via `scripts/office/soffice.py`)
- Poppler (`pdftoppm`) — PDF to images

## Reference files

- **`editing.md`** — Full editing workflow (read with `file_read` before editing)
- **`pptxgenjs.md`** — Creating presentations from scratch (read with `file_read` before creating)
