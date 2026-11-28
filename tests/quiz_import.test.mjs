#!/usr/bin/env node

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

const sandbox = { window: {} };
sandbox.self = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(rootDir, "quiz-parser.js"), "utf8"), sandbox, {
  filename: "quiz-parser.js"
});
const parser = sandbox.NovaQuizParser;
assert.ok(parser && typeof parser.parseImportedQuizTextOrTables === "function", "NovaQuizParser failed to load");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

test("Prose numbers like '3 b' must not corrupt BẢNG ĐÁP ÁN key map", () => {
  const raw = `
Câu 1: Đọc câu 1 cho đúng.
A. Sai 1
B. Đúng 1
C. Sai 1c
D. Sai 1d

Câu 2: Chọn 2 a nếu sai.
A. Sai 2a
B. Sai 2b
C. Đúng 2
D. Sai 2d

Câu 3: Quy trình gồm 3 b quy định bước nào?
A. Đúng A (Xoay gáy)
B. Sai B
C. Sai C
D. Sai D

BẢNG ĐÁP ÁN
1. B  2. C  3. A
`;
  const res = parser.parseImportedQuizTextOrTables(raw, []);
  assert.strictEqual(res.length, 3);
  assert.strictEqual(res[0].correctIndex, 1);
  assert.strictEqual(res[1].correctIndex, 2);
  assert.strictEqual(res[2].correctIndex, 0);
  res.forEach(q => {
    assert.strictEqual(q.answerUnverified, false);
    assert.strictEqual(q.answerSource, "key_section");
  });
});

test("Missing answer must stay unresolved (-1) and never silently default to A", () => {
  const raw = `
Câu 1: Câu này tác giả quên đánh dấu đáp án?
A. Lựa chọn thứ nhất
B. Lựa chọn thứ hai
C. Lựa chọn thứ ba
D. Lựa chọn thứ tư
`;
  const res = parser.parseImportedQuizTextOrTables(raw, []);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].correctIndex, -1);
  assert.strictEqual(res[0].answerUnverified, true);
  assert.strictEqual(res[0].answerSource, "unresolved");
  assert.strictEqual(parser.hasValidCorrectIndex(res[0]), false);
});

test("Word bolding all 4 options must reset to unresolved and strip marker tokens", () => {
  const tok = parser.STYLE_EMPH_TOKEN;
  const raw = `
Câu 1: Cả 4 phương án đều bị bôi đậm trong Word?
A. Phương án một ${tok}
B. Phương án hai ${tok}
C. Phương án ba ${tok}
D. Phương án bốn ${tok}

Câu 2: Chỉ phương án C được tô màu nổi bật?
A. Lựa chọn A
B. Lựa chọn B
C. Lựa chọn C ${tok}
D. Lựa chọn D
`;
  const res = parser.parseImportedQuizTextOrTables(raw, []);
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].correctIndex, -1);
  assert.strictEqual(res[0].answerUnverified, true);
  assert.strictEqual(res[0].answerSource, "unresolved");
  res[0].options.forEach(opt => assert.ok(!opt.includes(tok), "marker token leaked into option"));

  assert.strictEqual(res[1].correctIndex, 2);
  assert.strictEqual(res[1].answerUnverified, false);
  assert.strictEqual(res[1].answerSource, "style_emphasis");
  assert.strictEqual(res[1].options[2], "Lựa chọn C");
});

test("Docx bold-prefix detector ignores bold 'A.' label alone and marks full-body bold", () => {
  assert.strictEqual(
    parser.shouldMarkDocxParagraphCorrect({
      totalNonSpaceChars: 30,
      emphBodyChars: 0,
      hasStrongHighlight: false,
      trimmed: "A. Đây chỉ là chữ A. in đậm"
    }),
    false
  );
  assert.strictEqual(
    parser.shouldMarkDocxParagraphCorrect({
      totalNonSpaceChars: 30,
      emphBodyChars: 25,
      hasStrongHighlight: false,
      trimmed: "C. Phần thân câu trả lời được bôi đậm"
    }),
    true
  );
  assert.strictEqual(
    parser.shouldMarkDocxParagraphCorrect({
      totalNonSpaceChars: 15,
      emphBodyChars: 10,
      hasStrongHighlight: true,
      trimmed: "D. Highlight vàng"
    }),
    true
  );
});

test("Excel table parser handles extended headers, full Vietnamese answer text, and unresolved cells", () => {
  const tables = [
    {
      sheet: "CauHoi",
      rows: [
        ["STT", "Câu hỏi trắc nghiệm", "Phương án A", "Phương án B", "Phương án C", "Phương án D", "Đáp án (A/B/C/D)", "Giải thích"],
        ["1", "Vùng da cần thoa kem chống nắng?", "Chỉ bàn tay", "Chỉ chân", "Khuôn mặt, hai tai, vùng cổ gáy, cánh tay, cẳng chân", "Không cần thoa", "Khuôn mặt, hai tai, vùng cổ gáy, cánh tay, cẳng chân", "Bảo vệ toàn diện"],
        ["2", "Số tiết chuẩn một năm cho mỗi khối?", "36 tiết", "72 tiết", "50 tiết", "90 tiết", "2", "2 tiết x 36 tuần"],
        ["3", "Câu bị bỏ trống cột đáp án", "PA A", "PA B", "PA C", "", "", ""]
      ]
    }
  ];
  const res = parser.parseImportedQuizTextOrTables("", tables);
  assert.strictEqual(res.length, 3);
  assert.strictEqual(res[0].correctIndex, 2);
  assert.strictEqual(res[0].answerUnverified, false);
  assert.strictEqual(res[0].answerSource, "col");

  assert.strictEqual(res[1].correctIndex, 1);
  assert.strictEqual(res[1].answerSource, "col");

  assert.strictEqual(res[2].correctIndex, -1);
  assert.strictEqual(res[2].answerUnverified, true);
  assert.strictEqual(res[2].answerSource, "unresolved");
  assert.strictEqual(res[2].options[3], "");
});

test("auditQuestionBank flags unverified questions, missing 4 options, and A-skewed batches", () => {
  const questions = Array.from({ length: 10 }, (_, i) => ({
    id: `q-${i}`,
    question: `Q${i + 1}`,
    options: ["A", "B", "C", i === 9 ? "" : "D"],
    correctIndex: i < 7 ? 0 : (i === 8 ? -1 : 1),
    answerUnverified: i === 8,
    answerSource: i === 8 ? "unresolved" : "col",
    explanation: i === 0 ? "" : "Giải thích"
  }));
  const audit = parser.auditQuestionBank(questions);
  assert.strictEqual(audit.total, 10);
  assert.strictEqual(audit.unverifiedCount, 1);
  assert.deepStrictEqual([...audit.unverifiedNums], [9]);
  assert.strictEqual(audit.missingOptsCount, 1);
  assert.deepStrictEqual([...audit.missingOptsNums], [10]);
  assert.strictEqual(audit.skewedLetter, "A");
  assert.strictEqual(audit.missingExpCount, 1);
});

test("Live training_db.json published modules pass audit with HP10 Q3 and HP05 Q5/Q25 fixed", () => {
  const dbPath = path.join(rootDir, "data", "training_db.json");
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  const published = (db.modules || []).filter(m => m.status === "published");
  assert.ok(published.length >= 10, "Expected published modules in training_db.json");
  published.forEach(m => {
    const audit = parser.auditQuestionBank(m.questions || []);
    assert.strictEqual(audit.unverifiedCount, 0, `${m.code} has unverified questions`);
    assert.strictEqual(audit.missingOptsCount, 0, `${m.code} has questions missing 4 options`);
  });
  const hp10 = db.modules.find(m => m.id === "mod-mwyg98f2-i3b");
  assert.strictEqual(hp10.questions[2].correctIndex, 0, "HP10 Q3 must be A (index 0)");
  const hp05 = db.modules.find(m => m.id === "mod-mwx7fnso");
  assert.strictEqual(hp05.questions[4].correctIndex, 2, "HP05 Q5 must be C (index 2)");
});

console.log(`\nAll ${passed} quiz import regression tests passed!`);
