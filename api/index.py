from http.server import BaseHTTPRequestHandler
import base64
import json
import os
import urllib.parse
from server import (
    build_training_excel,
    extract_text_from_docx_bytes,
    extract_text_from_xlsx_bytes,
    DB_JSON_PATH
)

TMP_DB_PATH = "/tmp/training_db.json"


def load_current_db():
    if os.path.exists(TMP_DB_PATH):
        try:
            with open(TMP_DB_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    with open(DB_JSON_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_current_db(data):
    with open(TMP_DB_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        with open(DB_JSON_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/data":
            db = load_current_db()
            raw = json.dumps(db, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return

        if parsed.path == "/api/export-excel":
            db = load_current_db()
            out_path = build_training_excel(db)
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", 'attachment; filename="BAO_CAO_DAO_TAO_SALE_NOVASTARS.xlsx"')
            self.end_headers()
            with open(out_path, "rb") as f:
                self.wfile.write(f.read())
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/save":
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8")
            try:
                data = json.loads(raw_body)
                save_current_db(data)
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
