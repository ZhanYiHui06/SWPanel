#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SWPanel pypdfium2 PDF rasterization helper (Batch E).

Repository-side Python helper invoked SYNCHRONOUSLY by the TypeScript
``PythonPdfiumRasterizer`` (``python-pdfium-rasterizer.ts``) through
``spawnSync`` with ``shell: false`` and bounded timeouts. It performs the two
operations the ``PdfRasterizer`` boundary needs:

- ``probe`` — explicit availability/version check of the renderer
  environment (the TypeScript ``probeAvailability`` API): emits
  ``{"ok": true, "available": true, "rendererVersion": ...}`` when pypdfium2
  is importable, or the structured failure ``RENDERER_UNAVAILABLE`` when the
  Python environment cannot render (pypdfium2 missing);
- ``inspect <pdfPath>`` — the ACTUAL total page count of the PDF;
- ``render <pdfPath> <pageNumber> <dpi> <outputPngPath>`` — rasterizes the
  1-based page at the requested DPI into a PNG and reports the ACTUAL
  rendered metrics (width/height pixels, DPI, page number).

Protocol: exactly ONE JSON document is written to stdout (UTF-8, ASCII-safe
via ``ensure_ascii``); the TypeScript side parses the last non-empty stdout
line. Every documented path emits JSON; the exit code is 0 on success, 1 on a
structured helper failure, 2 on an unhandled internal error. Renderer identity
is reported verbatim as ``rendererVersion`` (e.g. ``"pypdfium2 4.30.0"``) and
is recorded into provenance by the adapter.

Failure classification (stable structured codes, see
``PDF_RASTERIZER_FAILURE_CODES``):

- ``INVALID_PDF`` — the file could not be opened/parsed as a PDF
  (``PdfiumError`` while loading the document);
- ``RENDER_FAILED`` — any other helper failure (bad arguments, out-of-range
  page, renderer error, missing output).

The helper never writes outside the explicit paths it received; all temporary
input/output files are placed by the TypeScript caller in a private directory
outside the repository (or in a supplied secure temp dir) and are cleaned up
by the caller.
"""

import json
import os
import sys

try:
    import pypdfium2 as pdfium
except Exception:  # pragma: no cover - surfaces as a structured failure at runtime
    pdfium = None


MODE_PROBE = "probe"
MODE_INSPECT = "inspect"
MODE_RENDER = "render"

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_INTERNAL = 2

POINTS_PER_INCH = 72.0


def renderer_version():
    """Stable renderer identity string recorded into provenance verbatim."""
    if pdfium is None:
        return "pypdfium2-unavailable"
    return "pypdfium2 {0}".format(getattr(pdfium, "V_PYPDFIUM2", "unknown"))


def emit(payload):
    """Write exactly one JSON document to stdout (ASCII-safe by default)."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


class HelperFailure(Exception):
    """Structured helper failure unwound through the operation handlers."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def is_pdfium_error(exc):
    """Match a PdfiumError without evaluating pypdfium2 attributes when the
    module failed to import (in which case no PdfiumError can exist)."""
    return pdfium is not None and isinstance(exc, pdfium.PdfiumError)


def fail(code, message):
    raise HelperFailure(code, message)


def open_document(pdf_path):
    """Open the PDF, raising HelperFailure(INVALID_PDF) when unparseable."""
    if pdfium is None:
        fail("RENDER_FAILED", "pypdfium2 is not installed in the Python environment")
    if not os.path.isfile(pdf_path):
        fail("INVALID_PDF", "PDF 文件不存在或不可读: {0}".format(pdf_path))
    try:
        return pdfium.PdfDocument(pdf_path)
    except pdfium.PdfiumError as exc:
        fail("INVALID_PDF", "PDF 无法解析: {0}".format(exc))


def run_probe():
    """Explicit availability/version probe: the renderer is available only
    when pypdfium2 is importable. The failure is STRUCTURED (no traceback, no
    paths) and the adapter maps it onto its stable unavailability reasons."""
    if pdfium is None:
        fail(
            "RENDERER_UNAVAILABLE",
            "pypdfium2 is not installed in the Python environment",
        )
    emit({"ok": True, "available": True, "rendererVersion": renderer_version()})


def run_inspect(pdf_path):
    doc = open_document(pdf_path)
    try:
        page_count = len(doc)
    finally:
        doc.close()
    emit(
        {
            "ok": True,
            "pageCount": page_count,
            "rendererVersion": renderer_version(),
        }
    )


def run_render(pdf_path, page_number, dpi, output_path):
    doc = open_document(pdf_path)
    try:
        page_count = len(doc)
        if page_number < 1 or page_number > page_count:
            fail(
                "RENDER_FAILED",
                "page number {0} is out of range (1..{1})".format(
                    page_number, page_count
                ),
            )
        page = doc[page_number - 1]
        scale = float(dpi) / POINTS_PER_INCH
        bitmap = page.render(scale=scale)
        width_px = int(bitmap.width)
        height_px = int(bitmap.height)
        image = bitmap.to_pil()
        image.save(output_path, format="PNG", dpi=(float(dpi), float(dpi)))
        if not os.path.isfile(output_path) or os.path.getsize(output_path) <= 0:
            fail("RENDER_FAILED", "renderer produced no PNG output file")
        emit(
            {
                "ok": True,
                "pageCount": page_count,
                "widthPx": width_px,
                "heightPx": height_px,
                "dpi": float(dpi),
                "pageNumber": page_number,
                "rendererVersion": renderer_version(),
            }
        )
    finally:
        doc.close()


def main(argv):
    if len(argv) < 2:
        emit(
            {
                "ok": False,
                "code": "RENDER_FAILED",
                "message": "usage: pdfium-rasterizer-helper.py <probe|inspect|render> ...",
            }
        )
        return EXIT_FAILURE
    mode = argv[1]
    try:
        if mode == MODE_PROBE:
            if len(argv) != 2:
                fail(
                    "RENDER_FAILED",
                    "usage: pdfium-rasterizer-helper.py probe",
                )
            run_probe()
        elif mode == MODE_INSPECT:
            if len(argv) != 3:
                fail(
                    "RENDER_FAILED",
                    "usage: pdfium-rasterizer-helper.py inspect <pdfPath>",
                )
            run_inspect(argv[2])
        elif mode == MODE_RENDER:
            if len(argv) != 6:
                fail(
                    "RENDER_FAILED",
                    "usage: pdfium-rasterizer-helper.py render "
                    "<pdfPath> <pageNumber> <dpi> <outputPngPath>",
                )
            page_number = int(argv[3])
            dpi = float(argv[4])
            if page_number < 1:
                fail("RENDER_FAILED", "page number must be a positive integer")
            if dpi <= 0:
                fail("RENDER_FAILED", "dpi must be a positive number")
            run_render(argv[2], page_number, dpi, argv[5])
        else:
            fail("RENDER_FAILED", "unknown mode: {0}".format(mode))
    except HelperFailure as failure:
        emit({"ok": False, "code": failure.code, "message": failure.message})
        return EXIT_FAILURE
    except (ValueError, TypeError) as exc:
        emit({"ok": False, "code": "RENDER_FAILED", "message": "invalid argument: {0}".format(exc)})
        return EXIT_FAILURE
    except is_pdfium_error as exc:
        emit({"ok": False, "code": "RENDER_FAILED", "message": "PDFium 渲染失败: {0}".format(exc)})
        return EXIT_FAILURE
    except Exception as exc:  # noqa: BLE001 - last-resort structured failure
        emit({"ok": False, "code": "RENDER_FAILED", "message": "unexpected helper error: {0}".format(exc)})
        return EXIT_INTERNAL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv))
