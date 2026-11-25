#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import base64
import http.server
import io
import json
import os
import re
import tempfile
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from xml.sax.saxutils import escape

PORT = 8787
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_JSON_PATH = os.path.join(BASE_DIR, "data", "training_db.json")
INIT_JS_PATH = os.path.join(BASE_DIR, "data", "initial_data.js")


def col_letter(n):
    res = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        res = chr(65 + rem) + res
    return res


def extract_text_from_docx_bytes(raw_bytes):
    """Pure standard-library .docx parser (paragraphs + tables) so it works everywhere including Vercel serverless."""
    lines = []
    tables_data = []
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
        if "word/document.xml" not in zf.namelist():
            return "", []
        xml_bytes = zf.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

        for child in root.find("w:body", ns) or []:
            tag = child.tag.split("}")[-1]
            if tag == "p":
                texts = [t.text for t in child.findall(".//w:t", ns) if t.text]
                para = "".join(texts).strip()
                if para:
                    lines.append(para)
            elif tag == "tbl":
                t_rows = []
                for row in child.findall(".//w:tr", ns):
                    r_cells = []
                    for cell in row.findall(".//w:tc", ns):
                        c_texts = [t.text for t in cell.findall(".//w:t", ns) if t.text]
                        r_cells.append(" ".join("".join(c_texts).split()))
                    if any(r_cells):
                        t_rows.append(r_cells)
                        lines.append(" | ".join(r_cells))
                if t_rows:
                    tables_data.append({"sheet": "Bảng trong Word", "rows": t_rows})
    return "\n".join(lines), tables_data


def extract_text_from_xlsx_bytes(raw_bytes):
    """Pure standard-library .xlsx parser (all sheets and cells) so it works without external dependencies."""
    lines = []
    tables_data = []
    with zipfile.ZipFile(io.BytesIO(raw_bytes)) as zf:
        shared_strings = []
        if "xl/sharedStrings.xml" in zf.namelist():
            ss_root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in ss_root.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si"):
                t_vals = [t.text or "" for t in si.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")]
                shared_strings.append("".join(t_vals))

        sheet_names = []
        if "xl/workbook.xml" in zf.namelist():
            wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
            for sh in wb_root.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet"):
                sheet_names.append(sh.attrib.get("name", "Sheet"))

        sheet_files = sorted(
            [n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")],
            key=lambda x: int(re.search(r"sheet(\d+)", x).group(1)) if re.search(r"sheet(\d+)", x) else 0
        )

        for idx, sf in enumerate(sheet_files):
            s_name = sheet_names[idx] if idx < len(sheet_names) else f"Sheet {idx+1}"
            ws_root = ET.fromstring(zf.read(sf))
            s_rows = []
            lines.append(f"=== SHEET: {s_name} ===")
            for row in ws_root.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
                vals = []
                for c in row.findall("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
                    c_type = c.attrib.get("t", "")
                    v_el = c.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v")
                    is_el = c.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}is")
                    val = ""
                    if c_type == "s" and v_el is not None and v_el.text is not None:
                        s_idx = int(v_el.text)
                        if 0 <= s_idx < len(shared_strings):
                            val = shared_strings[s_idx]
                    elif c_type == "inlineStr" and is_el is not None:
                        t_vals = [t.text or "" for t in is_el.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t")]
                        val = "".join(t_vals)
                    elif v_el is not None and v_el.text is not None:
                        val = v_el.text
                    vals.append(str(val).strip())
                if any(v != "" for v in vals):
                    s_rows.append(vals)
                    lines.append(" | ".join([v for v in vals if v]))
            if s_rows:
                tables_data.append({"sheet": s_name, "rows": s_rows})
    return "\n".join(lines), tables_data


def build_training_excel(db):
    """Builds a live .xlsx report of Sales training progress & quiz scores."""
    work_dir = tempfile.mkdtemp(prefix="novastars_sale_xlsx_")
    os.makedirs(os.path.join(work_dir, "_rels"))
    os.makedirs(os.path.join(work_dir, "xl", "_rels"))
    os.makedirs(os.path.join(work_dir, "xl", "worksheets"))

    users = [u for u in db.get("users", []) if u.get("role") == "sale"]
    modules = db.get("modules", [])
    progress_list = db.get("progress", [])

    shared_strings = []
    ss_map = {}

    def get_ss_idx(text):
        text = str(text or "")
        if text not in ss_map:
            ss_map[text] = len(shared_strings)
            shared_strings.append(text)
        return ss_map[text]

    def make_row(r_num, height, cells):
        c_xml = []
        for c_idx, val, style_id in cells:
            ref = f"{col_letter(c_idx)}{r_num}"
            if val is None or val == "":
                c_xml.append(f'<c r="{ref}" s="{style_id}"/>')
            else:
                ss_i = get_ss_idx(val)
                c_xml.append(f'<c r="{ref}" s="{style_id}" t="s"><v>{ss_i}</v></c>')
        return f'<row r="{r_num}" ht="{height}" customHeight="1">{"".join(c_xml)}</row>'

    rows_xml = []
    total_cols = 4 + len(modules)
    title_cells = [(1, "BÁO CÁO TIẾN ĐỘ ĐÀO TẠO & KẾT QUẢ TRẮC NGHIỆM SALE — CHƯƠNG TRÌNH MẦM NON CHUYỂN GIAO NOVASTARS", 1)]
    for c_i in range(2, total_cols + 1):
        title_cells.append((c_i, "", 1))
    rows_xml.append(make_row(1, 34, title_cells))

    header_cells = [
        (1, "STT", 2),
        (2, "Họ và tên Sale", 2),
        (3, "Mã PIN", 2),
        (4, "Tỷ lệ Đạt", 2)
    ]
    for m_idx, mod in enumerate(modules):
        header_cells.append((5 + m_idx, f"{mod.get('code', '')} - {mod.get('title', '')}", 2))
    rows_xml.append(make_row(2, 30, header_cells))

    for u_idx, u in enumerate(users, start=1):
        passed_count = 0
        mod_cells = []
        for m_idx, mod in enumerate(modules):
            prog = next((p for p in progress_list if p.get("userId") == u.get("id") and p.get("moduleId") == mod.get("id")), None)
            thresh = int(mod.get("passThreshold") or 80)
            if prog and prog.get("attempts"):
                best = int(prog.get("bestScore") or 0)
                att_cnt = len(prog.get("attempts") or [])
                if best >= thresh:
                    passed_count += 1
                    mod_cells.append((5 + m_idx, f"ĐẠT: {best}% ({att_cnt} lần)", 3))
                else:
                    mod_cells.append((5 + m_idx, f"CHƯA ĐẠT: {best}% ({att_cnt} lần)", 4))
            elif prog and prog.get("docViewed"):
                mod_cells.append((5 + m_idx, "Đang đọc tài liệu", 5))
            else:
                mod_cells.append((5 + m_idx, "Chưa học", 5))

        pct_str = f"{passed_count}/{len(modules)} ({round(passed_count * 100 / max(1, len(modules)))}%)"
        row_cells = [
            (1, str(u_idx), 5),
            (2, u.get("name", ""), 5),
            (3, u.get("pin", ""), 5),
            (4, pct_str, 3 if passed_count == len(modules) and len(modules) > 0 else 5)
        ] + mod_cells
        rows_xml.append(make_row(2 + u_idx, 26, row_cells))

    sheet_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>{"".join(rows_xml)}</sheetData>
</worksheet>'''
    with open(os.path.join(work_dir, "xl", "worksheets", "sheet1.xml"), "w", encoding="utf-8") as f:
        f.write(sheet_xml)

    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>'''
    with open(os.path.join(work_dir, "[Content_Types].xml"), "w", encoding="utf-8") as f:
        f.write(content_types)

    root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''
    with open(os.path.join(work_dir, "_rels", ".rels"), "w", encoding="utf-8") as f:
        f.write(root_rels)

    workbook_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Tien_Do_Dao_Tao_Sale" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>'''
    with open(os.path.join(work_dir, "xl", "workbook.xml"), "w", encoding="utf-8") as f:
        f.write(workbook_xml)

    workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>'''
    with open(os.path.join(work_dir, "xl", "_rels", "workbook.xml.rels"), "w", encoding="utf-8") as f:
        f.write(workbook_rels)

    si_items = [f'<si><t xml:space="preserve">{escape(s)}</t></si>' for s in shared_strings]
    ss_xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(shared_strings)}" uniqueCount="{len(shared_strings)}">
  {"".join(si_items)}
</sst>'''
    with open(os.path.join(work_dir, "xl", "sharedStrings.xml"), "w", encoding="utf-8") as f:
        f.write(ss_xml)

    styles_xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="5">
    <font><sz val="11"/><color rgb="FF0F172A"/><name val="Arial"/></font>
    <font><b/><sz val="13"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
    <font><b/><sz val="11"/><color rgb="FF065F46"/><name val="Arial"/></font>
    <font><b/><sz val="11"/><color rgb="FF92400E"/><name val="Arial"/></font>
  </fonts>
  <fills count="6">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF9D174D"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFCBD5E1"/></left>
      <right style="thin"><color rgb="FFCBD5E1"/></right>
      <top style="thin"><color rgb="FFCBD5E1"/></top>
      <bottom style="thin"><color rgb="FFCBD5E1"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
  </cellXfs>
</styleSheet>'''
    with open(os.path.join(work_dir, "xl", "styles.xml"), "w", encoding="utf-8") as f:
        f.write(styles_xml)

    out_xlsx = os.path.join(work_dir, "BAO_CAO_DAO_TAO_SALE.xlsx")
    with zipfile.ZipFile(out_xlsx, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(work_dir):
            for file in files:
                if file.endswith(".xlsx"):
                    continue
                full_p = os.path.join(root, file)
                rel_p = os.path.relpath(full_p, work_dir)
                zf.write(full_p, rel_p)
    return out_xlsx


class TrainingRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/data":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            with open(DB_JSON_PATH, "rb") as f:
                self.wfile.write(f.read())
            return

        if parsed.path == "/api/export-excel":
            with open(DB_JSON_PATH, "r", encoding="utf-8") as f:
                db = json.load(f)
            out_path = build_training_excel(db)
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", 'attachment; filename="BAO_CAO_DAO_TAO_SALE_NOVASTARS.xlsx"')
            self.end_headers()
            with open(out_path, "rb") as f:
                self.wfile.write(f.read())
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/save":
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8")
            try:
                data = json.loads(raw_body)
                with open(DB_JSON_PATH, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                with open(INIT_JS_PATH, "w", encoding="utf-8") as f:
                    f.write("window.INITIAL_TRAINING_DB = " + json.dumps(data, ensure_ascii=False) + ";\n")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
            return

        if parsed.path == "/api/extract-file":
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8")
            try:
                payload = json.loads(raw_body)
                filename = (payload.get("filename") or "").lower()
                b64 = payload.get("contentBase64") or ""
                raw_bytes = base64.b64decode(b64)
                text = ""
                tables = []
                if filename.endswith(".docx"):
                    text, tables = extract_text_from_docx_bytes(raw_bytes)
                elif filename.endswith(".xlsx") or filename.endswith(".xls"):
                    text, tables = extract_text_from_xlsx_bytes(raw_bytes)
                else:
                    text = raw_bytes.decode("utf-8", errors="replace")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True, "text": text, "tables": tables}, ensure_ascii=False).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    http.server.HTTPServer.allow_reuse_address = True
    with http.server.HTTPServer(("127.0.0.1", PORT), TrainingRequestHandler) as httpd:
        print(f"Serving NovaStars Sale Training App on http://localhost:{PORT}")
        httpd.serve_forever()
