(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.NovaQuizParser = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STYLE_EMPH_TOKEN = "__STYLE_EMPH__";
  const ANSWER_LETTERS = ["A", "B", "C", "D"];

  const SOURCE_LABELS = {
    col: "Cột Đáp án",
    line: "Dòng Đáp án:",
    key_section: "Bảng đáp án",
    explicit_mark: "Ký hiệu * / (Đúng)",
    style_emphasis: "In đậm / Màu chữ",
    json: "JSON chuẩn",
    manual: "Chỉnh thủ công",
    unresolved: "Chưa xác định ĐA"
  };

  function getAnswerSourceLabel(src) {
    return SOURCE_LABELS[src] || "Đã lưu sẵn";
  }

  function hasValidCorrectIndex(q) {
    if (!q || q.answerUnverified) return false;
    if (q.correctIndex === null || q.correctIndex === undefined || q.correctIndex === "") return false;
    const idx = Number(q.correctIndex);
    return Number.isInteger(idx) && idx >= 0 && idx <= 3;
  }

  function shouldMarkDocxParagraphCorrect(metrics) {
    if (!metrics || !metrics.trimmed) return false;
    const {
      totalNonSpaceChars = 0,
      emphBodyChars = 0,
      hasStrongHighlight = false,
      trimmed = ""
    } = metrics;
    const isWholeOptionEmphasized =
      Boolean(hasStrongHighlight) ||
      (totalNonSpaceChars > 6 && emphBodyChars >= totalNonSpaceChars * 0.65);
    return (
      isWholeOptionEmphasized &&
      /^[-*•]?\s*[A-D][.:)\-]\s+/i.test(trimmed) &&
      !/\(Đáp án đúng\)|\(Đúng\)/i.test(trimmed) &&
      !trimmed.includes(STYLE_EMPH_TOKEN)
    );
  }

  function stripMarkerTokens(str) {
    return String(str || "")
      .replace(/__STYLE_EMPH__/g, "")
      .replace(/\(Đáp án đúng\)|\(Đúng\)|✓|\*+$/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Parse answer letter/number OR full option text -> 0..3 (returns -1 if unresolved)
  function parseAnswerLetterToIdx(ansRaw, optionTexts = []) {
    const sRaw = String(ansRaw || "").replace(/__STYLE_EMPH__/g, "").trim();
    if (!sRaw) return -1;
    const s = sRaw.toUpperCase();

    // 1. Leading letter ("A", "B.", "C)", "*D*", "A - ...")
    const leadMatch = s.match(/^\s*\**([A-D])\**\s*(?:[.:)\-]|$)/);
    if (leadMatch) return leadMatch[1].charCodeAt(0) - 65;

    // 2. Explicit prefixed answer ("Đáp án: B", "Phương án C", "Câu D", "Đ/A: A")
    const prefMatch = s.match(/(?:ĐÁP\s*ÁN|PHƯƠNG\s*ÁN|LỰA\s*CHỌN|CÂU|Đ\/A|ĐA|KẾT\s*QUẢ|KQ|CORRECT|ANSWER|KEY)(?:\s+(?:ĐÚNG|CHUẨN))?\s*[:\-=.]?\s*\**([A-D])\b/);
    if (prefMatch) return prefMatch[1].charCodeAt(0) - 65;

    // 3. Standalone letter A-D anywhere ("(A)", "Chọn B", "B")
    const wordMatch = s.match(/\b([A-D])\b/);
    if (wordMatch) return wordMatch[1].charCodeAt(0) - 65;

    // 4. Numeric index ("1".."4" or "Phương án 2")
    const numMatch = s.match(/^(?:PHƯƠNG\s*ÁN|LỰA\s*CHỌN|CÂU|SỐ)?\s*([1-4])$/);
    if (numMatch) return Number(numMatch[1]) - 1;

    // 5. Full text matching against the 4 options (never grab random A-D letters inside Vietnamese words)
    if (Array.isArray(optionTexts) && optionTexts.length > 0) {
      const norm = v =>
        String(v || "")
          .toLowerCase()
          .replace(/__style_emph__/g, "")
          .replace(/^[-*•]?\s*[a-d][.:)\-]\s*/i, "")
          .replace(/\s+/g, " ")
          .trim();
      const ansNorm = norm(sRaw);
      if (ansNorm.length >= 4) {
        const exactIdx = optionTexts.findIndex(o => norm(o) === ansNorm);
        if (exactIdx !== -1) return exactIdx;
        const partialIdx = optionTexts.findIndex(o => {
          const on = norm(o);
          return on.length >= 6 && (on.includes(ansNorm) || ansNorm.includes(on));
        });
        if (partialIdx !== -1) return partialIdx;
      }
    }
    return -1;
  }

  function parseImportedQuizTextOrTables(rawText, tables, opts = {}) {
    const defaultCategoryLabel = opts.defaultCategoryLabel || "1. Cấu trúc chương trình";
    const resolveCategoryLabel = typeof opts.getCategoryLabel === "function"
      ? opts.getCategoryLabel
      : () => defaultCategoryLabel;
    const parsedQuestions = [];
    const stamp = Date.now();

    // 1. Try JSON format first
    const trimmed = String(rawText || "").trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed);
        const arr = Array.isArray(obj) ? obj : (obj.questions || []);
        arr.forEach((item, idx) => {
          if (item && item.question && Array.isArray(item.options)) {
            const hasValid =
              item.correctIndex !== null &&
              item.correctIndex !== undefined &&
              item.correctIndex !== "" &&
              Number.isInteger(Number(item.correctIndex)) &&
              Number(item.correctIndex) >= 0 &&
              Number(item.correctIndex) <= 3;
            parsedQuestions.push({
              id: item.id || `imp-json-${stamp}-${idx}`,
              category: item.category || "kien_thuc",
              categoryLabel: item.categoryLabel || resolveCategoryLabel(item.category || "kien_thuc"),
              question: String(item.question).trim(),
              options: item.options.slice(0, 4).map(o => String(o || "").trim()),
              correctIndex: hasValid ? Number(item.correctIndex) : -1,
              answerUnverified: !hasValid,
              answerSource: hasValid ? "json" : "unresolved",
              explanation: String(item.explanation || "").trim()
            });
          }
        });
        if (parsedQuestions.length > 0) return parsedQuestions;
      } catch (e) {}
    }

    // Extract Answer Key ONLY from dedicated key sections, compact key lines, or [STT | A-D] table rows
    const answerKeyMap = {};
    const textLinesForKey = String(rawText || "").split(/\r?\n/);
    let inDedicatedKeySection = false;
    textLinesForKey.forEach(rawL => {
      const l = rawL.trim();
      if (!l) return;
      if (/^(?:BẢNG\s+ĐÁP\s+ÁN|ĐÁP\s*ÁN\s+THAM\s+KHẢO|PHẦN\s+ĐÁP\s+ÁN|ĐÁP\s*ÁN\s+CHI\s+TIẾT)/i.test(l)) {
        inDedicatedKeySection = true;
        return;
      }
      const pairs = Array.from(l.matchAll(/\b(\d{1,3})\s*[.:\-)]\s*([A-D])\b/gi));
      const isCompactKeyLine = pairs.length >= 2 && l.length <= pairs.length * 14 + 20;
      const isSingleKeyPairLine = /^\s*(?:Câu\s*)?(\d{1,3})\s*[.:\-)]\s*([A-D])\s*$/i.test(l);
      if (inDedicatedKeySection || isCompactKeyLine || isSingleKeyPairLine) {
        pairs.forEach(m => {
          const qNum = Number(m[1]);
          if (qNum >= 1 && qNum <= 200) {
            answerKeyMap[qNum] = m[2].toUpperCase().charCodeAt(0) - 65;
          }
        });
      }
    });
    if (Array.isArray(tables)) {
      tables.forEach(t => {
        (t.rows || []).forEach(r => {
          if (!Array.isArray(r) || r.length < 2) return;
          const nonEmpty = r.map(c => String(c || "").trim()).filter(Boolean);
          if (nonEmpty.length === 2 && /^(?:Câu\s*)?(\d{1,3})[.:)]?$/i.test(nonEmpty[0]) && /^([A-D])$/i.test(nonEmpty[1])) {
            const qNum = Number(nonEmpty[0].replace(/\D+/g, ""));
            if (qNum >= 1 && qNum <= 200) answerKeyMap[qNum] = nonEmpty[1].toUpperCase().charCodeAt(0) - 65;
          }
        });
      });
    }

    // 2. Try Excel/Table rows if tables are provided
    const extraTableTextBlocks = [];
    if (Array.isArray(tables) && tables.length > 0) {
      tables.forEach(tbl => {
        const rows = tbl.rows || [];
        if (rows.length === 0) return;

        let colQ = -1;
        let colA = -1;
        let colB = -1;
        let colC = -1;
        let colD = -1;
        let colAns = -1;
        let colExp = -1;
        let headerRowIdx = -1;

        for (let r = 0; r < Math.min(rows.length, 15); r++) {
          const rCols = (rows[r] || []).map(c => String(c || "").trim().toLowerCase());
          const nonEmptyH = rCols.filter(Boolean);
          if (nonEmptyH.length < 2) continue;
          const joined = rCols.join(" | ");
          if (/câu\s*hỏi|nội\s*dung|question|phương\s*án\s*a|đáp\s*án\s*a|lựa\s*chọn\s*a|đáp\s*án\s*đúng/i.test(joined)) {
            let tmpQ = -1, tmpA = -1, tmpB = -1, tmpC = -1, tmpD = -1, tmpAns = -1, tmpExp = -1;
            rCols.forEach((h, idx) => {
              if (!h) return;
              // Match option columns A, B, C, D FIRST so "Đáp án A" is never swallowed by "Đáp án" (colAns)
              if (tmpA === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*a(?:\s*\(.*\))?$/i.test(h) || /^a[.:)\-\s]/i.test(h))) tmpA = idx;
              else if (tmpB === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*b(?:\s*\(.*\))?$/i.test(h) || /^b[.:)\-\s]/i.test(h))) tmpB = idx;
              else if (tmpC === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*c(?:\s*\(.*\))?$/i.test(h) || /^c[.:)\-\s]/i.test(h))) tmpC = idx;
              else if (tmpD === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*d(?:\s*\(.*\))?$/i.test(h) || /^d[.:)\-\s]/i.test(h))) tmpD = idx;
              else if (tmpAns === -1 && (/^(?:đáp\s*án|đ\/a|đa|kết\s*quả|correct|answer|key)(?:\s|$|\(|:|–|-)/i.test(h) || /đáp\s*án\s*(?:đúng|chuẩn)|phương\s*án\s*đúng|lựa\s*chọn\s*đúng/i.test(h))) tmpAns = idx;
              else if (tmpExp === -1 && /giải\s*thích|gợi\s*ý|explanation|ghi\s*chú|hướng\s*dẫn/i.test(h)) tmpExp = idx;
              else if (tmpQ === -1 && /câu\s*hỏi|nội\s*dung|question|đề\s*bài/i.test(h)) tmpQ = idx;
            });
            if (tmpQ !== -1 || (tmpA !== -1 && tmpB !== -1)) {
              headerRowIdx = r;
              colA = tmpA;
              colB = tmpB;
              colC = tmpC;
              colD = tmpD;
              colAns = tmpAns;
              colExp = tmpExp;
              colQ = tmpQ !== -1 ? tmpQ : (tmpA > 0 ? tmpA - 1 : 0);
              break;
            }
          }
        }

        rows.forEach((row, rIdx) => {
          if (rIdx <= headerRowIdx) return;
          const cols = row.map(c => String(c || "").trim());
          const nonEmptyCols = cols.filter(Boolean);
          if (nonEmptyCols.length === 0) return;

          if (/^(?:stt|câu\s*hỏi|mã\s*câu)$/i.test(nonEmptyCols[0]) && nonEmptyCols.some(c => /câu\s*hỏi|phương\s*án|đáp\s*án/i.test(c))) {
            return;
          }

          const pushRowToTextBlocks = () => {
            if (nonEmptyCols.length === 2 && /^[A-D]$/i.test(nonEmptyCols[0])) {
              extraTableTextBlocks.push(`${nonEmptyCols[0].toUpperCase()}. ${nonEmptyCols[1]}`);
            } else if (nonEmptyCols.length === 2 && /^(?:đáp\s*án(?:\s*đúng)?|đ\/a|đa|kết\s*quả|kq)$/i.test(nonEmptyCols[0])) {
              extraTableTextBlocks.push(`Đáp án: ${nonEmptyCols[1]}`);
            } else if (nonEmptyCols.length >= 2 && /^(?:câu(?:\s*hỏi)?\s*\d+|\d+)$/i.test(nonEmptyCols[0])) {
              extraTableTextBlocks.push(`Câu ${nonEmptyCols[0].replace(/\D+/g, "") || (parsedQuestions.length + 1)}: ${nonEmptyCols.slice(1).join("\n")}`);
            } else {
              extraTableTextBlocks.push(nonEmptyCols.join("\n"));
            }
          };

          if (nonEmptyCols.length <= 3 && colA === -1) {
            pushRowToTextBlocks();
            return;
          }

          let qText = "";
          let optA = "";
          let optB = "";
          let optC = "";
          let optD = "";
          let ansRaw = "";
          let expText = "";

          if (colQ !== -1 && colA !== -1 && colB !== -1) {
            qText = cols[colQ] || "";
            optA = cols[colA] || "";
            optB = cols[colB] || "";
            optC = colC !== -1 ? (cols[colC] || "") : "";
            optD = colD !== -1 ? (cols[colD] || "") : "";
            ansRaw = colAns !== -1 ? (cols[colAns] || "") : "";
            expText = colExp !== -1 ? (cols[colExp] || "") : "";
          } else {
            let qCol = 0;
            if (/^(?:câu\s*)?\d+[.:)]?$/i.test(cols[0]) && cols.length >= 4) {
              qCol = 1;
              while (qCol + 4 < cols.length && cols[qCol].length < 28 && cols[qCol + 1].length > cols[qCol].length + 10) {
                qCol++;
              }
            }
            qText = cols[qCol] || "";
            optA = cols[qCol + 1] || "";
            optB = cols[qCol + 2] || "";
            optC = cols[qCol + 3] || "";
            optD = cols[qCol + 4] || "";
            ansRaw = cols[qCol + 5] || "";
            expText = cols[qCol + 6] || "";
          }

          if (qText && optA && (!optC || /^[A-D]$/i.test(optB)) && /\bA[.:)]\s+/i.test(optA) && /\bB[.:)]\s+/i.test(optA)) {
            if (/^[A-D]$/i.test(optB) && !ansRaw) ansRaw = optB;
            if (optC && !expText) expText = optC;
            const splitOpts = optA
              .replace(/(?:\r?\n|\s+)(?=(?:\*?\s*[A-D][.:)]\s+))/g, "\n")
              .split(/\n+/)
              .map(s => s.trim())
              .filter(Boolean);
            optA = splitOpts[0] || "";
            optB = splitOpts[1] || "";
            optC = splitOpts[2] || "";
            optD = splitOpts[3] || "";
          }

          const cleanOpt = (s, letter) => {
            const re = new RegExp(`^[-*•]?\\s*\\**${letter}[.:)\\-]\\**\\s*`, "i");
            return String(s || "").replace(re, "").trim();
          };

          if (qText && !optA && !optB && /\bA[.:)]\s+/i.test(qText)) {
            pushRowToTextBlocks();
            return;
          }

          if (qText.length >= 4 && optA && optB) {
            const qIndexNum = parsedQuestions.length + 1;
            const rawOpts = [optA, optB, optC || "", optD || ""];
            let markedOptIdx = -1;
            let markedSource = "";
            let markedCount = 0;

            const finalOpts = rawOpts.map((o, idx) => {
              let txt = cleanOpt(o, String.fromCharCode(65 + idx));
              const hasStyleToken = txt.includes(STYLE_EMPH_TOKEN);
              const hasExplicitMarker = /\(Đáp án đúng\)|\(Đúng\)|^\*|\*$|✓/i.test(txt);
              if (hasStyleToken || hasExplicitMarker) {
                markedCount++;
                if (markedOptIdx === -1 || (!markedSource || (markedSource === "style_emphasis" && hasExplicitMarker))) {
                  markedOptIdx = idx;
                  markedSource = hasExplicitMarker ? "explicit_mark" : "style_emphasis";
                }
                txt = stripMarkerTokens(txt.replace(/^\*+/, ""));
              }
              return txt;
            });

            if (markedCount >= 3 && markedSource === "style_emphasis") {
              markedOptIdx = -1;
              markedSource = "";
            }

            const parsedFromAnsCol = ansRaw ? parseAnswerLetterToIdx(ansRaw, finalOpts) : -1;
            let cIdx = -1;
            let answerSource = "unresolved";

            if (parsedFromAnsCol !== -1) {
              cIdx = parsedFromAnsCol;
              answerSource = "col";
            } else if (answerKeyMap[qIndexNum] !== undefined) {
              cIdx = answerKeyMap[qIndexNum];
              answerSource = "key_section";
            } else if (markedOptIdx !== -1) {
              cIdx = markedOptIdx;
              answerSource = markedSource || "explicit_mark";
            }

            parsedQuestions.push({
              id: `imp-tbl-${stamp}-${qIndexNum}`,
              category: "kien_thuc",
              categoryLabel: defaultCategoryLabel,
              question: qText.replace(/^(?:Câu(?:\s+hỏi)?\s*\d+|Q\d+|\d+)[.:)\-]\s*/i, "").trim() || qText,
              options: finalOpts,
              correctIndex: cIdx,
              answerUnverified: cIdx === -1,
              answerSource,
              explanation: expText || ""
            });
          } else if (nonEmptyCols.length > 0) {
            pushRowToTextBlocks();
          }
        });
      });
      if (parsedQuestions.length > 0) return parsedQuestions;
    }

    // 3. Parse free-form Word / Markdown / Text blocks ("Câu 1: ... A. ... B. ... C. ... D. ... Đáp án: ...")
    const fullTextToParse = [rawText || "", ...extraTableTextBlocks].join("\n");
    const rawLines = fullTextToParse.split(/\r?\n/);
    const lines = [];
    rawLines.forEach(rawLine => {
      let l = rawLine.replace(/\t+/g, "  ").trim();
      if (!l || /^===\s*SHEET:/i.test(l)) return;
      l = l
        .replace(/(?:\s+|\s*\|\s*)(?=(?:\*?\s*[A-D][.:)]\s+\S))/g, "\n")
        .replace(/([?:])(?:\s+)(?=(?:\*?\s*A[.:)\-]\s+\S))/g, "$1\n");
      l.split(/\r?\n/).forEach(sub => {
        const s = sub.trim();
        if (s) lines.push(s);
      });
    });

    let curQ = null;
    let curQNumber = 0;

    function pushCurQ() {
      if (curQ && curQ.question && curQ.options.filter(Boolean).length >= 2) {
        const compactOpts = [];
        for (let i = 0; i < 4; i++) {
          if (curQ.options[i]) compactOpts.push(curQ.options[i]);
        }
        while (compactOpts.length < 4) {
          compactOpts.push("");
        }
        curQ.options = compactOpts.slice(0, 4);

        if (curQ.styleEmphCount >= 3 && curQ.explicitMarkCount === 0 && !curQ.hasExplicitAnsLine) {
          curQ.hasExplicitAnswer = false;
          curQ.correctIndex = -1;
          curQ.answerSource = "unresolved";
          curQ.answerUnverified = true;
        }

        if ((!curQ.hasExplicitAnswer || curQ.answerSource === "style_emphasis") && curQNumber > 0 && answerKeyMap[curQNumber] !== undefined) {
          curQ.correctIndex = answerKeyMap[curQNumber];
          curQ.hasExplicitAnswer = true;
          curQ.answerSource = "key_section";
          curQ.answerUnverified = false;
        }

        const validIdx = Number.isInteger(curQ.correctIndex) && curQ.correctIndex >= 0 && curQ.correctIndex <= 3;
        if (!curQ.hasExplicitAnswer || !validIdx) {
          curQ.correctIndex = -1;
          curQ.answerUnverified = true;
          curQ.answerSource = "unresolved";
        } else {
          curQ.answerUnverified = false;
        }

        delete curQ.hasExplicitAnswer;
        delete curQ.hasExplicitAnsLine;
        delete curQ.styleEmphCount;
        delete curQ.explicitMarkCount;
        parsedQuestions.push(curQ);
      }
      curQ = null;
    }

    function createEmptyQ(questionText) {
      return {
        id: `imp-txt-${stamp}-${parsedQuestions.length + 1}`,
        category: "kien_thuc",
        categoryLabel: defaultCategoryLabel,
        question: questionText,
        options: [],
        correctIndex: -1,
        answerUnverified: true,
        answerSource: "unresolved",
        hasExplicitAnswer: false,
        hasExplicitAnsLine: false,
        styleEmphCount: 0,
        explicitMarkCount: 0,
        explanation: ""
      };
    }

    lines.forEach(line => {
      if (/^(?:BẢNG\s+ĐÁP\s+ÁN|ĐÁP\s+ÁN\s+THAM\s+KHẢO|PHẦN\s+ĐÁP\s+ÁN|ĐÁP\s*ÁN\s+CHI\s+TIẾT)$/i.test(line)) {
        pushCurQ();
        return;
      }

      const qMatch = line.match(/^(?:#+\s*)?\**(?:Câu(?:\s+hỏi|\s+số)?\s*(\d+)|Question\s*(\d+)|Q(\d+)|(\d{1,3}))\**\s*[.:)\-/]\s*(.+)$/i);
      const qHeaderOnlyMatch = !qMatch && line.match(/^(?:#+\s*)?\**(?:Câu(?:\s+hỏi|\s+số)?\s*(\d+)|Question\s*(\d+))\**\s*[.:)\-]?$/i);
      const optMatch = line.match(/^[-*•]?\s*(\*)?\s*\**\[?([A-D])\]?[.:)\-]\**\s*(.+)$/i);
      const ansMatch = line.match(/^(?:👉\s*|✓\s*)?\**(?:Đáp\s*án(?:\s*đúng)?|Đ\/A|ĐA|Kết\s*quả|KQ|Correct|Answer)\**\s*[:\-=.]\s*\**(?:Câu\s*|Phương\s*án\s*)?([A-D])\**/i);
      const expMatch = line.match(/^(?:💡\s*)?\**(?:Giải\s*thích|Ý\s*nghĩa|Gợi\s*ý(?:\s*tư\s*vấn)?|Hướng\s*dẫn|Explanation)\**\s*[:\-=]\s*(.+)$/i);

      if (qMatch && (!curQ || curQ.options.filter(Boolean).length >= 2 || /^(?:Câu|Question|Q)/i.test(line))) {
        pushCurQ();
        curQNumber = Number(qMatch[1] || qMatch[2] || qMatch[3] || qMatch[4] || (parsedQuestions.length + 1));
        curQ = createEmptyQ(qMatch[5].trim());
      } else if (qHeaderOnlyMatch && (!curQ || curQ.options.filter(Boolean).length >= 2)) {
        pushCurQ();
        curQNumber = Number(qHeaderOnlyMatch[1] || qHeaderOnlyMatch[2] || (parsedQuestions.length + 1));
        curQ = createEmptyQ("");
      } else if (optMatch) {
        if (!curQ) {
          curQNumber = parsedQuestions.length + 1;
          curQ = createEmptyQ(`Câu hỏi ${curQNumber}`);
        }
        const hasStarPrefix = Boolean(optMatch[1]);
        const letter = optMatch[2].toUpperCase();
        const idx = letter.charCodeAt(0) - 65;
        let optContent = optMatch[3].trim();
        const hasStyleToken = optContent.includes(STYLE_EMPH_TOKEN);
        const hasExplicitTextMark = hasStarPrefix || /\(Đáp án đúng\)|\(Đúng\)|✓|\*$/i.test(optContent);

        if (hasStyleToken) curQ.styleEmphCount += 1;
        if (hasExplicitTextMark) curQ.explicitMarkCount += 1;

        if ((hasExplicitTextMark || hasStyleToken) && !curQ.hasExplicitAnsLine) {
          curQ.correctIndex = idx;
          curQ.hasExplicitAnswer = true;
          curQ.answerUnverified = false;
          curQ.answerSource = hasExplicitTextMark ? "explicit_mark" : "style_emphasis";
        }
        optContent = stripMarkerTokens(optContent);
        curQ.options[idx] = optContent;
      } else if (ansMatch && curQ) {
        const letter = ansMatch[1].toUpperCase();
        curQ.correctIndex = Math.max(0, Math.min(3, letter.charCodeAt(0) - 65));
        curQ.hasExplicitAnswer = true;
        curQ.hasExplicitAnsLine = true;
        curQ.answerUnverified = false;
        curQ.answerSource = "line";
      } else if (expMatch && curQ) {
        curQ.explanation = expMatch[1].trim();
      } else if (curQ && curQ.question && (/\?$|:$/.test(curQ.question) || curQ.options.length > 0) && curQ.options.filter(Boolean).length < 4) {
        const nextOptIdx = curQ.options.filter(Boolean).length;
        let optContent = line.trim();
        const hasStyleToken = optContent.includes(STYLE_EMPH_TOKEN);
        const hasExplicitTextMark = /\(Đáp án đúng\)|\(Đúng\)|✓|\*$/i.test(optContent);
        if (hasStyleToken) curQ.styleEmphCount += 1;
        if (hasExplicitTextMark) curQ.explicitMarkCount += 1;
        if ((hasExplicitTextMark || hasStyleToken) && !curQ.hasExplicitAnsLine) {
          curQ.correctIndex = nextOptIdx;
          curQ.hasExplicitAnswer = true;
          curQ.answerUnverified = false;
          curQ.answerSource = hasExplicitTextMark ? "explicit_mark" : "style_emphasis";
        }
        optContent = stripMarkerTokens(optContent);
        curQ.options[nextOptIdx] = optContent;
      } else if (curQ && curQ.options.filter(Boolean).length === 0) {
        curQ.question = (curQ.question ? curQ.question + "\n" : "") + line;
      } else if (!curQ && line.length > 10 && !/^(?:ĐÁP\s*ÁN|BÀI\s*KIỂM\s*TRA|ĐỀ\s*THI)/i.test(line)) {
        curQNumber = parsedQuestions.length + 1;
        curQ = createEmptyQ(line);
      }
    });
    pushCurQ();

    return parsedQuestions;
  }

  function auditQuestionBank(questions, opts = {}) {
    const list = Array.isArray(questions) ? questions : [];
    const skewMinQuestions = Number(opts.skewMinQuestions || 6);
    const skewRatioThreshold = Number(opts.skewRatioThreshold || 0.6);

    const distribution = [0, 0, 0, 0];
    const sourceCounts = {
      col: 0,
      line: 0,
      key_section: 0,
      explicit_mark: 0,
      style_emphasis: 0,
      json: 0,
      manual: 0,
      unresolved: 0
    };

    const unverifiedNums = [];
    const missingOptsNums = [];
    const styleEmphasisNums = [];
    const badNumSet = new Set();
    let missingExpCount = 0;

    list.forEach((q, idx) => {
      const qNum = idx + 1;
      const optCount = q && Array.isArray(q.options)
        ? q.options.filter(o => String(o || "").trim().length > 0).length
        : 0;
      const validAns = hasValidCorrectIndex(q);

      if (!validAns) {
        unverifiedNums.push(qNum);
        badNumSet.add(qNum);
      } else {
        distribution[Number(q.correctIndex)] += 1;
      }

      if (optCount < 4) {
        missingOptsNums.push(qNum);
        badNumSet.add(qNum);
      }

      if (!q || !String(q.explanation || "").trim()) {
        missingExpCount += 1;
      }

      const src = !validAns ? "unresolved" : (q.answerSource || "manual");
      if (sourceCounts[src] !== undefined) {
        sourceCounts[src] += 1;
      }
      if (src === "style_emphasis") {
        styleEmphasisNums.push(qNum);
      }
    });

    const validAnswerCount = list.length - unverifiedNums.length;
    let maxIdx = 0;
    for (let i = 1; i < 4; i++) {
      if (distribution[i] > distribution[maxIdx]) maxIdx = i;
    }
    const maxCount = distribution[maxIdx];
    const skewedRatio = validAnswerCount > 0 ? maxCount / validAnswerCount : 0;
    const skewedLetter =
      validAnswerCount >= skewMinQuestions && skewedRatio >= skewRatioThreshold
        ? ANSWER_LETTERS[maxIdx]
        : null;

    return {
      total: list.length,
      validAnswerCount,
      unverifiedCount: unverifiedNums.length,
      unverifiedNums,
      missingOptsCount: missingOptsNums.length,
      missingOptsNums,
      badCount: badNumSet.size,
      badNums: Array.from(badNumSet).sort((a, b) => a - b),
      missingExpCount,
      styleEmphasisCount: styleEmphasisNums.length,
      styleEmphasisNums,
      distribution,
      sourceCounts,
      skewedLetter,
      skewedRatio
    };
  }

  return {
    STYLE_EMPH_TOKEN,
    ANSWER_LETTERS,
    getAnswerSourceLabel,
    hasValidCorrectIndex,
    shouldMarkDocxParagraphCorrect,
    parseAnswerLetterToIdx,
    parseImportedQuizTextOrTables,
    auditQuestionBank
  };
}));
