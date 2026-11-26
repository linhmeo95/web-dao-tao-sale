(function () {
  "use strict";

  const STORAGE_KEY = "NOVASTARS_SALE_TRAINING_DB_V1";
  const SESSION_KEY = "NOVASTARS_SALE_CURRENT_USER_V1";
  const NEON_FUNCTION_URL = "https://br-proud-wildflower-bisjmocc-hello.compute.c-5.ap-southeast-1.aws.neon.tech";
  const ROW_CONFIG_ID = "sale_training__config";
  const ROW_PROG_PREFIX = "sale_training__prog__";
  const ROW_PRESENCE_PREFIX = "sale_training__presence__";
  const ROW_ACTIVITY_ID = "sale_training__activity_log";
  const ROW_BUGS_ID = "sale_training__bug_reports";
  const ONLINE_THRESHOLD_MS = 90 * 1000; // 90 seconds

  const QUESTION_CATEGORIES = [
    { key: "kien_thuc", label: "1. Cấu trúc chương trình" },
    { key: "usp_khac_biet", label: "2. Điểm khác biệt USP" },
    { key: "dan_chung_bai_mau", label: "3. Dẫn chứng bài mẫu" },
    { key: "xu_ly_tinh_huong", label: "4. Xử lý tình huống" }
  ];

  let db = loadInitialDb();
  let currentUser = loadInitialUser();
  let activeWorkspaceView = determineInitialWorkspaceView(); // "sale" | "uploader" | "admin"
  let impersonatedSaleUser = null; // When Admin/Uploader previews as a specific Sale
  let currentModuleId = (db.modules && db.modules[0]) ? db.modules[0].id : "";
  let activeSaleTab = "doc"; // "doc" | "quiz"
  let activeUploaderTab = "doc"; // "doc" | "quiz"
  let activeAdminTab = "matrix"; // "matrix" | "dossier" | "analytics"
  let activeDossierSaleId = null;
  let activeAnalyticsModuleId = null;
  let sidebarSearchQuery = "";
  let isSidebarCollapsed = localStorage.getItem("novastars_sale_sidebar_collapsed") === "true";

  // Study document interactive filters (for HP03 sample lessons & HP04 72 lessons)
  let hp03GradeFilter = "ALL";
  let hp04SearchQuery = "";
  let hp04TermFilter = "ALL";
  let hp04AgeMode = "ALL"; // "ALL" | "BE" | "NHO" | "LON"
  let hp04ExpandedTiet = "1";
  let inlineMiniQuizAnswers = {}; // { [questionId]: selectedOptionIndex }

  // Active quiz state for the Sale currently taking a quiz
  let currentQuizAnswers = {}; // { [questionId]: selectedOptionIndex }
  let currentQuizSubmittedResult = null; // null or { score, correctCount, totalCount, passed, answers, timestamp }

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getCategoryLabel(catKey) {
    const found = QUESTION_CATEGORIES.find(c => c.key === catKey);
    return found ? found.label : "Kiến thức tư vấn";
  }

  function loadInitialDb() {
    let result = null;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.modules)) {
          result = parsed;
        }
      } catch (e) {}
    }
    if (!result && window.INITIAL_TRAINING_DB) {
      result = JSON.parse(JSON.stringify(window.INITIAL_TRAINING_DB));
    }
    if (!result) {
      result = {
        meta: { appName: "Cẩm Nang Tư Vấn Mầm Non Chuyển Giao", adminPin: "Nvs123456", defaultPassThreshold: 80 },
        users: [],
        modules: [],
        progress: []
      };
    }

    if (!Array.isArray(result.users)) {
      result.users = (window.INITIAL_TRAINING_DB && Array.isArray(window.INITIAL_TRAINING_DB.users))
        ? JSON.parse(JSON.stringify(window.INITIAL_TRAINING_DB.users))
        : [];
    }
    const targetRosterVersion = (window.INITIAL_TRAINING_DB && window.INITIAL_TRAINING_DB.meta && window.INITIAL_TRAINING_DB.meta.rosterVersion) || 3;
    if (!result.meta) result.meta = {};
    if ((result.meta.rosterVersion || 0) < targetRosterVersion && window.INITIAL_TRAINING_DB && Array.isArray(window.INITIAL_TRAINING_DB.users)) {
      result.users = JSON.parse(JSON.stringify(window.INITIAL_TRAINING_DB.users));
      result.meta.adminPin = (window.INITIAL_TRAINING_DB.meta && window.INITIAL_TRAINING_DB.meta.adminPin) || "Nvs123456";
      result.meta.rosterVersion = targetRosterVersion;
      result.meta.updatedAt = new Date().toISOString();
    }
    if (!Array.isArray(result.modules)) {
      result.modules = (window.INITIAL_TRAINING_DB && Array.isArray(window.INITIAL_TRAINING_DB.modules))
        ? JSON.parse(JSON.stringify(window.INITIAL_TRAINING_DB.modules))
        : [];
    }
    if (!Array.isArray(result.progress)) result.progress = [];
    if (!result.presence || typeof result.presence !== "object") result.presence = {};
    if (!Array.isArray(result.activityLogs)) result.activityLogs = [];
    if (!Array.isArray(result.bugReports)) result.bugReports = [];

    localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    return result;
  }

  function loadInitialUser() {
    const params = new URLSearchParams(window.location.search);
    const userParam = params.get("user") || params.get("gv");
    const pinParam = params.get("pin");
    const adminPin = (db.meta && db.meta.adminPin) ? String(db.meta.adminPin).trim() : "Nvs123456";

    if (userParam === "admin" && pinParam === adminPin) {
      const adminObj = { id: "admin", name: "Admin", role: "admin" };
      localStorage.setItem(SESSION_KEY, JSON.stringify(adminObj));
      return adminObj;
    }

    if (userParam) {
      const found = (db.users || []).find(u => u.id === userParam);
      if (found && (!pinParam || String(found.pin).trim() === String(pinParam).trim())) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(found));
        return found;
      }
    }

    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.id && parsed.role) {
          if (parsed.role === "admin") return parsed;
          const matchedUser = (db.users || []).find(u => u.id === parsed.id && u.role === parsed.role);
          if (matchedUser) {
            return { id: matchedUser.id, name: matchedUser.name, role: matchedUser.role };
          }
          localStorage.removeItem(SESSION_KEY);
        }
      } catch (e) {}
    }
    return null;
  }

  function determineInitialWorkspaceView() {
    if (!currentUser) return "sale";
    if (currentUser.role === "admin") return "admin";
    if (currentUser.role === "uploader") return "uploader";
    return "sale";
  }

  function getEffectiveLearnerUser() {
    if (impersonatedSaleUser) return impersonatedSaleUser;
    if (currentUser && currentUser.role === "sale") return currentUser;
    const firstSale = (db.users || []).find(u => u.role === "sale");
    return firstSale || { id: "preview-sale", name: "Học Viên (Xem thử)", role: "sale" };
  }

  function getVisibleModulesForLearner() {
    return (db.modules || []).filter(m => m.status !== "draft" && m.status !== "pending");
  }

  function canCurrentUserEditModule(mod) {
    if (!currentUser || !mod) return false;
    if (currentUser.role === "admin") return true;
    if (currentUser.role === "uploader") {
      if (mod.authorId && mod.authorId === currentUser.id) return true;
      const aName = String(mod.authorName || "").trim().toLowerCase();
      const uName = String(currentUser.name || "").trim().toLowerCase();
      return Boolean(aName && uName && aName === uName);
    }
    return false;
  }

  function getCurrentModule() {
    const list = (activeWorkspaceView === "uploader") ? (db.modules || []) : getVisibleModulesForLearner();
    return list.find(m => m.id === currentModuleId) || list[0] || (db.modules || [])[0] || null;
  }

  function getOrCreateProgress(userId, userName, moduleId) {
    if (!Array.isArray(db.progress)) db.progress = [];
    let prog = db.progress.find(p => p.userId === userId && p.moduleId === moduleId);
    if (!prog) {
      prog = {
        id: `prog__${moduleId}__${userId}`,
        userId,
        userName: userName || "",
        moduleId,
        docViewed: false,
        docViewedAt: null,
        bestScore: 0,
        passed: false,
        attempts: [],
        updatedAt: new Date().toISOString()
      };
      db.progress.push(prog);
    } else if (userName) {
      prog.userName = userName;
    }
    return prog;
  }

  function isUserTyping() {
    const active = document.activeElement;
    return active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.tagName === "SELECT");
  }

  // =========================================================================
  // NEON LAKEBASE POSTGRES & FUNCTIONS CLOUD SYNC
  // =========================================================================
  async function fetchNeonStateRows() {
    try {
      const localRes = await fetch("/api/state", { cache: "no-store" });
      if (localRes.ok) {
        const rows = await localRes.json();
        if (Array.isArray(rows)) return rows;
      }
    } catch (e) {}
    try {
      const fnRes = await fetch(`${NEON_FUNCTION_URL}/state`, { cache: "no-store" });
      if (fnRes.ok) {
        const rows = await fnRes.json();
        if (Array.isArray(rows)) return rows;
      }
    } catch (e) {}
    return null;
  }

  async function fetchCloudDb(forceRender = false) {
    try {
      const rows = await fetchNeonStateRows();
      if (!Array.isArray(rows) || rows.length === 0) return false;

      let cloudConfig = null;
      const cloudProgress = [];
      const cloudPresence = {};
      let cloudActivityLogs = null;
      let cloudBugReports = null;

      rows.forEach(row => {
        if (row.id === ROW_CONFIG_ID && row.payload) {
          cloudConfig = row.payload;
        } else if (row.id && row.id.startsWith(ROW_PROG_PREFIX) && row.payload) {
          cloudProgress.push(row.payload);
        } else if (row.id && row.id.startsWith(ROW_PRESENCE_PREFIX) && row.payload) {
          const uid = row.payload.userId || row.id.slice(ROW_PRESENCE_PREFIX.length);
          cloudPresence[uid] = row.payload;
        } else if (row.id === ROW_ACTIVITY_ID && row.payload && Array.isArray(row.payload.items)) {
          cloudActivityLogs = row.payload.items;
        } else if (row.id === ROW_BUGS_ID && row.payload && Array.isArray(row.payload.items)) {
          cloudBugReports = row.payload.items;
        }
      });

      if (Object.keys(cloudPresence).length > 0) {
        db.presence = { ...(db.presence || {}), ...cloudPresence };
      }
      if (Array.isArray(cloudActivityLogs)) {
        const logMap = new Map();
        (db.activityLogs || []).forEach(item => { if (item && item.id) logMap.set(item.id, item); });
        cloudActivityLogs.forEach(item => { if (item && item.id) logMap.set(item.id, item); });
        db.activityLogs = Array.from(logMap.values())
          .sort((a, b) => (Date.parse(b.timestamp || "") || 0) - (Date.parse(a.timestamp || "") || 0))
          .slice(0, 150);
      }
      if (Array.isArray(cloudBugReports)) {
        const bugMap = new Map();
        (db.bugReports || []).forEach(item => { if (item && item.id) bugMap.set(item.id, item); });
        cloudBugReports.forEach(item => {
          if (!item || !item.id) return;
          const localItem = bugMap.get(item.id);
          if (!localItem || (Date.parse(item.updatedAt || item.createdAt || "") || 0) >= (Date.parse(localItem.updatedAt || localItem.createdAt || "") || 0)) {
            bugMap.set(item.id, item);
          }
        });
        db.bugReports = Array.from(bugMap.values())
          .sort((a, b) => (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0));
      }

      if (cloudConfig) {
        const cloudTime = Date.parse((cloudConfig.meta && cloudConfig.meta.updatedAt) || "") || 0;
        const localTime = Date.parse((db.meta && db.meta.updatedAt) || "") || 0;
        const cloudRosterVer = (cloudConfig.meta && cloudConfig.meta.rosterVersion) || 0;
        const localRosterVer = (db.meta && db.meta.rosterVersion) || 3;

        if (cloudRosterVer >= localRosterVer && cloudTime >= localTime) {
          if (cloudConfig.meta) {
            db.meta = { ...db.meta, ...cloudConfig.meta };
          }
          if (Array.isArray(cloudConfig.users)) {
            db.users = cloudConfig.users;
          }
          if (Array.isArray(cloudConfig.modules) && cloudConfig.modules.length > 0) {
            const localStructMap = new Map();
            const localModMap = new Map();
            (db.modules || []).forEach(m => {
              if (m && m.id) {
                localModMap.set(m.id, m);
                if (m.structuredData) localStructMap.set(m.id, m.structuredData);
              }
            });
            const mergedMods = cloudConfig.modules.map(cm => ({
              ...cm,
              structuredData: cm.structuredData || localStructMap.get(cm.id)
            }));
            const cloudIds = new Set(mergedMods.map(m => m.id));
            localModMap.forEach((lm, lid) => {
              if (!cloudIds.has(lid)) mergedMods.push(lm);
            });
            db.modules = mergedMods;
          }
        } else {
          // Local changes are newer than cloud; push local config to cloud
          triggerAutoSave(true, true);
        }
      }

      if (cloudProgress.length > 0) {
        const pMap = new Map();
        (db.progress || []).forEach(p => {
          pMap.set(`${p.moduleId}__${p.userId}`, p);
        });
        cloudProgress.forEach(cp => {
          const key = `${cp.moduleId}__${cp.userId}`;
          const existing = pMap.get(key);
          if (!existing) {
            pMap.set(key, cp);
          } else {
            const exAttempts = Array.isArray(existing.attempts) ? existing.attempts : [];
            const cpAttempts = Array.isArray(cp.attempts) ? cp.attempts : [];
            const mergedAttempts = cpAttempts.length >= exAttempts.length ? cpAttempts : exAttempts;
            pMap.set(key, {
              ...existing,
              ...cp,
              docViewed: Boolean(existing.docViewed || cp.docViewed),
              bestScore: Math.max(Number(existing.bestScore || 0), Number(cp.bestScore || 0)),
              passed: Boolean(existing.passed || cp.passed),
              attempts: mergedAttempts
            });
          }
        });
        db.progress = Array.from(pMap.values());
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      if (forceRender || !isUserTyping()) {
        renderAll();
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async function fetchServerDb() {
    const cloudOk = await fetchCloudDb(true);
    if (cloudOk) return;
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (res.ok) {
        const serverDb = await res.json();
        if (serverDb && Array.isArray(serverDb.modules)) {
          // Only adopt serverDb if local storage has never been modified by user AND server is newer
          const srvTime = Date.parse((serverDb.meta && serverDb.meta.updatedAt) || "") || 0;
          const locTime = Date.parse((db.meta && db.meta.updatedAt) || "") || 0;
          const localModified = Boolean(db.meta && db.meta.localModified);
          if (!localModified && srvTime > locTime) {
            db = serverDb;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
            renderAll();
          } else {
            // Local has user changes; sync them back to local server immediately
            fetch("/api/save", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(db)
            }).catch(() => {});
          }
        }
      }
    } catch (e) {}
  }

  async function saveRowsToSupabase(rowsToUpsert) {
    try {
      const localRes = await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rowsToUpsert)
      });
      if (localRes.ok) return true;
    } catch (e) {}
    try {
      const fnRes = await fetch(`${NEON_FUNCTION_URL}/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rowsToUpsert)
      });
      return fnRes.ok;
    } catch (e) {
      return false;
    }
  }

  function computeCurrentPresenceStatus() {
    if (!currentUser) return "";
    const mod = getCurrentModule();
    const modCode = mod ? mod.code : "";
    if (activeWorkspaceView === "admin") {
      const tabNames = {
        matrix: "Bảng tiến độ Học Viên",
        modules: "Quản lý & Duyệt học phần",
        activity: "Theo dõi hoạt động & Online",
        bugs: "Xử lý Báo lỗi",
        dossier: "Hồ sơ Học Viên",
        analytics: "Thống kê câu hỏi"
      };
      return `Đang xem Admin: ${tabNames[activeAdminTab] || "Bảng điều khiển"}`;
    }
    if (activeWorkspaceView === "uploader") {
      if (activeUploaderTab === "quiz") return `Đang soạn câu hỏi ${modCode}`;
      if (activeUploaderTab === "bugs") return `Đang xem & xử lý Báo lỗi`;
      return `Đang biên tập tài liệu ${modCode}`;
    }
    if (activeSaleTab === "quiz") {
      if (isExamInProgress) {
        const qCnt = (mod && Array.isArray(mod.questions)) ? mod.questions.length : 0;
        return `Đang thi trắc nghiệm ${modCode} (Câu ${activeQuizQuestionIndex + 1}/${qCnt})`;
      }
      if (currentQuizSubmittedResult) {
        return `Vừa nộp bài thi ${modCode} (${currentQuizSubmittedResult.score}%)`;
      }
      return `Đang xem mục Trắc nghiệm ${modCode}`;
    }
    return `Đang đọc tài liệu ${modCode} (Mục ${activeDocStepIndex + 1})`;
  }

  function sendPresenceHeartbeat(customStatus = "") {
    if (!currentUser) return;
    if (!db.presence || typeof db.presence !== "object") db.presence = {};
    const mod = getCurrentModule();
    const record = {
      userId: currentUser.id,
      userName: currentUser.name,
      role: currentUser.role,
      statusText: customStatus || computeCurrentPresenceStatus(),
      moduleId: mod ? mod.id : "",
      moduleCode: mod ? mod.code : "",
      lastSeenAt: new Date().toISOString()
    };
    db.presence[currentUser.id] = record;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    saveRowsToSupabase([
      {
        id: `${ROW_PRESENCE_PREFIX}${currentUser.id}`,
        payload: record,
        updated_at: record.lastSeenAt
      }
    ]).catch(() => {});
  }

  function logUserActivity(actionType, actionLabel, detail = "", moduleCode = "") {
    if (!currentUser) return;
    if (!Array.isArray(db.activityLogs)) db.activityLogs = [];
    const entry = {
      id: "act-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      userId: currentUser.id,
      userName: currentUser.name,
      role: currentUser.role,
      actionType,
      actionLabel,
      detail,
      moduleCode,
      timestamp: new Date().toISOString()
    };
    db.activityLogs.unshift(entry);
    if (db.activityLogs.length > 150) {
      db.activityLogs = db.activityLogs.slice(0, 150);
    }
    sendPresenceHeartbeat(`${actionLabel}${moduleCode ? " (" + moduleCode + ")" : ""}`);
    triggerAutoSave(true, false);
  }

  let saveTimer = null;
  function triggerAutoSave(immediate = false, saveConfig = false, specificProg = null) {
    if (!db.meta) db.meta = {};
    db.meta.updatedAt = new Date().toISOString();
    db.meta.localModified = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));

    const saveText = document.getElementById("saveText");
    const nowStr = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
    if (saveText) saveText.textContent = "Đang lưu...";

    // Always send to local server right away when immediate is true
    if (immediate) {
      fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(db),
        keepalive: true
      }).catch(() => {});
    }

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const rows = [];
      if (saveConfig) {
        rows.push({
          id: ROW_CONFIG_ID,
          payload: {
            meta: db.meta,
            users: db.users,
            modules: db.modules
          },
          updated_at: new Date().toISOString()
        });
      }

      if (Array.isArray(db.activityLogs) && db.activityLogs.length > 0) {
        rows.push({
          id: ROW_ACTIVITY_ID,
          payload: { items: db.activityLogs.slice(0, 150) },
          updated_at: new Date().toISOString()
        });
      }

      if (Array.isArray(db.bugReports) && (db.bugReports.length > 0 || (db.meta && db.meta.bugsModified))) {
        rows.push({
          id: ROW_BUGS_ID,
          payload: { items: db.bugReports },
          updated_at: new Date().toISOString()
        });
      }

      if (currentUser && db.presence && db.presence[currentUser.id]) {
        rows.push({
          id: `${ROW_PRESENCE_PREFIX}${currentUser.id}`,
          payload: db.presence[currentUser.id],
          updated_at: new Date().toISOString()
        });
      }

      if (specificProg) {
        rows.push({
          id: `${ROW_PROG_PREFIX}${specificProg.moduleId}__${specificProg.userId}`,
          payload: specificProg,
          updated_at: new Date().toISOString()
        });
      } else if (currentUser && currentModuleId) {
        const learner = getEffectiveLearnerUser();
        const curProg = (db.progress || []).find(p => p.userId === learner.id && p.moduleId === currentModuleId);
        if (curProg) {
          rows.push({
            id: `${ROW_PROG_PREFIX}${curProg.moduleId}__${curProg.userId}`,
            payload: curProg,
            updated_at: new Date().toISOString()
          });
        }
      }

      let cloudSaved = false;
      if (rows.length > 0) {
        const uniqueRows = Array.from(new Map(rows.map(r => [r.id, r])).values());
        cloudSaved = await saveRowsToSupabase(uniqueRows);
      }

      try {
        await fetch("/api/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(db)
        });
      } catch (e) {}

      if (saveText) {
        saveText.textContent = cloudSaved ? `Đã lưu Cloud ${nowStr}` : `✓ Đã lưu ${nowStr}`;
      }
    }, immediate ? 40 : 300);
  }

  // =========================================================================
  // AUTHENTICATION PORTAL (3 ROLES)
  // =========================================================================
  function populateAuthSelects() {
    const selSale = document.getElementById("authSelectSale");
    const selUploader = document.getElementById("authSelectUploader");

    if (selSale) {
      const cur = selSale.value;
      selSale.innerHTML = `<option value="" disabled selected>-- Chọn tên Học Viên --</option>`;
      (db.users || []).filter(u => u.role === "sale").forEach(u => {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = u.name;
        selSale.appendChild(opt);
      });
      if (cur) selSale.value = cur;
    }

    if (selUploader) {
      const cur = selUploader.value;
      selUploader.innerHTML = `<option value="" disabled selected>-- Chọn tên nhân sự Đào tạo --</option>`;
      (db.users || []).filter(u => u.role === "uploader").forEach(u => {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = u.name;
        selUploader.appendChild(opt);
      });
      if (cur) selUploader.value = cur;
    }
  }

  function setupAuthPortal() {
    const tabSale = document.getElementById("authTabSale");
    const tabUploader = document.getElementById("authTabUploader");
    const tabAdmin = document.getElementById("authTabAdmin");

    const formSale = document.getElementById("formSaleLogin");
    const formUploader = document.getElementById("formUploaderLogin");
    const formAdmin = document.getElementById("formAdminLogin");

    const errSale = document.getElementById("authSaleError");
    const errUploader = document.getElementById("authUploaderError");
    const errAdmin = document.getElementById("authAdminError");

    function switchAuthTab(role) {
      [
        [tabSale, formSale, role === "sale"],
        [tabUploader, formUploader, role === "uploader"],
        [tabAdmin, formAdmin, role === "admin"]
      ].forEach(([tab, form, isAct]) => {
        if (tab) {
          tab.classList.toggle("active", isAct);
          tab.setAttribute("aria-selected", String(isAct));
        }
        if (form) form.classList.toggle("hidden", !isAct);
      });
      [errSale, errUploader, errAdmin].forEach(el => {
        if (el) el.classList.add("hidden");
      });
    }

    if (tabSale) tabSale.addEventListener("click", () => switchAuthTab("sale"));
    if (tabUploader) tabUploader.addEventListener("click", () => switchAuthTab("uploader"));
    if (tabAdmin) tabAdmin.addEventListener("click", () => switchAuthTab("admin"));

    if (formSale) {
      formSale.addEventListener("submit", e => {
        e.preventDefault();
        const userId = document.getElementById("authSelectSale").value;
        const pin = document.getElementById("authSalePin").value.trim();
        const user = (db.users || []).find(u => u.id === userId && u.role === "sale");
        if (!user || String(user.pin).trim() !== pin) {
          errSale.textContent = "Mã PIN không chính xác. Vui lòng kiểm tra lại.";
          errSale.classList.remove("hidden");
          return;
        }
        errSale.classList.add("hidden");
        currentUser = { id: user.id, name: user.name, role: "sale" };
        impersonatedSaleUser = null;
        activeWorkspaceView = "sale";
        localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
        resetActiveQuizState();
        logUserActivity("login", "Đăng nhập hệ thống", "Vai trò: Học Viên");
        renderAll();
      });
    }

    if (formUploader) {
      formUploader.addEventListener("submit", e => {
        e.preventDefault();
        const userId = document.getElementById("authSelectUploader").value;
        const pin = document.getElementById("authUploaderPin").value.trim();
        const adminPin = (db.meta && db.meta.adminPin) ? String(db.meta.adminPin).trim() : "Nvs123456";
        const user = (db.users || []).find(u => u.id === userId && u.role === "uploader");
        if (!user || (String(user.pin).trim() !== pin && pin !== adminPin)) {
          errUploader.textContent = "Mã PIN Đào tạo chưa đúng.";
          errUploader.classList.remove("hidden");
          return;
        }
        errUploader.classList.add("hidden");
        currentUser = { id: user.id, name: user.name, role: "uploader" };
        impersonatedSaleUser = null;
        activeWorkspaceView = "uploader";
        const ownMod = (db.modules || []).find(m => canCurrentUserEditModule(m));
        if (ownMod) currentModuleId = ownMod.id;
        localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
        logUserActivity("login", "Đăng nhập hệ thống", "Vai trò: Đào tạo");
        renderAll();
      });
    }

    if (formAdmin) {
      formAdmin.addEventListener("submit", e => {
        e.preventDefault();
        const pin = document.getElementById("authAdminPin").value.trim();
        const adminPin = (db.meta && db.meta.adminPin) ? String(db.meta.adminPin).trim() : "Nvs123456";
        if (pin !== adminPin) {
          errAdmin.textContent = "Mã PIN Admin không chính xác.";
          errAdmin.classList.remove("hidden");
          return;
        }
        errAdmin.classList.add("hidden");
        currentUser = { id: "admin", name: "Admin", role: "admin" };
        impersonatedSaleUser = null;
        activeWorkspaceView = "admin";
        localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
        logUserActivity("login", "Đăng nhập hệ thống", "Vai trò: Admin");
        renderAll();
      });
    }

    const btnSignOut = document.getElementById("btnSignOut");
    if (btnSignOut) {
      btnSignOut.addEventListener("click", () => {
        localStorage.removeItem(SESSION_KEY);
        currentUser = null;
        impersonatedSaleUser = null;
        activeWorkspaceView = "sale";
        ["authSalePin", "authUploaderPin", "authAdminPin"].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.value = "";
        });
        renderAll();
      });
    }
  }

  // =========================================================================
  // TOPBAR & SIDEBAR RENDERING
  // =========================================================================
  function renderTopBar() {
    if (!currentUser) return;
    const nameEl = document.getElementById("currentUserName");
    const dotEl = document.getElementById("currentUserDot");
    const switcher = document.getElementById("topWorkspaceSwitcher");
    const btnAdmin = document.getElementById("btnSwitchViewAdmin");
    const btnUploader = document.getElementById("btnSwitchViewUploader");
    const btnSale = document.getElementById("btnSwitchViewSale");
    const btnToggleSidebar = document.getElementById("btnToggleSidebar");

    if (currentUser.role === "admin") {
      nameEl.textContent = "Admin";
      if (dotEl) dotEl.style.background = "#FCD34D";
      switcher.classList.remove("hidden");
      btnAdmin.classList.remove("hidden");
      btnUploader.classList.remove("hidden");
      btnSale.classList.remove("hidden");
    } else if (currentUser.role === "uploader") {
      nameEl.textContent = "Đào tạo · " + currentUser.name;
      if (dotEl) dotEl.style.background = "#A5B4FC";
      switcher.classList.remove("hidden");
      btnAdmin.classList.add("hidden");
      btnUploader.classList.remove("hidden");
      btnSale.classList.remove("hidden");
    } else {
      nameEl.textContent = "Học Viên · " + currentUser.name;
      if (dotEl) dotEl.style.background = "#4ADE80";
      switcher.classList.add("hidden");
    }

    [
      [btnAdmin, "admin"],
      [btnUploader, "uploader"],
      [btnSale, "sale"]
    ].forEach(([btn, viewName]) => {
      if (btn) {
        btn.classList.toggle("active", activeWorkspaceView === viewName);
        btn.onclick = () => {
          if (viewName !== "sale") impersonatedSaleUser = null;
          activeWorkspaceView = viewName;
          renderAll();
        };
      }
    });

    if (btnToggleSidebar) {
      btnToggleSidebar.classList.toggle("hidden", activeWorkspaceView === "admin");
    }

    const openBugsCount = (db.bugReports || []).filter(b => b.status !== "resolved").length;
    const topBugBadge = document.getElementById("badgeTopBugCount");
    if (topBugBadge) {
      topBugBadge.textContent = String(openBugsCount);
      topBugBadge.classList.toggle("hidden", openBugsCount === 0);
    }
    const upBugBadge = document.getElementById("lblUpBugCount");
    if (upBugBadge) {
      upBugBadge.textContent = String(openBugsCount);
    }
  }

  function renderSidebar() {
    const listEl = document.getElementById("sidebarModulesList");
    if (!listEl) return;

    const isUploaderView = activeWorkspaceView === "uploader";
    const modulesList = isUploaderView ? (db.modules || []) : getVisibleModulesForLearner();
    const learner = getEffectiveLearnerUser();

    const lblTotal = document.getElementById("lblSidebarTotalModules");
    if (lblTotal) lblTotal.textContent = `${modulesList.length} bài`;

    const btnCreateMod = document.getElementById("btnSidebarCreateModule");
    if (btnCreateMod) {
      btnCreateMod.classList.toggle("hidden", !isUploaderView);
    }

    // Learner Overall Progress Card (Compact 1-Line)
    const progBox = document.getElementById("sidebarProgressBox");
    if (progBox) {
      const pubMods = getVisibleModulesForLearner();
      let passedCount = 0;
      pubMods.forEach(m => {
        const p = (db.progress || []).find(pr => pr.userId === learner.id && pr.moduleId === m.id);
        if (p && p.passed) passedCount++;
      });
      const pct = pubMods.length > 0 ? Math.round((passedCount * 100) / pubMods.length) : 0;
      document.getElementById("lblSidebarProgressTitle").textContent =
        isUploaderView ? "Đã duyệt" : "Đã đạt";
      document.getElementById("lblSidebarProgressPct").textContent =
        isUploaderView ? `${pubMods.length}/${(db.modules || []).length} bài` : `${passedCount}/${pubMods.length} bài (${pct}%)`;
      document.getElementById("sidebarProgressBarFill").style.width =
        isUploaderView
          ? `${(db.modules || []).length > 0 ? Math.round((pubMods.length * 100) / (db.modules || []).length) : 100}%`
          : `${pct}%`;
    }

    const q = sidebarSearchQuery.trim().toLowerCase();
    const filtered = modulesList.filter(m => {
      if (!q) return true;
      return (
        (m.code || "").toLowerCase().includes(q) ||
        (m.title || "").toLowerCase().includes(q) ||
        (m.authorName || "").toLowerCase().includes(q)
      );
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="padding:20px 10px;text-align:center;color:#64748B;font-size:12.5px;">Không tìm thấy bài học.</div>`;
      return;
    }

    const showAuthorInSidebar = isUploaderView && currentUser && (currentUser.role === "uploader" || currentUser.role === "admin");

    listEl.innerHTML = "";
    filtered.forEach(mod => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sidebar-lesson-item" + (mod.id === currentModuleId ? " active" : "");

      let statusHtml = "";
      const qCount = Array.isArray(mod.questions) ? mod.questions.length : 0;

      if (isUploaderView) {
        if (mod.status === "pending") {
          statusHtml = `<span class="sidebar-item-status pending">Chờ duyệt</span>`;
        } else if (mod.status === "draft") {
          statusHtml = `<span class="sidebar-item-status draft">Bản nháp</span>`;
        } else {
          statusHtml = `<span class="sidebar-item-status done">Đã duyệt</span>`;
        }
      } else {
        const prog = (db.progress || []).find(p => p.userId === learner.id && p.moduleId === mod.id);
        if (prog && prog.passed) {
          statusHtml = `<span class="sidebar-item-status done">✓ ${prog.bestScore}%</span>`;
        } else if (prog && Array.isArray(prog.attempts) && prog.attempts.length > 0) {
          statusHtml = `<span class="sidebar-item-status failed">${prog.bestScore}%</span>`;
        } else if (prog && prog.docViewed) {
          statusHtml = `<span class="sidebar-item-status reading">Đã đọc</span>`;
        } else {
          statusHtml = `<span class="sidebar-item-status empty">Chưa học</span>`;
        }
      }

      const canEditThis = canCurrentUserEditModule(mod);
      const authorPermTag = (currentUser && currentUser.role === "uploader")
        ? (canEditThis ? `<span style="color:#059669;font-weight:700;">Của bạn</span>` : `<span>Chỉ xem</span>`)
        : `<span>${qCount} câu</span>`;

      const authorLineHtml = showAuthorInSidebar
        ? `<div class="sidebar-author-line"><span>Tác giả: <strong>${escapeHtml(mod.authorName || "Đào tạo")}</strong></span>${authorPermTag}</div>`
        : "";

      btn.innerHTML = `
        <div class="sidebar-item-top">
          <span class="sidebar-item-code">${escapeHtml(mod.code)}</span>
          ${statusHtml}
        </div>
        <div class="sidebar-item-title">${escapeHtml(mod.title)}</div>
        ${authorLineHtml}
      `;

      btn.addEventListener("click", () => {
        if (mod.id === currentModuleId) {
          const sb = document.getElementById("moduleSidebar");
          const bd = document.getElementById("sidebarBackdrop");
          if (sb) sb.classList.remove("open");
          if (bd) bd.classList.add("hidden");
          return;
        }
        if (isExamInProgress) {
          const ok = confirm("Bạn đang trong lượt làm bài trắc nghiệm. Nếu chuyển sang học phần khác, lượt làm bài hiện tại sẽ bị hủy. Bạn có chắc muốn chuyển không?");
          if (!ok) return;
        }
        currentModuleId = mod.id;
        resetActiveQuizState();
        renderAll();
        const sb = document.getElementById("moduleSidebar");
        const bd = document.getElementById("sidebarBackdrop");
        if (sb) sb.classList.remove("open");
        if (bd) bd.classList.add("hidden");
      });

      listEl.appendChild(btn);
    });
  }

  let activeDocStepIndex = 0;
  let activeQuizQuestionIndex = 0;
  let expandedUploaderQuestionIndex = null;

  // Anti-cheat Exam Mode State
  const SECONDS_PER_QUESTION = 40;
  const MAX_ALLOWED_TAB_SWITCHES = 2;
  let isExamInProgress = false;
  let examSecondsRemaining = 0;
  let examTotalSeconds = 0;
  let examTimerInterval = null;
  let examTabSwitchCount = 0;
  let examWarningMsg = "";
  let lastViolationTimestamp = 0;
  let examBroadcastChannel = null;

  try {
    if ("BroadcastChannel" in window) {
      examBroadcastChannel = new BroadcastChannel("novastars_sale_exam_guard");
      examBroadcastChannel.onmessage = (ev) => {
        if (ev.data && ev.data.type === "DOC_OPENED_IN_OTHER_TAB" && isExamInProgress) {
          recordExamTabViolation("Phát hiện mở tài liệu ở một tab trình duyệt khác");
        }
      };
    }
  } catch (e) {}

  function stopExamTimer() {
    if (examTimerInterval) {
      clearInterval(examTimerInterval);
      examTimerInterval = null;
    }
    isExamInProgress = false;
  }

  function resetActiveQuizState() {
    stopExamTimer();
    currentQuizAnswers = {};
    currentQuizSubmittedResult = null;
    activeDocStepIndex = 0;
    activeQuizQuestionIndex = 0;
    expandedUploaderQuestionIndex = null;
    examSecondsRemaining = 0;
    examTabSwitchCount = 0;
    examWarningMsg = "";
  }

  function formatMMSS(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function startExamSession(mod, prog) {
    const qList = Array.isArray(mod.questions) ? mod.questions : [];
    if (qList.length === 0) return;
    stopExamTimer();
    currentQuizAnswers = {};
    currentQuizSubmittedResult = null;
    activeQuizQuestionIndex = 0;
    examTabSwitchCount = 0;
    examWarningMsg = "";
    examTotalSeconds = qList.length * SECONDS_PER_QUESTION;
    examSecondsRemaining = examTotalSeconds;
    isExamInProgress = true;
    logUserActivity("start_exam", "Bắt đầu làm bài trắc nghiệm", `${mod.code}: ${mod.title} (${qList.length} câu)`, mod.code);

    examTimerInterval = setInterval(() => {
      if (!isExamInProgress) return;
      examSecondsRemaining--;
      const timerEl = document.getElementById("lblExamCountdown");
      if (timerEl) {
        timerEl.textContent = `Thời gian còn lại: ${formatMMSS(examSecondsRemaining)}`;
        timerEl.classList.toggle("urgent", examSecondsRemaining <= 60);
      }
      if (examSecondsRemaining <= 0) {
        submitActiveExam(mod, prog, "Hết thời gian làm bài");
      }
    }, 1000);

    renderSaleWorkspace();
  }

  function submitActiveExam(mod, prog, autoReason = "") {
    const qList = Array.isArray(mod.questions) ? mod.questions : [];
    const thresh = Number(mod.passThreshold || 80);
    const timeSpentSec = Math.max(1, examTotalSeconds - examSecondsRemaining);
    stopExamTimer();

    let correctCount = 0;
    qList.forEach(item => {
      if (currentQuizAnswers[item.id] === Number(item.correctIndex)) correctCount++;
    });
    const score = qList.length > 0 ? Math.round((correctCount * 100) / qList.length) : 0;
    const passed = score >= thresh;

    const attemptRecord = {
      id: "att-" + Date.now().toString(36),
      timestamp: new Date().toISOString(),
      score,
      correctCount,
      totalCount: qList.length,
      passed,
      tabSwitches: examTabSwitchCount,
      timeSpentSec,
      note: autoReason || "",
      answers: { ...currentQuizAnswers }
    };

    prog.docViewed = true;
    if (!Array.isArray(prog.attempts)) prog.attempts = [];
    prog.attempts.unshift(attemptRecord);
    prog.bestScore = Math.max(Number(prog.bestScore || 0), score);
    if (passed) prog.passed = true;
    prog.updatedAt = new Date().toISOString();

    currentQuizSubmittedResult = attemptRecord;
    activeQuizQuestionIndex = 0;
    logUserActivity(
      "submit_exam",
      `Nộp bài trắc nghiệm (${passed ? "ĐẠT" : "CHƯA ĐẠT"}: ${score}%)`,
      `Đúng ${correctCount}/${qList.length} câu · Thời gian ${formatMMSS(timeSpentSec)} · Chuyển tab ${examTabSwitchCount} lần`,
      mod.code
    );
    triggerAutoSave(true, false, prog);
    renderSaleWorkspace();
    renderSidebar();
  }

  function recordExamTabViolation(customReason = "") {
    if (!isExamInProgress || activeWorkspaceView !== "sale" || activeSaleTab !== "quiz") return;
    const now = Date.now();
    // Debounce simultaneous blur + visibilitychange within 1.2s
    if (now - lastViolationTimestamp < 1200) return;
    lastViolationTimestamp = now;

    examTabSwitchCount++;
    const mod = getCurrentModule();
    const learner = getEffectiveLearnerUser();
    const prog = mod ? getOrCreateProgress(learner.id, learner.name, mod.id) : null;

    if (examTabSwitchCount > MAX_ALLOWED_TAB_SWITCHES && mod && prog) {
      examWarningMsg = `Bài thi đã bị hệ thống tự động thu do bạn rời màn hình / chuyển tab quá ${MAX_ALLOWED_TAB_SWITCHES} lần (${examTabSwitchCount} lần).`;
      submitActiveExam(mod, prog, `Tự động thu bài (Chuyển tab ${examTabSwitchCount} lần)`);
      return;
    }

    const reasonText = customReason || "Phát hiện rời khỏi màn hình làm bài (chuyển sang tab hoặc cửa sổ khác)";
    examWarningMsg = `Cảnh báo vi phạm (${examTabSwitchCount}/${MAX_ALLOWED_TAB_SWITCHES}): ${reasonText}. Hệ thống đã ghi nhận vào báo cáo của Admin. Nếu quá ${MAX_ALLOWED_TAB_SWITCHES} lần, bài thi sẽ tự động bị thu!`;
    if (mod && prog) {
      renderSaleQuizPanel(mod, prog);
    }
  }

  // Listen for tab switching / window blur during active exam
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isExamInProgress) {
      recordExamTabViolation("Chuyển sang tab trình duyệt khác khi đang làm bài");
    }
  });

  window.addEventListener("blur", () => {
    if (isExamInProgress) {
      recordExamTabViolation("Chuyển ra ngoài cửa sổ làm bài (mở ứng dụng hoặc tài liệu khác)");
    }
  });

  // =========================================================================
  // VIEW A: SALE WORKSPACE (STEP-BY-STEP CARD DOC & 1-BY-1 QUIZ)
  // =========================================================================
  function renderSaleWorkspace() {
    const mod = getCurrentModule();
    if (!mod) return;
    currentModuleId = mod.id;

    const learner = getEffectiveLearnerUser();
    const prog = getOrCreateProgress(learner.id, learner.name, mod.id);
    const qList = Array.isArray(mod.questions) ? mod.questions : [];
    const thresh = Number(mod.passThreshold || 80);

    // Impersonation / Preview Banner
    const impBanner = document.getElementById("impersonationBanner");
    const impText = document.getElementById("lblImpersonationText");
    const btnExitImp = document.getElementById("btnExitImpersonation");
    if (impBanner) {
      if (currentUser && (currentUser.role === "admin" || currentUser.role === "uploader")) {
        impBanner.classList.remove("hidden");
        impText.innerHTML = impersonatedSaleUser
          ? `Đang xem giao diện của Học Viên: <strong>${escapeHtml(impersonatedSaleUser.name)}</strong>`
          : `Đang xem thử giao diện của <strong>Học Viên</strong>`;
        btnExitImp.onclick = () => {
          impersonatedSaleUser = null;
          activeWorkspaceView = currentUser.role === "admin" ? "admin" : "uploader";
          renderAll();
        };
      } else {
        impBanner.classList.add("hidden");
      }
    }

    document.getElementById("saleModCode").textContent = mod.code || "HP";
    document.getElementById("saleModTitle").textContent = mod.title || "";

    const statusArea = document.getElementById("saleModStatusArea");
    if (prog.passed) {
      statusArea.innerHTML = `<span class="sidebar-item-status done" style="font-size:12px;padding:4px 10px;">✓ Đã đạt (${prog.bestScore}%)</span>`;
    } else if (prog.attempts && prog.attempts.length > 0) {
      statusArea.innerHTML = `<span class="sidebar-item-status failed" style="font-size:12px;padding:4px 10px;">Điểm cao nhất: ${prog.bestScore}% (Chuẩn &ge;${thresh}%)</span>`;
    } else {
      statusArea.innerHTML = `<span class="sidebar-item-status empty" style="font-size:12px;padding:4px 10px;">Chuẩn hoàn thành &ge;${thresh}%</span>`;
    }

    const btnTabDoc = document.getElementById("btnSaleTabDoc");
    const btnTabQuiz = document.getElementById("btnSaleTabQuiz");
    const panelDoc = document.getElementById("salePanelDoc");
    const panelQuiz = document.getElementById("salePanelQuiz");

    const docSteps = buildDocumentSteps(mod);
    document.getElementById("lblSaleDocStatus").textContent = isExamInProgress ? "Đã khóa khi đang thi" : `${docSteps.length} mục`;
    document.getElementById("lblSaleQuizStatus").textContent = `${qList.length} câu`;

    btnTabDoc.classList.toggle("active", activeSaleTab === "doc");
    btnTabDoc.classList.toggle("locked-tab", isExamInProgress);
    btnTabDoc.setAttribute("aria-selected", String(activeSaleTab === "doc"));
    btnTabQuiz.classList.toggle("active", activeSaleTab === "quiz");
    btnTabQuiz.setAttribute("aria-selected", String(activeSaleTab === "quiz"));

    panelDoc.classList.toggle("hidden", activeSaleTab !== "doc");
    panelQuiz.classList.toggle("hidden", activeSaleTab !== "quiz");

    btnTabDoc.onclick = () => {
      if (isExamInProgress) {
        const confirmCancel = confirm(
          "Tài liệu đang bị khóa trong thời gian làm bài trắc nghiệm.\n\nNếu bạn quay lại xem tài liệu lúc này, bài làm hiện tại sẽ bị HỦY và phải làm lại từ đầu. Bạn có chắc muốn hủy bài đang làm không?"
        );
        if (!confirmCancel) return;
        resetActiveQuizState();
      }
      activeSaleTab = "doc";
      if (examBroadcastChannel) {
        try { examBroadcastChannel.postMessage({ type: "DOC_OPENED_IN_OTHER_TAB" }); } catch (e) {}
      }
      renderSaleWorkspace();
    };
    btnTabQuiz.onclick = () => {
      if (!prog.docViewed) {
        prog.docViewed = true;
        prog.docViewedAt = new Date().toISOString();
        triggerAutoSave(true, false, prog);
      }
      activeSaleTab = "quiz";
      renderSaleWorkspace();
      renderSidebar();
    };

    if (activeSaleTab === "doc") {
      if (examBroadcastChannel) {
        try { examBroadcastChannel.postMessage({ type: "DOC_OPENED_IN_OTHER_TAB" }); } catch (e) {}
      }
      renderSaleDocumentPanel(mod, prog, docSteps);
    } else {
      renderSaleQuizPanel(mod, prog);
    }
  }

  function formatStudyRichTextHtml(rawText) {
    const raw = String(rawText == null ? "" : rawText).trim();
    if (!raw) return "";
    const lines = raw.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
    return `<div class="stc-rich-list">${lines.map(line => {
      const isSub = /^[+–]\s+/.test(line);
      const colonIdx = line.indexOf(":");
      let innerHtml = "";
      if (colonIdx > 1 && colonIdx < 58) {
        const head = line.slice(0, colonIdx + 1);
        const rest = line.slice(colonIdx + 1);
        innerHtml = `<span class="stc-rich-key">${escapeHtml(head)}</span>${escapeHtml(rest)}`;
      } else {
        innerHtml = escapeHtml(line);
      }
      return `<div class="stc-rich-item ${isSub ? "sub-item" : ""}">${innerHtml}</div>`;
    }).join("")}</div>`;
  }

  function formatTimelineStepsHtml(rawText) {
    const raw = String(rawText == null ? "" : rawText).trim();
    if (!raw) return "";
    const blocks = [];
    const lines = raw.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
    lines.forEach(line => {
      if (/^[•\-]?\s*(?:Hoạt động|Tổng kết|Bước)/i.test(line) || blocks.length === 0) {
        blocks.push([line]);
      } else {
        blocks[blocks.length - 1].push(line);
      }
    });
    return `<div class="stc-timeline-list">${blocks.map(bLines => {
      const firstLine = bLines[0];
      const colonIdx = firstLine.indexOf(":");
      let firstHtml = escapeHtml(firstLine);
      if (colonIdx > 1 && colonIdx < 70) {
        firstHtml = `<span class="stc-rich-key">${escapeHtml(firstLine.slice(0, colonIdx + 1))}</span>${escapeHtml(firstLine.slice(colonIdx + 1))}`;
      }
      const restHtml = bLines.slice(1).map(sub => `<div class="stc-rich-item sub-item">${escapeHtml(sub)}</div>`).join("");
      return `<div class="stc-timeline-step"><div>${firstHtml}</div>${restHtml}</div>`;
    }).join("")}</div>`;
  }

  function getLessonInlineQuestions(mod, stepIdx) {
    if (!mod || !Array.isArray(mod.questions)) return [];
    const matched = mod.questions.filter(q => q.lessonIndex === stepIdx);
    if (matched.length > 0) return matched;
    if (mod.structuredType === "sample_10_lessons" && Array.isArray(mod.structuredData) && mod.structuredData[stepIdx]) {
      const code = String(mod.structuredData[stepIdx].bai_hoc || "").split(/[\s\-]/)[0].trim();
      if (code) {
        return mod.questions.filter(q => q.lessonCode === code || (q.question && q.question.includes(code)));
      }
    }
    return [];
  }

  function buildDocumentSteps(mod) {
    // 1. HP01: 6 Comparison Criteria -> Scannable 3-tier layout
    if (mod.structuredType === "comparison_6_criteria" && Array.isArray(mod.structuredData)) {
      return mod.structuredData.map((item, idx) => ({
        pillLabel: `Mục ${idx + 1}`,
        title: `${item.stt}. ${item.title}`,
        html: `
          <article class="study-topic-card">
            <div class="stc-head">
              <div class="stc-head-left">
                <span class="stc-num">Tiêu chí ${escapeHtml(item.stt)}/6</span>
                <h4 class="stc-title">${escapeHtml(item.title)}</h4>
              </div>
            </div>
            <div class="stc-tier-stack">
              <div class="stc-pitch-spotlight">
                <div class="stc-box-label">Câu chốt nói với Chủ trường / Hiệu trưởng</div>
                <div class="stc-box-content"><strong>"${escapeHtml(item.sale_pitch)}"</strong></div>
              </div>
              <div class="stc-balanced-pair">
                <div class="stc-box traditional">
                  <div class="stc-box-label">Chương trình Bộ GD&amp;ĐT</div>
                  <div class="stc-box-content">${formatStudyRichTextHtml(item.bo_gddt)}</div>
                </div>
                <div class="stc-box novastars">
                  <div class="stc-box-label">Chương trình KNS Novastars</div>
                  <div class="stc-box-content">${formatStudyRichTextHtml(item.novastars)}</div>
                </div>
              </div>
              <div class="stc-box usp">
                <div class="stc-box-label">Điểm khác biệt ăn tiền</div>
                <div class="stc-box-content">${formatStudyRichTextHtml(item.khac_biet_an_tien)}</div>
              </div>
            </div>
          </article>
        `
      }));
    }

    // 2. HP02: 6 Pedagogical Reasons -> Scannable 3-tier layout
    if (mod.structuredType === "pedagogy_6_reasons" && Array.isArray(mod.structuredData)) {
      return mod.structuredData.map((item, idx) => ({
        pillLabel: `Lý do ${idx + 1}`,
        title: `Lý do ${item.stt}: ${item.title}`,
        html: `
          <article class="study-topic-card">
            <div class="stc-head">
              <div class="stc-head-left">
                <span class="stc-num">Lý do ${escapeHtml(item.stt)}/6</span>
                <h4 class="stc-title">${escapeHtml(item.title)}</h4>
              </div>
            </div>
            <div class="stc-tier-stack">
              <div class="stc-pitch-spotlight">
                <div class="stc-box-label">Câu trả lời mẫu thuyết phục Chủ trường / Hiệu trưởng</div>
                <div class="stc-box-content"><strong>"${escapeHtml(item.sale_pitch)}"</strong></div>
              </div>
              <div class="stc-balanced-pair">
                <div class="stc-box traditional">
                  <div class="stc-box-label">Tâm lý trẻ &amp; Cách trường thường dạy</div>
                  <div class="stc-box-content">${formatStudyRichTextHtml(`• Tâm lý trẻ: ${item.tam_ly_tre}\n• Trường thường dạy: ${item.cach_truong_thuong_day}`)}</div>
                </div>
                <div class="stc-box novastars">
                  <div class="stc-box-label">Cách Novastars thiết kế sẵn</div>
                  <div class="stc-box-content">${formatStudyRichTextHtml(item.cach_novastars)}</div>
                </div>
              </div>
            </div>
          </article>
        `
      }));
    }

    // 3. HP03: 10 Sample Lessons -> Scannable 3-Tier Reading Flow (Spotlight Pitch -> Balanced Compare -> Activity Timeline)
    if (mod.structuredType === "sample_10_lessons" && Array.isArray(mod.structuredData)) {
      return mod.structuredData.map((item, idx) => {
        const lessonCode = String(item.bai_hoc || "").split(/[\s\-]/)[0].trim();
        return {
          pillLabel: `Bài ${idx + 1} (${lessonCode})`,
          lessonCode,
          title: `${item.bai_hoc}`,
          html: `
            <article class="study-topic-card">
              <div class="stc-head">
                <div class="stc-head-left">
                  <span class="stc-num">${escapeHtml(item.khoi)}</span>
                  <h4 class="stc-title">${escapeHtml(item.bai_hoc)}</h4>
                </div>
                <div class="stc-badges">
                  <span class="stc-badge">${escapeHtml(item.cong_nghe)}</span>
                  <span class="stc-badge">Thuyết trình: ${escapeHtml(item.co_thuyet_trinh)}</span>
                </div>
              </div>
              <div class="stc-tier-stack">
                <div class="stc-pitch-spotlight">
                  <div class="stc-box-label">Tầng 1 · Điểm ăn tiền để Sale thuyết phục Chủ trường</div>
                  ${formatStudyRichTextHtml(item.diem_an_tien)}
                </div>

                <div class="stc-balanced-pair">
                  <div class="stc-box traditional">
                    <div class="stc-box-label">Tầng 2A · Cách trường thường dạy (${escapeHtml(item.de_tai_quen_thuoc)})</div>
                    ${formatStudyRichTextHtml(item.cach_truong_thuong_day)}
                  </div>
                  <div class="stc-box novastars">
                    <div class="stc-box-label">Tầng 2B · Mục tiêu &amp; Điểm mới của Novastars</div>
                    ${formatStudyRichTextHtml(item.noi_dung_novastars)}
                  </div>
                </div>

                <div class="stc-timeline-card">
                  <div class="stc-box-label" style="color:#C2410C;">Tầng 3 · Tiến trình tổ chức lớp &amp; Thực hành trên lớp</div>
                  ${formatTimelineStepsHtml(item.cach_trien_khai)}
                </div>
              </div>
            </article>
          `
        };
      });
    }

    // 4. HP04: 3 Age Groups + 72x3 Detailed Curriculum Lookup Table -> 4 clean steps
    if (mod.structuredType === "roadmap_72_lessons" && mod.structuredData) {
      const ages = mod.structuredData.ageSummaries || [];
      const list72 = mod.structuredData.curriculum72 || [];
      const steps = ages.map((a, idx) => ({
        pillLabel: idx === 0 ? "1. Khối Bé (3-4t)" : (idx === 1 ? "2. Khối Nhỡ (4-5t)" : "3. Khối Lớn (5-6t)"),
        title: (a.do_tuoi || "").replace(/\n/g, " · "),
        html: `
          <article class="study-topic-card">
            <div class="stc-head">
              <div class="stc-head-left">
                <span class="stc-num">Độ tuổi #${escapeHtml(a.stt)}</span>
                <h4 class="stc-title">${escapeHtml((a.do_tuoi || "").replace(/\n/g, " · "))}</h4>
              </div>
            </div>
            <div class="stc-tier-stack">
              <div class="stc-pitch-spotlight">
                <div class="stc-box-label">Điểm nhấn để Sale nói với Hiệu trưởng</div>
                <div class="stc-box-content"><strong>"${escapeHtml(a.diem_nhan_sale)}"</strong></div>
              </div>
              <div class="stc-balanced-pair">
                <div class="stc-box traditional">
                  <div class="stc-box-label">Nội dung trường vẫn dạy theo khung Bộ</div>
                  ${formatStudyRichTextHtml(a.noi_dung_bo)}
                </div>
                <div class="stc-box novastars">
                  <div class="stc-box-label">Nội dung nâng cấp của Novastars</div>
                  ${formatStudyRichTextHtml(a.noi_dung_novastars)}
                </div>
              </div>
            </div>
          </article>
        `
      }));

      const q = hp04SearchQuery.trim().toLowerCase();
      const filtered72 = list72.filter(row => {
        if (hp04TermFilter !== "ALL" && row.hoc_ki !== hp04TermFilter) return false;
        if (!q) return true;
        return (
          (row.tiet || "").toLowerCase().includes(q) ||
          (row.mg_be || "").toLowerCase().includes(q) ||
          (row.mg_be_nd || "").toLowerCase().includes(q) ||
          (row.mg_nho || "").toLowerCase().includes(q) ||
          (row.mg_nho_nd || "").toLowerCase().includes(q) ||
          (row.mg_lon || "").toLowerCase().includes(q) ||
          (row.mg_lon_nd || "").toLowerCase().includes(q)
        );
      });

      const hk1Count = list72.filter(r => r.hoc_ki === "Học kì I").length;
      const hk2Count = list72.filter(r => r.hoc_ki === "Học kì II").length;

      let tableHeadHtml = "";
      let tableBodyHtml = "";

      if (hp04AgeMode === "ALL") {
        tableHeadHtml = `
          <tr>
            <th style="width:68px;text-align:center;">Tiết</th>
            <th style="width:94px;">Học kì</th>
            <th>Mẫu giáo Bé (3–4t)</th>
            <th>Mẫu giáo Nhỡ (4–5t)</th>
            <th>Mẫu giáo Lớn (5–6t)</th>
            <th style="width:96px;text-align:center;">Nội dung</th>
          </tr>
        `;
        tableBodyHtml = filtered72.map(r => {
          const isExp = String(hp04ExpandedTiet) === String(r.tiet);
          const hasDetails = Boolean(r.mg_be_nd || r.mg_nho_nd || r.mg_lon_nd);
          let htmlRow = `
            <tr data-hp04-row-tiet="${escapeHtml(r.tiet)}" style="cursor:${hasDetails ? 'pointer' : 'default'};${isExp ? 'background:#FFF7ED;' : ''}">
              <td style="text-align:center;font-family:var(--font-mono);font-weight:800;color:#EA580C;">${escapeHtml(r.tiet)}</td>
              <td><span class="mod-cat-pill">${escapeHtml(r.hoc_ki)}</span></td>
              <td><strong>${escapeHtml(r.mg_be)}</strong></td>
              <td><strong>${escapeHtml(r.mg_nho)}</strong></td>
              <td><strong>${escapeHtml(r.mg_lon)}</strong></td>
              <td style="text-align:center;">
                ${hasDetails ? `<button type="button" class="btn-row-act ${isExp ? 'save' : ''}" data-hp04-toggle-tiet="${escapeHtml(r.tiet)}">${isExp ? "Thu gọn" : "Xem ND"}</button>` : "—"}
              </td>
            </tr>
          `;
          if (isExp && hasDetails) {
            htmlRow += `
              <tr>
                <td colspan="6" class="hp04-detail-drawer">
                  <div class="hp04-drawer-grid">
                    <div class="hp04-drawer-col">
                      <h5>Khối Bé (3–4t): ${escapeHtml(r.mg_be)}</h5>
                      <p>${escapeHtml(r.mg_be_nd || "Đang cập nhật...")}</p>
                    </div>
                    <div class="hp04-drawer-col">
                      <h5>Khối Nhỡ (4–5t): ${escapeHtml(r.mg_nho)}</h5>
                      <p>${escapeHtml(r.mg_nho_nd || "Đang cập nhật...")}</p>
                    </div>
                    <div class="hp04-drawer-col">
                      <h5>Khối Lớn (5–6t): ${escapeHtml(r.mg_lon)}</h5>
                      <p>${escapeHtml(r.mg_lon_nd || "Đang cập nhật...")}</p>
                    </div>
                  </div>
                </td>
              </tr>
            `;
          }
          return htmlRow;
        }).join("");
      } else {
        const titleKey = hp04AgeMode === "BE" ? "mg_be" : (hp04AgeMode === "NHO" ? "mg_nho" : "mg_lon");
        const ndKey = hp04AgeMode === "BE" ? "mg_be_nd" : (hp04AgeMode === "NHO" ? "mg_nho_nd" : "mg_lon_nd");
        const ageLabel = hp04AgeMode === "BE" ? "Khối Mẫu giáo Bé (3–4 tuổi)" : (hp04AgeMode === "NHO" ? "Khối Mẫu giáo Nhỡ (4–5 tuổi)" : "Khối Mẫu giáo Lớn (5–6 tuổi)");
        tableHeadHtml = `
          <tr>
            <th style="width:70px;text-align:center;">Tiết</th>
            <th style="width:98px;">Học kì</th>
            <th style="width:260px;">Tên bài học (${escapeHtml(ageLabel)})</th>
            <th>Nội dung mục tiêu &amp; Kỹ năng thực hành của trẻ</th>
          </tr>
        `;
        tableBodyHtml = filtered72.map(r => `
          <tr>
            <td style="text-align:center;font-family:var(--font-mono);font-weight:800;color:#EA580C;">${escapeHtml(r.tiet)}</td>
            <td><span class="mod-cat-pill">${escapeHtml(r.hoc_ki)}</span></td>
            <td><strong>${escapeHtml(r[titleKey] || "")}</strong></td>
            <td class="doc-multiline-cell">${escapeHtml(r[ndKey] || "—")}</td>
          </tr>
        `).join("");
      }

      steps.push({
        pillLabel: `4. Tra cứu ${list72.length} tiết`,
        title: `Danh sách trọn vẹn ${list72.length} tiết × 3 khối (216 bài chi tiết)`,
        html: `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
            <div class="study-filter-pills">
              <button type="button" class="study-filter-pill ${hp04AgeMode === 'ALL' ? 'active' : ''}" data-hp04-age="ALL">So sánh 3 khối</button>
              <button type="button" class="study-filter-pill ${hp04AgeMode === 'BE' ? 'active' : ''}" data-hp04-age="BE">Khối Bé (3–4t)</button>
              <button type="button" class="study-filter-pill ${hp04AgeMode === 'NHO' ? 'active' : ''}" data-hp04-age="NHO">Khối Nhỡ (4–5t)</button>
              <button type="button" class="study-filter-pill ${hp04AgeMode === 'LON' ? 'active' : ''}" data-hp04-age="LON">Khối Lớn (5–6t)</button>
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <input type="text" id="inputHp04Search" class="input-control" style="width:230px;padding:6px 10px;font-size:12.8px;" placeholder="Tìm tên bài hoặc nội dung..." value="${escapeHtml(hp04SearchQuery)}">
              <button type="button" class="study-filter-pill ${hp04TermFilter === 'ALL' ? 'active' : ''}" data-hp04-term="ALL">Cả năm (${list72.length})</button>
              <button type="button" class="study-filter-pill ${hp04TermFilter === 'Học kì I' ? 'active' : ''}" data-hp04-term="Học kì I">HK I (${hk1Count})</button>
              <button type="button" class="study-filter-pill ${hp04TermFilter === 'Học kì II' ? 'active' : ''}" data-hp04-term="Học kì II">HK II (${hk2Count})</button>
            </div>
          </div>
          <div class="table-responsive" style="max-height:490px;overflow-y:auto;">
            <table class="progress-matrix-table">
              <thead>${tableHeadHtml}</thead>
              <tbody>${tableBodyHtml || `<tr><td colspan="6" style="text-align:center;padding:24px;color:#64748B;">Không tìm thấy tiết học khớp từ khóa.</td></tr>`}</tbody>
            </table>
          </div>
        `
      });
      return steps;
    }

    // 5. Uploaded Tables or Plain Text -> Split into clean steps with proper line breaks for each item
    function formatMultilineCellHtml(rawVal) {
      let str = String(rawVal == null ? "" : rawVal).trim();
      if (!str) return "";
      str = str
        .replace(/\r\n/g, "\n")
        .replace(/([^\n])\s*([•●▪✦➢])/g, "$1\n$2")
        .replace(/([^\n])\s+(\*\s+\S)/g, "$1\n$2")
        .replace(/([.;!?])\s+(-\s+)/g, "$1\n$2")
        .replace(/([^\n])\s+((?:\d+\.)\s+(?:Phân tích|Mục đích|Kiến thức|Kĩ năng))/g, "$1\n$2");
      const lines = str.split(/\n+/).map(l => l.trim()).filter(Boolean);
      if (lines.length <= 1) return escapeHtml(str);
      return lines.map(l => `<span class="doc-line-block">${escapeHtml(l)}</span>`).join("");
    }

    const customSteps = [];
    if (Array.isArray(mod.uploadedTables) && mod.uploadedTables.length > 0) {
      mod.uploadedTables.forEach((tbl, tIdx) => {
        const rows = tbl.rows || [];
        if (rows.length === 0) return;
        const maxCols = rows.reduce((mx, r) => Math.max(mx, Array.isArray(r) ? r.length : 0), 1);

        // Find the header row (first row with >= 2 non-empty cells or starting with STT)
        let headerIdx = -1;
        for (let r = 0; r < Math.min(rows.length, 6); r++) {
          const nonEmpty = (rows[r] || []).filter(c => String(c || "").trim().length > 0);
          if (nonEmpty.length >= 2) {
            headerIdx = r;
            break;
          }
        }

        const trs = rows.map((r, rIdx) => {
          const nonEmpty = (r || []).map(c => String(c || "").trim()).filter(Boolean);
          if (nonEmpty.length === 0) return "";
          if (nonEmpty.length === 1 && maxCols > 1 && rIdx < (headerIdx === -1 ? 3 : headerIdx)) {
            return `<tr><td colspan="${maxCols}" class="doc-table-banner-row">${formatMultilineCellHtml(nonEmpty[0])}</td></tr>`;
          }
          const isHeader = rIdx === headerIdx || (headerIdx === -1 && rIdx === 0);
          const tag = isHeader ? "th" : "td";
          const cellClass = isHeader ? "" : ' class="doc-multiline-cell"';
          const cells = r.map(c => `<${tag}${cellClass}>${formatMultilineCellHtml(c)}</${tag}>`).join("");
          return `<tr>${cells}</tr>`;
        }).join("");

        const sheetTitle = tbl.sheet || `Bảng dữ liệu ${tIdx + 1}`;
        customSteps.push({
          pillLabel: `${tIdx + 1}. ${sheetTitle}`,
          title: sheetTitle,
          html: `<div class="table-responsive" style="max-height:520px;overflow-y:auto;"><table class="progress-matrix-table">${trs}</table></div>`
        });
      });
    }

    const rawText = (mod.contentText || "").trim();
    if (rawText && customSteps.length === 0) {
      const normalizedRaw = rawText
        .replace(/\r\n/g, "\n")
        .replace(/([^\n])\s*([•●▪✦➢])/g, "$1\n$2");
      const lines = normalizedRaw.split(/\n+/).map(l => l.trim()).filter(Boolean);
      const chunkSize = 8;
      for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize);
        const stepNum = Math.floor(i / chunkSize) + 1;
        customSteps.push({
          pillLabel: `Phần ${stepNum}`,
          title: `Nội dung phần ${stepNum}`,
          html: `<div style="display:flex;flex-direction:column;gap:10px;">${chunk.map(p => `<p style="font-size:14.2px;line-height:1.68;white-space:pre-line;">${formatMultilineCellHtml(p)}</p>`).join("")}</div>`
        });
      }
    }

    if (customSteps.length === 0) {
      customSteps.push({
        pillLabel: "Phần 1",
        title: mod.title || "Tài liệu học tập",
        html: `<p style="color:#64748B;font-size:13.5px;">Chưa có nội dung tài liệu. Đào tạo có thể tải file hoặc dán nội dung ở mục Đào tạo.</p>`
      });
    }
    return customSteps;
  }

  function renderSaleDocumentPanel(mod, prog, docSteps) {
    const steps = docSteps || buildDocumentSteps(mod);
    if (activeDocStepIndex >= steps.length) activeDocStepIndex = 0;
    if (activeDocStepIndex < 0) activeDocStepIndex = 0;

    const currentStep = steps[activeDocStepIndex];
    const bodyContainer = document.getElementById("saleDocBodyContainer");
    const letters = ["A", "B", "C", "D"];

    const pillsHtml = steps.map((st, idx) => {
      const lessonQs = getLessonInlineQuestions(mod, idx);
      const isLessonMiniDone = lessonQs.length > 0 && lessonQs.every(q => inlineMiniQuizAnswers[q.id] === Number(q.correctIndex));
      return `
        <button type="button" class="doc-step-pill ${idx === activeDocStepIndex ? 'active' : ''} ${isLessonMiniDone ? 'mini-done' : ''}" data-doc-step="${idx}">
          ${isLessonMiniDone ? "✓ " : ""}${escapeHtml(st.pillLabel)}
        </button>
      `;
    }).join("");

    const downloadBtnHtml = (mod.sourceFile && mod.sourceFile.url)
      ? `<a href="${escapeHtml(mod.sourceFile.url)}" download="${escapeHtml(mod.sourceFile.name || 'Tai_lieu.xlsx')}" class="btn-download-source">Tải file gốc</a>`
      : "";

    const lessonQs = getLessonInlineQuestions(mod, activeDocStepIndex);
    let inlineQuizHtml = "";
    if (lessonQs.length > 0) {
      const answeredMini = lessonQs.filter(q => inlineMiniQuizAnswers[q.id] !== undefined).length;
      const rightMini = lessonQs.filter(q => inlineMiniQuizAnswers[q.id] === Number(q.correctIndex)).length;
      const qCardsHtml = lessonQs.map((q, qIdx) => {
        const chosen = inlineMiniQuizAnswers[q.id];
        const hasChosen = chosen !== undefined;
        const isRight = hasChosen && chosen === Number(q.correctIndex);
        const optsHtml = (q.options || []).map((optText, oIdx) => {
          let cls = "lmq-opt-btn";
          if (hasChosen) {
            if (oIdx === Number(q.correctIndex)) cls += " right";
            else if (chosen === oIdx) cls += " wrong";
          }
          return `
            <button type="button" class="${cls}" data-mini-q="${escapeHtml(q.id)}" data-mini-opt="${oIdx}">
              <span class="qq-opt-letter">${letters[oIdx] || oIdx + 1}</span>
              <span>${escapeHtml(optText)}</span>
            </button>
          `;
        }).join("");

        return `
          <div class="lmq-q-item">
            <div style="font-size:13.8px;font-weight:700;color:#0F172A;line-height:1.45;">
              <span class="qq-num-badge" style="margin-right:6px;">Câu ${qIdx + 1}/${lessonQs.length}</span>
              ${escapeHtml(q.question)}
            </div>
            <div class="lmq-opt-grid">${optsHtml}</div>
            ${hasChosen ? `
              <div class="lmq-feedback ${isRight ? "right" : "wrong"}">
                <strong>${isRight ? "✓ Chính xác!" : `✕ Chưa đúng (Đáp án chuẩn là ${letters[q.correctIndex]}).`}</strong>
                ${escapeHtml(q.explanation || "")}
              </div>
            ` : ""}
          </div>
        `;
      }).join("");

      inlineQuizHtml = `
        <section class="lesson-mini-quiz-box" aria-label="Trắc nghiệm kiểm tra nhanh theo bài">
          <div class="lmq-head">
            <div>
              <div class="lmq-title">Kiểm tra nhanh ngay sau khi đọc ${escapeHtml(currentStep.pillLabel)} (${lessonQs.length} câu)</div>
              <div style="font-size:12.2px;color:#64748B;">Học bài nào ôn chắc bài đó trước khi sang bài tiếp theo. Đã đúng: <strong style="color:#059669;">${rightMini}/${lessonQs.length}</strong> (đã trả lời ${answeredMini}/${lessonQs.length}).</div>
            </div>
            ${answeredMini > 0 ? `<button type="button" class="btn-row-act" id="btnResetMiniQuizStep">Làm lại ${lessonQs.length} câu này</button>` : ""}
          </div>
          ${qCardsHtml}
        </section>
      `;
    }

    const isLastStep = activeDocStepIndex === steps.length - 1;

    bodyContainer.innerHTML = `
      <div class="doc-stepper-bar">
        <div class="doc-step-pills">${pillsHtml}</div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          ${downloadBtnHtml}
          <button type="button" class="btn-inline-report-bug" id="btnReportDocStepBug">
            Báo lỗi mục này
          </button>
        </div>
      </div>

      <div class="doc-active-step-body">
        ${currentStep.html}
        ${inlineQuizHtml}
      </div>

      <div class="doc-pager-footer">
        <button type="button" class="btn-secondary" id="btnDocPrevStep" ${activeDocStepIndex === 0 ? "disabled" : ""}>
          ◀ Mục trước
        </button>
        <span class="doc-pager-counter">Mục ${activeDocStepIndex + 1} / ${steps.length}</span>
        ${!isLastStep
          ? `<button type="button" class="btn-primary" id="btnDocNextStep">Mục tiếp theo ▶</button>`
          : `<button type="button" class="btn-start-quiz-cta" id="btnDocStartQuiz">Làm bài Trắc nghiệm tổng hợp (${(mod.questions || []).length} câu) ➔</button>`
        }
      </div>
    `;

    const btnRepDoc = document.getElementById("btnReportDocStepBug");
    if (btnRepDoc) {
      btnRepDoc.onclick = () => {
        openBugReportModal({
          targetContext: `${mod.code} — Tài liệu (${currentStep.pillLabel}: ${currentStep.title || mod.title})`,
          category: "Lỗi nội dung tài liệu học",
          moduleId: mod.id,
          moduleCode: mod.code,
          moduleTitle: mod.title,
          questionIndex: null
        });
      };
    }

    bodyContainer.querySelectorAll("[data-doc-step]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeDocStepIndex = Number(btn.dataset.docStep);
        sendPresenceHeartbeat();
        renderSaleDocumentPanel(mod, prog, steps);
      });
    });

    bodyContainer.querySelectorAll("[data-mini-q]").forEach(btn => {
      btn.addEventListener("click", () => {
        inlineMiniQuizAnswers[btn.dataset.miniQ] = Number(btn.dataset.miniOpt);
        renderSaleDocumentPanel(mod, prog);
      });
    });

    const btnResetMini = document.getElementById("btnResetMiniQuizStep");
    if (btnResetMini) {
      btnResetMini.onclick = () => {
        lessonQs.forEach(q => delete inlineMiniQuizAnswers[q.id]);
        renderSaleDocumentPanel(mod, prog);
      };
    }

    const btnPrev = document.getElementById("btnDocPrevStep");
    if (btnPrev) {
      btnPrev.onclick = () => {
        if (activeDocStepIndex > 0) {
          activeDocStepIndex--;
          renderSaleDocumentPanel(mod, prog, steps);
        }
      };
    }

    const btnNext = document.getElementById("btnDocNextStep");
    if (btnNext) {
      btnNext.onclick = () => {
        if (activeDocStepIndex < steps.length - 1) {
          activeDocStepIndex++;
          renderSaleDocumentPanel(mod, prog, steps);
        }
      };
    }

    const btnStartQuiz = document.getElementById("btnDocStartQuiz");
    if (btnStartQuiz) {
      btnStartQuiz.onclick = () => {
        prog.docViewed = true;
        prog.docViewedAt = new Date().toISOString();
        prog.updatedAt = new Date().toISOString();
        triggerAutoSave(true, false, prog);
        activeSaleTab = "quiz";
        activeQuizQuestionIndex = 0;
        renderSaleWorkspace();
        renderSidebar();
      };
    }

    // Bind HP04 4-age-mode, HK I/II filter, row detail toggle & search
    bodyContainer.querySelectorAll("[data-hp04-age]").forEach(btn => {
      btn.addEventListener("click", () => {
        hp04AgeMode = btn.dataset.hp04Age;
        renderSaleDocumentPanel(mod, prog);
      });
    });

    bodyContainer.querySelectorAll("[data-hp04-row-tiet]").forEach(tr => {
      tr.addEventListener("click", () => {
        const t = tr.dataset.hp04RowTiet;
        hp04ExpandedTiet = (String(hp04ExpandedTiet) === String(t)) ? "" : t;
        renderSaleDocumentPanel(mod, prog);
      });
    });

    bodyContainer.querySelectorAll("[data-hp04-term]").forEach(btn => {
      btn.addEventListener("click", () => {
        hp04TermFilter = btn.dataset.hp04Term;
        renderSaleDocumentPanel(mod, prog);
      });
    });

    const inpHp04 = bodyContainer.querySelector("#inputHp04Search");
    if (inpHp04) {
      inpHp04.addEventListener("input", e => {
        hp04SearchQuery = e.target.value;
        renderSaleDocumentPanel(mod, prog);
        const newInp = document.getElementById("inputHp04Search");
        if (newInp) {
          newInp.focus();
          newInp.setSelectionRange(newInp.value.length, newInp.value.length);
        }
      });
    }
  }

  function renderSaleQuizPanel(mod, prog) {
    const qList = Array.isArray(mod.questions) ? mod.questions : [];
    const thresh = Number(mod.passThreshold || 80);
    const resultBanner = document.getElementById("saleQuizResultBanner");
    const stageContainer = document.getElementById("saleQuizQuestionsList");

    if (qList.length === 0) {
      resultBanner.classList.add("hidden");
      stageContainer.innerHTML = `<div style="padding:24px;text-align:center;color:#64748B;">Học phần này chưa có câu hỏi trắc nghiệm.</div>`;
      return;
    }

    const isSubmitted = Boolean(currentQuizSubmittedResult);

    // State 1: Neither started exam nor submitted yet -> Show Exam Rules & Start Button
    if (!isExamInProgress && !isSubmitted) {
      resultBanner.classList.add("hidden");
      const totalTimeStr = formatMMSS(qList.length * SECONDS_PER_QUESTION);
      const attCnt = Array.isArray(prog.attempts) ? prog.attempts.length : 0;
      stageContainer.innerHTML = `
        <div class="exam-start-card">
          <div>
            <h3 style="font-family:var(--font-display);font-size:18px;font-weight:800;color:#0F172A;margin-bottom:4px;">
              Bài kiểm tra trắc nghiệm: ${escapeHtml(mod.title)}
            </h3>
            <p style="font-size:13px;color:#64748B;">
              Số lượng: <strong>${qList.length} câu hỏi</strong> · Thời gian làm bài: <strong>${totalTimeStr} phút</strong> (${SECONDS_PER_QUESTION} giây/câu) · Điểm đạt: <strong>&ge; ${thresh}%</strong>
              ${attCnt > 0 ? ` · Điểm cao nhất hiện tại: <strong>${prog.bestScore}%</strong>` : ""}
            </p>
          </div>

          <ul class="exam-rules-list">
            <li><strong>Khóa tài liệu khi làm bài:</strong> Ngay khi bấm bắt đầu, mục <em>Xem Tài liệu</em> sẽ bị khóa. Nếu thoát ra mở lại tài liệu, bài đang làm sẽ bị hủy.</li>
            <li><strong>Giới hạn thời gian đếm ngược:</strong> Đồng hồ đếm ngược <strong>${totalTimeStr}</strong>. Hết giờ hệ thống sẽ tự động thu bài và chấm điểm.</li>
            <li><strong>Chống chuyển tab / mở tài liệu khác:</strong> Hệ thống tự động phát hiện khi bạn chuyển sang tab khác hoặc mở cửa sổ ứng dụng khác trên máy. Mọi lần chuyển tab đều được ghi nhận báo cáo cho Admin và bài thi sẽ tự động bị thu nếu rời màn hình quá ${MAX_ALLOWED_TAB_SWITCHES} lần.</li>
          </ul>

          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <button type="button" class="btn-secondary" id="btnExamBackToDoc">
              ← Ôn lại tài liệu trước khi thi
            </button>
            <button type="button" class="btn-submit-quiz" id="btnStartExamNow">
              Bắt đầu làm bài (${totalTimeStr})
            </button>
          </div>
        </div>
      `;

      document.getElementById("btnExamBackToDoc").onclick = () => {
        activeSaleTab = "doc";
        renderSaleWorkspace();
      };
      document.getElementById("btnStartExamNow").onclick = () => {
        startExamSession(mod, prog);
      };
      return;
    }

    if (activeQuizQuestionIndex >= qList.length) activeQuizQuestionIndex = 0;
    if (activeQuizQuestionIndex < 0) activeQuizQuestionIndex = 0;

    if (isSubmitted) {
      const res = currentQuizSubmittedResult;
      resultBanner.classList.remove("hidden", "passed", "failed");
      resultBanner.classList.add(res.passed ? "passed" : "failed");
      const tabNote = res.tabSwitches > 0 ? ` · Chuyển tab/cửa sổ: ${res.tabSwitches} lần` : " · Nghiêm túc (0 lần chuyển tab)";
      const autoNote = res.note ? ` (${escapeHtml(res.note)})` : "";
      resultBanner.innerHTML = `
        <div class="qrb-left">
          <div class="qrb-score-circle">${res.score}%</div>
          <div class="qrb-text">
            <h3>${res.passed ? "ĐẠT YÊU CẦU!" : "CHƯA ĐẠT — HÃY ÔN LẠI TÀI LIỆU & LÀM LẠI"}${autoNote}</h3>
            <p>Đúng <strong>${res.correctCount}/${res.totalCount} câu</strong> (Chuẩn cần đạt &ge; ${thresh}%)${escapeHtml(tabNote)}. Bấm vào từng số câu bên dưới để xem lại bài làm.</p>
          </div>
        </div>
        <button type="button" class="btn-primary" id="btnRetakeQuizBanner">
          Làm lại bài mới
        </button>
      `;
      document.getElementById("btnRetakeQuizBanner").onclick = () => {
        startExamSession(mod, prog);
      };
    } else {
      resultBanner.classList.add("hidden");
    }

    const answeredCount = qList.filter(q => currentQuizAnswers[q.id] !== undefined).length;
    const letters = ["A", "B", "C", "D"];

    const numPillsHtml = qList.map((item, idx) => {
      const hasAns = currentQuizAnswers[item.id] !== undefined;
      let cls = "q-num-pill";
      if (idx === activeQuizQuestionIndex) cls += " active";
      if (isSubmitted) {
        const right = currentQuizAnswers[item.id] === Number(item.correctIndex);
        cls += right ? " graded-ok" : " graded-err";
      } else if (hasAns) {
        cls += " answered";
      }
      return `<button type="button" class="${cls}" data-goto-q="${idx}">${idx + 1}</button>`;
    }).join("");

    const q = qList[activeQuizQuestionIndex];
    const selectedIdx = currentQuizAnswers[q.id];
    const isCorrect = isSubmitted && selectedIdx === Number(q.correctIndex);
    const catKey = q.category || "kien_thuc";
    const catLabel = q.categoryLabel || getCategoryLabel(catKey);

    const optsHtml = (q.options || []).map((optText, oIdx) => {
      const isSel = selectedIdx === oIdx;
      let optClass = "qq-option-btn";
      if (isSubmitted) {
        if (oIdx === Number(q.correctIndex)) {
          optClass += " correct-answer";
        } else if (isSel && oIdx !== Number(q.correctIndex)) {
          optClass += " wrong-selected";
        }
      } else if (isSel) {
        optClass += " selected";
      }

      return `
        <button type="button" class="${optClass}" data-opt-idx="${oIdx}" ${isSubmitted ? "disabled" : ""}>
          <span class="qq-opt-letter">${letters[oIdx] || oIdx + 1}</span>
          <span>${escapeHtml(optText)}</span>
        </button>
      `;
    }).join("");

    let explanationHtml = "";
    if (isSubmitted) {
      const statusTag = isCorrect
        ? `<span style="color:#059669;font-weight:800;">✓ ĐÚNG (Đáp án ${letters[q.correctIndex]})</span>`
        : `<span style="color:#DC2626;font-weight:800;">✕ Bạn chọn ${selectedIdx !== undefined ? letters[selectedIdx] : "Chưa chọn"} — Đáp án đúng là ${letters[q.correctIndex]}</span>`;
      explanationHtml = `
        <div class="qq-explanation-box">
          <div style="margin-bottom:4px;">${statusTag}</div>
          <div><strong>Giải thích:</strong> ${escapeHtml(q.explanation || "")}</div>
        </div>
      `;
    }

    const isLastQ = activeQuizQuestionIndex === qList.length - 1;

    const hudHtml = !isSubmitted ? `
      <div class="exam-hud-bar">
        <span class="exam-timer-pill ${examSecondsRemaining <= 60 ? 'urgent' : ''}" id="lblExamCountdown">
          Thời gian còn lại: ${formatMMSS(examSecondsRemaining)}
        </span>
        <span class="exam-violation-pill ${examTabSwitchCount > 0 ? 'warn' : ''}">
          Chuyển tab / Rời màn hình: ${examTabSwitchCount}/${MAX_ALLOWED_TAB_SWITCHES} lần
        </span>
      </div>
      ${examWarningMsg ? `<div class="exam-warning-toast">${escapeHtml(examWarningMsg)}</div>` : ""}
    ` : "";

    stageContainer.innerHTML = `
      ${hudHtml}

      <div class="quiz-num-strip-bar">
        <div class="quiz-num-pills">${numPillsHtml}</div>
        <span style="font-size:12.5px;font-weight:700;color:#64748B;">
          Đã chọn: <strong style="color:#EA580C;">${answeredCount}/${qList.length}</strong> câu
        </span>
      </div>

      <div class="qq-head">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="qq-num-badge">Câu ${activeQuizQuestionIndex + 1} / ${qList.length}</span>
          <span class="qq-cat-badge ${escapeHtml(catKey)}">${escapeHtml(catLabel)}</span>
        </div>
        <button type="button" class="btn-inline-report-bug" id="btnReportCurrentQuestionBug">
          Báo lỗi câu này
        </button>
      </div>

      <div class="qq-question-text">${escapeHtml(q.question)}</div>
      <div class="qq-options-list">${optsHtml}</div>
      ${explanationHtml}

      <div class="single-q-nav-bar">
        <button type="button" class="btn-secondary" id="btnPrevQuizQ" ${activeQuizQuestionIndex === 0 ? "disabled" : ""}>
          ◀ Câu trước
        </button>

        <div style="display:flex;gap:8px;align-items:center;">
          ${!isLastQ
            ? `<button type="button" class="btn-secondary" id="btnNextQuizQ">Câu tiếp theo ▶</button>`
            : ""
          }
          ${!isSubmitted && (isLastQ || answeredCount === qList.length)
            ? `<button type="button" class="btn-submit-quiz" id="btnSubmitSaleQuiz">Nộp bài &amp; Chấm điểm</button>`
            : ""
          }
        </div>
      </div>
    `;

    const btnRepQ = document.getElementById("btnReportCurrentQuestionBug");
    if (btnRepQ) {
      btnRepQ.onclick = () => {
        openBugReportModal({
          targetContext: `${mod.code} — Câu hỏi ${activeQuizQuestionIndex + 1}: ${(q.question || "").slice(0, 70)}`,
          category: "Sai đáp án / Câu hỏi trắc nghiệm",
          moduleId: mod.id,
          moduleCode: mod.code,
          moduleTitle: mod.title,
          questionId: q.id,
          questionIndex: activeQuizQuestionIndex
        });
      };
    }

    stageContainer.querySelectorAll("[data-goto-q]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeQuizQuestionIndex = Number(btn.dataset.gotoQ);
        renderSaleQuizPanel(mod, prog);
      });
    });

    stageContainer.querySelectorAll("[data-opt-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (currentQuizSubmittedResult) return;
        currentQuizAnswers[q.id] = Number(btn.dataset.optIdx);
        renderSaleQuizPanel(mod, prog);
        if (activeQuizQuestionIndex < qList.length - 1) {
          setTimeout(() => {
            if (!currentQuizSubmittedResult && activeSaleTab === "quiz" && isExamInProgress) {
              activeQuizQuestionIndex++;
              renderSaleQuizPanel(mod, prog);
            }
          }, 260);
        }
      });
    });

    const btnPrevQ = document.getElementById("btnPrevQuizQ");
    if (btnPrevQ) {
      btnPrevQ.onclick = () => {
        if (activeQuizQuestionIndex > 0) {
          activeQuizQuestionIndex--;
          renderSaleQuizPanel(mod, prog);
        }
      };
    }

    const btnNextQ = document.getElementById("btnNextQuizQ");
    if (btnNextQ) {
      btnNextQ.onclick = () => {
        if (activeQuizQuestionIndex < qList.length - 1) {
          activeQuizQuestionIndex++;
          renderSaleQuizPanel(mod, prog);
        }
      };
    }

    const btnSubmit = document.getElementById("btnSubmitSaleQuiz");
    if (btnSubmit) {
      btnSubmit.onclick = () => {
        const curAnswered = qList.filter(item => currentQuizAnswers[item.id] !== undefined).length;
        if (curAnswered < qList.length) {
          const ok = confirm(`Bạn mới chọn ${curAnswered}/${qList.length} câu. Nộp bài ngay?`);
          if (!ok) return;
        }
        submitActiveExam(mod, prog, "");
      };
    }
  }

  // =========================================================================
  // VIEW B: ĐÀO TẠO WORKSPACE (COMPACT & STREAMLINED)
  // =========================================================================
  function renderUploaderWorkspace() {
    const mod = getCurrentModule();
    if (!mod) return;
    currentModuleId = mod.id;

    const qList = Array.isArray(mod.questions) ? mod.questions : [];
    document.getElementById("lblUpQuestionCount").textContent = String(qList.length);

    const btnTabDoc = document.getElementById("btnUpTabDoc");
    const btnTabQuiz = document.getElementById("btnUpTabQuiz");
    const btnTabBugs = document.getElementById("btnUpTabBugs");
    const panelDoc = document.getElementById("uploaderPanelDoc");
    const panelQuiz = document.getElementById("uploaderPanelQuiz");
    const panelBugs = document.getElementById("uploaderPanelBugs");

    btnTabDoc.classList.toggle("active", activeUploaderTab === "doc");
    btnTabQuiz.classList.toggle("active", activeUploaderTab === "quiz");
    if (btnTabBugs) btnTabBugs.classList.toggle("active", activeUploaderTab === "bugs");
    panelDoc.classList.toggle("hidden", activeUploaderTab !== "doc");
    panelQuiz.classList.toggle("hidden", activeUploaderTab !== "quiz");
    if (panelBugs) panelBugs.classList.toggle("hidden", activeUploaderTab !== "bugs");

    btnTabDoc.onclick = () => {
      activeUploaderTab = "doc";
      sendPresenceHeartbeat();
      renderUploaderWorkspace();
    };
    btnTabQuiz.onclick = () => {
      syncUploaderDocFieldsToModule(mod);
      activeUploaderTab = "quiz";
      sendPresenceHeartbeat();
      renderUploaderWorkspace();
    };
    if (btnTabBugs) {
      btnTabBugs.onclick = () => {
        syncUploaderDocFieldsToModule(mod);
        activeUploaderTab = "bugs";
        sendPresenceHeartbeat();
        renderUploaderWorkspace();
      };
    }
    if (activeUploaderTab === "bugs") {
      renderBugReportsPanelInto("uploaderBugsContainer");
    }

    const canEdit = canCurrentUserEditModule(mod);

    const roBanner = document.getElementById("upReadOnlyNoticeBanner");
    const roAuthor = document.getElementById("lblReadOnlyBannerAuthor");
    if (roBanner) roBanner.classList.toggle("hidden", canEdit);
    if (roAuthor) roAuthor.textContent = mod.authorName || "Quản trị viên";

    document.getElementById("upModStatus").value = mod.status || "published";
    document.getElementById("upModStatus").disabled = !canEdit;
    document.getElementById("upModCode").value = mod.code || "HP";
    document.getElementById("upModCategory").value = mod.category || "Tài liệu Đào tạo";
    document.getElementById("upModDuration").value = mod.durationMinutes || 20;
    document.getElementById("upModThreshold").value = mod.passThreshold || 80;
    document.getElementById("upModTitle").value = mod.title || "";
    document.getElementById("upModTitle").readOnly = !canEdit;
    document.getElementById("upModSubtitle").value = mod.subtitle || "";
    document.getElementById("upModSummaryPoints").value = (mod.summaryPoints || []).join("\n");
    const lblAuthor = document.getElementById("lblUploaderModuleAuthor");
    if (lblAuthor) {
      lblAuthor.textContent = `Tác giả: ${mod.authorName || "Đào tạo"}${canEdit ? " (Có quyền chỉnh sửa)" : " (Chỉ xem)"}`;
    }

    const btnDelMod = document.getElementById("btnUploaderDeleteModule");
    const btnSaveMod = document.getElementById("btnUploaderSaveModule");
    const btnSubApp = document.getElementById("btnUploaderSubmitForApproval");
    if (btnDelMod) btnDelMod.classList.toggle("hidden", !canEdit);
    if (btnSaveMod) btnSaveMod.classList.toggle("hidden", !canEdit);
    if (btnSubApp) btnSubApp.classList.toggle("hidden", !canEdit);

    const uploadLabelBtn = document.querySelector(".up-doc-toolbar .btn-upload-doc-primary");
    if (uploadLabelBtn) uploadLabelBtn.classList.toggle("hidden", !canEdit);

    const quizToolbar = document.querySelector(".up-quiz-one-line-bar");
    if (quizToolbar) quizToolbar.classList.toggle("hidden", !canEdit);

    const textContent = mod.contentText || buildPlainTextFromStructuredData(mod);
    const contentTa = document.getElementById("upModContentText");
    contentTa.value = textContent;
    contentTa.readOnly = !canEdit;
    document.getElementById("lblDocCharCount").textContent = `${textContent.length.toLocaleString("vi-VN")} ký tự`;

    contentTa.oninput = () => {
      if (!canCurrentUserEditModule(mod)) return;
      mod.contentText = contentTa.value;
      document.getElementById("lblDocCharCount").textContent = `${contentTa.value.length.toLocaleString("vi-VN")} ký tự`;
      triggerAutoSave(false, true);
    };

    const titleInp = document.getElementById("upModTitle");
    if (titleInp) {
      titleInp.oninput = () => {
        if (!canCurrentUserEditModule(mod)) return;
        mod.title = titleInp.value.trim() || mod.title;
        triggerAutoSave(false, true);
        renderSidebar();
      };
    }

    document.getElementById("btnGoToQuizGenerator").onclick = () => {
      if (canCurrentUserEditModule(mod)) {
        syncUploaderDocFieldsToModule(mod);
        triggerAutoSave(true, true);
      }
      activeUploaderTab = "quiz";
      renderUploaderWorkspace();
      renderSidebar();
    };

    renderUploaderQuestionBank(mod);
  }

  function buildPlainTextFromStructuredData(mod) {
    if (mod.contentText && mod.contentText.trim()) return mod.contentText;
    const lines = [];
    if (mod.structuredType === "comparison_6_criteria" && Array.isArray(mod.structuredData)) {
      mod.structuredData.forEach(r => {
        lines.push(`[Mục ${r.stt}: ${r.title}]`);
        lines.push(`- Chương trình Bộ GD&ĐT: ${r.bo_gddt}`);
        lines.push(`- Chương trình KNS Novastars: ${r.novastars}`);
        lines.push(`- Điểm khác biệt ăn tiền: ${r.khac_biet_an_tien}`);
        lines.push(`- Câu chốt Sale nói với Chủ trường/Hiệu trưởng: ${r.sale_pitch}\n`);
      });
    } else if (mod.structuredType === "pedagogy_6_reasons" && Array.isArray(mod.structuredData)) {
      mod.structuredData.forEach(r => {
        lines.push(`[Lý do ${r.stt}: ${r.title}]`);
        lines.push(`- Tâm lý trẻ mầm non: ${r.tam_ly_tre}`);
        lines.push(`- Cách trường thường dạy: ${r.cach_truong_thuong_day}`);
        lines.push(`- Cách Novastars thiết kế sẵn: ${r.cach_novastars}`);
        lines.push(`- Cách Sale trả lời Chủ trường/Hiệu trưởng: ${r.sale_pitch}\n`);
      });
    } else if (mod.structuredType === "sample_10_lessons" && Array.isArray(mod.structuredData)) {
      mod.structuredData.forEach(r => {
        lines.push(`[Bài mẫu ${r.stt} - ${r.khoi}: ${r.bai_hoc}]`);
        lines.push(`- Đề tài trường vẫn dạy (${r.de_tai_quen_thuoc}): ${r.cach_truong_thuong_day}`);
        lines.push(`- Nội dung Novastars: ${r.noi_dung_novastars}`);
        lines.push(`- Cách triển khai: ${r.cach_trien_khai}`);
        lines.push(`- Điểm ăn tiền thuyết phục Chủ trường: ${r.diem_an_tien}\n`);
      });
    } else if (mod.structuredType === "roadmap_72_lessons" && mod.structuredData) {
      (mod.structuredData.ageSummaries || []).forEach(a => {
        lines.push(`[Khối ${a.do_tuoi.replace(/\n/g, " - ")}]`);
        lines.push(`- Nội dung khung Bộ: ${a.noi_dung_bo}`);
        lines.push(`- Nội dung nâng cấp Novastars: ${a.noi_dung_novastars}`);
        lines.push(`- Điểm nhấn Sale nói với Hiệu trưởng: ${a.diem_nhan_sale}\n`);
      });
    }
    return lines.join("\n");
  }

  function syncUploaderDocFieldsToModule(mod) {
    if (!mod || !canCurrentUserEditModule(mod)) return;
    mod.status = document.getElementById("upModStatus").value || "published";
    mod.title = document.getElementById("upModTitle").value.trim() || mod.title || "Bài học mới";
    mod.contentText = document.getElementById("upModContentText").value;
    mod.updatedAt = new Date().toISOString();
  }

  function renderUploaderQuestionBank(mod) {
    if (!Array.isArray(mod.questions)) mod.questions = [];
    const qList = mod.questions;
    const canEdit = canCurrentUserEditModule(mod);

    const roBanner = document.getElementById("upReadOnlyNoticeBanner");
    const roAuthor = document.getElementById("lblReadOnlyBannerAuthor");
    if (roBanner) roBanner.classList.toggle("hidden", canEdit);
    if (roAuthor) roAuthor.textContent = mod.authorName || "Quản trị viên";
    document.getElementById("lblUpQuestionCount").textContent = String(qList.length);

    const listContainer = document.getElementById("uploaderQuestionsList");
    listContainer.innerHTML = "";

    if (qList.length === 0) {
      listContainer.innerHTML = `
        <div class="up-card" style="text-align:center;padding:28px;color:#64748B;">
          ${canEdit
            ? `Chưa có câu hỏi nào. Hãy bấm <strong>"Tạo tự động từ tài liệu"</strong> hoặc <strong>"Tải file câu hỏi có sẵn"</strong> ở thanh công cụ phía trên.`
            : `Học phần này của <strong>${escapeHtml(mod.authorName || "Đào tạo")}</strong> hiện chưa có câu hỏi trắc nghiệm.`
          }
        </div>
      `;
      return;
    }

    const letters = ["A", "B", "C", "D"];
    qList.forEach((q, qIdx) => {
      const isExpanded = expandedUploaderQuestionIndex === qIdx;

      if (!isExpanded) {
        // COMPACT 1-LINE ROW
        const row = document.createElement("div");
        row.className = "up-compact-q-row";
        const cIdx = Number(q.correctIndex || 0);
        const correctText = (q.options && q.options[cIdx]) ? q.options[cIdx] : "";
        row.innerHTML = `
          <div class="up-q-row-left">
            <span class="qq-num-badge">Câu ${qIdx + 1}</span>
            <span class="up-q-row-title">${escapeHtml(q.question || "(Chưa nhập câu hỏi)")}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            <span class="up-q-row-ans" title="Đáp án đúng: ${letters[cIdx]}. ${escapeHtml(correctText)}">
              ✓ ${letters[cIdx]}. ${escapeHtml(correctText)}
            </span>
            <button type="button" class="btn-q-mini" data-expand-q="${qIdx}">${canEdit ? "Sửa" : "Xem"}</button>
            ${canEdit ? `<button type="button" class="btn-q-mini danger" data-del-q="${qIdx}" title="Xóa câu này">Xóa</button>` : ""}
          </div>
        `;

        row.addEventListener("click", e => {
          if (e.target.closest("[data-del-q]")) return;
          expandedUploaderQuestionIndex = qIdx;
          renderUploaderQuestionBank(mod);
        });

        const delBtn = row.querySelector(`[data-del-q="${qIdx}"]`);
        if (delBtn && canEdit) {
          delBtn.addEventListener("click", e => {
            e.stopPropagation();
            if (confirm(`Xóa Câu ${qIdx + 1}?`)) {
              qList.splice(qIdx, 1);
              if (expandedUploaderQuestionIndex === qIdx) expandedUploaderQuestionIndex = null;
              triggerAutoSave(true, true);
              renderUploaderQuestionBank(mod);
              renderSidebar();
            }
          });
        }

        listContainer.appendChild(row);
        return;
      }

      // EXPANDED EDITOR / VIEWER FOR ONLY THE SELECTED QUESTION
      const card = document.createElement("div");
      card.className = "up-q-card";

      const optsRowsHtml = [0, 1, 2, 3].map(oIdx => {
        const isCorrect = Number(q.correctIndex) === oIdx;
        const optVal = (q.options && q.options[oIdx]) ? q.options[oIdx] : "";
        return `
          <div class="up-q-opt-row">
            <button type="button" class="up-opt-radio-btn ${isCorrect ? "is-correct" : ""}" data-set-correct="${qIdx}:${oIdx}" ${canEdit ? "" : "disabled"}>
              ${isCorrect ? "✓ Đúng:" : "Phương án:"} ${letters[oIdx]}
            </button>
            <input type="text" class="input-control" data-edit-opt="${qIdx}:${oIdx}" value="${escapeHtml(optVal)}" placeholder="Phương án ${letters[oIdx]}..." ${canEdit ? "" : "readonly"}>
          </div>
        `;
      }).join("");

      card.innerHTML = `
        <div class="up-q-top">
          <div class="up-q-top-left">
            <span class="qq-num-badge">${canEdit ? `Đang sửa Câu ${qIdx + 1}` : `Chi tiết Câu ${qIdx + 1} (Chỉ xem)`}</span>
          </div>
          <div class="up-q-actions">
            ${canEdit ? `<button type="button" class="btn-q-mini danger" data-del-q="${qIdx}">Xóa câu</button>` : ""}
            <button type="button" class="btn-primary" data-collapse-q="${qIdx}" style="padding:5px 12px;font-size:12px;">${canEdit ? "✓ Xong (Thu gọn)" : "Thu gọn"}</button>
          </div>
        </div>

        <div class="form-group">
          <label>Câu hỏi:</label>
          <textarea class="input-control" rows="2" data-edit-qtext="${qIdx}" ${canEdit ? "" : "readonly"}>${escapeHtml(q.question || "")}</textarea>
        </div>

        <div class="up-q-options-grid">
          ${optsRowsHtml}
        </div>

        <div class="form-group">
          <label>Giải thích &amp; Gợi ý tư vấn:</label>
          <textarea class="input-control" rows="2" data-edit-exp="${qIdx}" ${canEdit ? "" : "readonly"}>${escapeHtml(q.explanation || "")}</textarea>
        </div>
      `;

      card.querySelector(`[data-collapse-q="${qIdx}"]`).addEventListener("click", () => {
        expandedUploaderQuestionIndex = null;
        if (canEdit) triggerAutoSave(true, true);
        renderUploaderQuestionBank(mod);
      });

      if (canEdit) {
        card.querySelector(`[data-edit-qtext="${qIdx}"]`).addEventListener("input", e => {
          q.question = e.target.value;
          triggerAutoSave(false, true);
        });

        card.querySelector(`[data-edit-exp="${qIdx}"]`).addEventListener("input", e => {
          q.explanation = e.target.value;
          triggerAutoSave(false, true);
        });

        card.querySelectorAll("[data-edit-opt]").forEach(inp => {
          inp.addEventListener("input", e => {
            const [, oStr] = inp.dataset.editOpt.split(":");
            const oIdx = Number(oStr);
            if (!Array.isArray(q.options)) q.options = ["", "", "", ""];
            q.options[oIdx] = e.target.value;
            triggerAutoSave(false, true);
          });
        });

        card.querySelectorAll("[data-set-correct]").forEach(btn => {
          btn.addEventListener("click", () => {
            const [, oStr] = btn.dataset.setCorrect.split(":");
            q.correctIndex = Number(oStr);
            triggerAutoSave(true, true);
            renderUploaderQuestionBank(mod);
          });
        });

        const delCardBtn = card.querySelector(`[data-del-q="${qIdx}"]`);
        if (delCardBtn) {
          delCardBtn.addEventListener("click", () => {
            if (confirm(`Xóa Câu ${qIdx + 1}?`)) {
              qList.splice(qIdx, 1);
              expandedUploaderQuestionIndex = null;
              triggerAutoSave(true, true);
              renderUploaderQuestionBank(mod);
              renderSidebar();
            }
          });
        }
      }

      listContainer.appendChild(card);
    });
  }

  // =========================================================================
  // AI QUIZ CONVERTER ENGINE (DOCUMENTS -> 4-CRITERIA MULTIPLE-CHOICE QUIZ)
  // =========================================================================
  function generateQuizFromModuleDocument(mod, desiredCount) {
    const rawText = (mod.contentText || buildPlainTextFromStructuredData(mod) || "").trim();
    const summaryPts = Array.isArray(mod.summaryPoints) ? mod.summaryPoints.filter(Boolean) : [];
    const tables = Array.isArray(mod.uploadedTables) ? mod.uploadedTables : [];

    // Collect meaningful facts/statements from summaryPoints, tables, and paragraphs
    const knowledgeAtoms = [];

    summaryPts.forEach(pt => {
      if (pt.length > 20) {
        knowledgeAtoms.push({
          type: "summary",
          topic: mod.title,
          fact: pt,
          pitch: pt
        });
      }
    });

    tables.forEach(tbl => {
      const rows = tbl.rows || [];
      const headers = rows[0] || [];
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const nonEmpty = row.filter(c => c && c.length > 3);
        if (nonEmpty.length >= 2) {
          const topic = row[1] || row[0] || tbl.sheet || mod.title;
          const detail = nonEmpty.slice(1).join(" — ");
          const pitchCell = row[row.length - 1] || row[row.length - 2] || detail;
          if (detail.length > 25) {
            knowledgeAtoms.push({
              type: "table_row",
              topic: topic.slice(0, 90),
              fact: detail.slice(0, 320),
              pitch: pitchCell.slice(0, 280),
              headers
            });
          }
        }
      }
    });

    rawText.split(/\n+/).forEach(line => {
      const cleaned = line.replace(/^[•\-*\d.)\s]+/, "").trim();
      if (cleaned.length >= 35 && !cleaned.startsWith("===")) {
        const parts = cleaned.split(/[:：—–-]/);
        const topic = parts.length > 1 && parts[0].length < 70 ? parts[0].trim() : mod.title;
        knowledgeAtoms.push({
          type: "paragraph",
          topic,
          fact: cleaned.slice(0, 320),
          pitch: cleaned.slice(0, 280)
        });
      }
    });

    if (knowledgeAtoms.length === 0) {
      knowledgeAtoms.push({
        type: "fallback",
        topic: mod.title || "Chương trình Mầm non Chuyển giao Novastars",
        fact: mod.subtitle || "Chương trình Kĩ năng sống Novastars 72 tiết/năm cho 3 khối Bé, Nhỡ, Lớn kèm phần mềm tương tác và giáo án chuẩn.",
        pitch: "Giúp trường mầm non có chương trình mũi nhọn đồng bộ, giáo viên dạy nhàn và thu hút tuyển sinh."
      });
    }

    const realisticDistractorPool = [
      "Chỉ dạy gói gọn trong 1 tiết học lý thuyết rời rạc, cô giáo tự lên mạng tìm nhạc và cắt ghép video mà không có phần mềm đồng bộ.",
      "Thay thế hoàn toàn 100% chương trình khung bắt buộc 5 mặt phát triển của Bộ GD&ĐT và không cần giáo viên của trường đứng lớp.",
      "Cho trẻ ngồi im tại chỗ xem phim hoạt hình suốt 30 phút liên tục mà không có hoạt động vận động, thực hành hay thuyết trình.",
      "Chỉ phát phiếu bé ngoan hoặc tranh tô màu đen trắng về nhà cuối tuần, không có mục tiêu định lượng hay hoạt động quay video thuyết trình.",
      "Yêu cầu mỗi lớp học phải bố trí tối thiểu 4 cô giáo và mua sắm thêm nhiều thiết bị thí nghiệm đắt tiền mới tổ chức được tiết học.",
      "Chỉ áp dụng riêng cho học sinh lớp 5 tuổi chuẩn bị vào lớp 1, không có lộ trình cho khối Mẫu giáo Bé (3–4 tuổi) và Mẫu giáo Nhỡ (4–5 tuổi).",
      "Cô giáo là người nói và làm mẫu hoàn toàn trên bảng, học sinh chỉ ngồi nghe và trả lời đúng hoặc sai theo tranh lô tô truyền thống.",
      "Bắt trẻ học thuộc lòng các khái niệm trừu tượng mà không chia nhỏ kỹ năng thành từng cử chỉ mắt nhìn – miệng cười – tay thực hành cụ thể."
    ];

    const questionTemplates = [
      {
        cat: "kien_thuc",
        catLabel: "1. Cấu trúc chương trình",
        makeQ: (atom) => `Theo tài liệu đào tạo học phần "${mod.title}", nội dung trọng tâm về "${atom.topic}" được quy định chính xác như thế nào?`
      },
      {
        cat: "usp_khac_biet",
        catLabel: "2. Điểm khác biệt USP",
        makeQ: (atom) => `Điểm khác biệt "ăn tiền" của chương trình Novastars đối với "${atom.topic}" so với cách dạy mầm non truyền thống là gì?`
      },
      {
        cat: "dan_chung_bai_mau",
        catLabel: "3. Dẫn chứng bài mẫu",
        makeQ: (atom) => `Khi cần lấy dẫn chứng cụ thể từ tài liệu về "${atom.topic}" để minh họa cho Hiệu trưởng, Sale cần nêu chính xác thông tin nào sau đây?`
      },
      {
        cat: "xu_ly_tinh_huong",
        catLabel: "4. Xử lý tình huống",
        makeQ: (atom) => `Khi Chủ trường / Hiệu trưởng băn khoăn về "${atom.topic}", Sale nên sử dụng luận điểm tư vấn nào dưới đây để thuyết phục đúng chuẩn tài liệu gốc?`
      }
    ];

    const generated = [];
    const targetPattern = [0, 2, 1, 3, 1, 3, 0, 2];
    const totalToGenerate = (!desiredCount || desiredCount <= 0)
      ? Math.max(knowledgeAtoms.length, 10)
      : desiredCount;

    for (let i = 0; i < totalToGenerate; i++) {
      const atom = knowledgeAtoms[i % knowledgeAtoms.length];
      const tpl = questionTemplates[i % questionTemplates.length];
      const correctPos = targetPattern[i % targetPattern.length];

      // Pick 3 distinct distractors
      const d1 = realisticDistractorPool[(i * 3) % realisticDistractorPool.length];
      const d2 = realisticDistractorPool[(i * 3 + 1) % realisticDistractorPool.length];
      const d3 = realisticDistractorPool[(i * 3 + 2) % realisticDistractorPool.length];

      const options = [d1, d2, d3];
      options.splice(correctPos, 0, atom.fact);

      generated.push({
        id: `${(mod.code || "hp").toLowerCase()}-ai-${Date.now().toString(36)}-${i + 1}`,
        category: tpl.cat,
        categoryLabel: tpl.catLabel,
        question: tpl.makeQ(atom),
        options,
        correctIndex: correctPos,
        explanation: `Căn cứ tài liệu gốc (${mod.title}): ${atom.fact}. Gợi ý tư vấn Chủ trường/Hiệu trưởng: ${atom.pitch}`
      });
    }

    return generated;
  }

  // =========================================================================
  // PARSER FOR IMPORTING EXISTING QUIZ QUESTION BANKS (TEXT / WORD / EXCEL / JSON)
  // =========================================================================
  function parseImportedQuizTextOrTables(rawText, tables) {
    const parsedQuestions = [];

    // 1. Try JSON format first
    const trimmed = (rawText || "").trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed);
        const arr = Array.isArray(obj) ? obj : (obj.questions || []);
        arr.forEach((item, idx) => {
          if (item && item.question && Array.isArray(item.options)) {
            parsedQuestions.push({
              id: item.id || `imp-json-${Date.now()}-${idx}`,
              category: item.category || "kien_thuc",
              categoryLabel: item.categoryLabel || getCategoryLabel(item.category || "kien_thuc"),
              question: String(item.question).trim(),
              options: item.options.slice(0, 4).map(o => String(o).trim()),
              correctIndex: Number(item.correctIndex || 0),
              explanation: String(item.explanation || "").trim()
            });
          }
        });
        if (parsedQuestions.length > 0) return parsedQuestions;
      } catch (e) {}
    }

    // Helper: parse answer letter/number -> 0..3
    function parseAnswerLetterToIdx(ansRaw) {
      const s = String(ansRaw || "").toUpperCase().trim();
      if (!s) return 0;
      const m = s.match(/\b([A-D])\b/) || s.match(/([A-D])/);
      if (m) return m[1].charCodeAt(0) - 65;
      if (s === "2") return 1;
      if (s === "3") return 2;
      if (s === "4") return 3;
      return 0;
    }

    // Extract any Answer Key table or footer map (e.g. "1.A 2.B 3.C ... 20.D" or "1-A, 2-B...")
    const answerKeyMap = {};
    const combinedRawForKey = [
      rawText || "",
      ...(Array.isArray(tables) ? tables.map(t => (t.rows || []).map(r => r.join(" ")).join("\n")) : [])
    ].join("\n");
    const keyPairRegex = /\b(\d{1,3})\s*[.:\-)\s]\s*([A-D])\b/gi;
    let kpMatch;
    while ((kpMatch = keyPairRegex.exec(combinedRawForKey)) !== null) {
      const qNum = Number(kpMatch[1]);
      const ansChar = kpMatch[2].toUpperCase();
      if (qNum >= 1 && qNum <= 200) {
        answerKeyMap[qNum] = ansChar.charCodeAt(0) - 65;
      }
    }

    // 2. Try Excel/Table rows if tables are provided
    const extraTableTextBlocks = [];
    if (Array.isArray(tables) && tables.length > 0) {
      tables.forEach(tbl => {
        const rows = tbl.rows || [];
        if (rows.length === 0) return;

        // Detect column indices from header row if present (check first 15 rows, must have >= 2 non-empty cells)
        let colQ = -1;
        let colA = -1;
        let colB = -1;
        let colC = -1;
        let colD = -1;
        let colAns = -1;
        let colExp = -1;
        let colCat = -1;
        let headerRowIdx = -1;

        for (let r = 0; r < Math.min(rows.length, 15); r++) {
          const rCols = (rows[r] || []).map(c => String(c || "").trim().toLowerCase());
          const nonEmptyH = rCols.filter(Boolean);
          if (nonEmptyH.length < 2) continue;
          const joined = rCols.join(" | ");
          if (/câu\s*hỏi|nội\s*dung|question|phương\s*án\s*a|đáp\s*án\s*a/i.test(joined)) {
            let tmpQ = -1, tmpA = -1, tmpB = -1, tmpC = -1, tmpD = -1, tmpAns = -1, tmpExp = -1, tmpCat = -1;
            rCols.forEach((h, idx) => {
              if (!h) return;
              // Match option columns A, B, C, D FIRST so "Đáp án A" is never swallowed by "Đáp án" (colAns)
              if (tmpA === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*a(?:\s*\(.*\))?$/i.test(h) || /^a[.:)\-\s]/i.test(h))) tmpA = idx;
              else if (tmpB === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*b(?:\s*\(.*\))?$/i.test(h) || /^b[.:)\-\s]/i.test(h))) tmpB = idx;
              else if (tmpC === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*c(?:\s*\(.*\))?$/i.test(h) || /^c[.:)\-\s]/i.test(h))) tmpC = idx;
              else if (tmpD === -1 && (/^(?:phương\s*án|đáp\s*án|lựa\s*chọn|pa|câu)?\s*d(?:\s*\(.*\))?$/i.test(h) || /^d[.:)\-\s]/i.test(h))) tmpD = idx;
              else if (tmpAns === -1 && /đáp\s*án\s*đúng|đáp\s*án\s*chuẩn|^đáp\s*án$|kết\s*quả|correct|answer|^đ\/a$|^đa$/i.test(h)) tmpAns = idx;
              else if (tmpExp === -1 && /giải\s*thích|gợi\s*ý|explanation|ghi\s*chú|hướng\s*dẫn/i.test(h)) tmpExp = idx;
              else if (tmpQ === -1 && /câu\s*hỏi|nội\s*dung|question|đề\s*bài/i.test(h)) tmpQ = idx;
              else if (tmpCat === -1 && /nhóm|chủ\s*đề|category|phân\s*loại|mức\s*độ|bài\s*học/i.test(h)) tmpCat = idx;
            });
            if (tmpQ !== -1 || (tmpA !== -1 && tmpB !== -1)) {
              headerRowIdx = r;
              colA = tmpA;
              colB = tmpB;
              colC = tmpC;
              colD = tmpD;
              colAns = tmpAns;
              colExp = tmpExp;
              colCat = tmpCat;
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

          // Skip repeated header rows inside multi-table sheets
          if (/^(?:stt|câu\s*hỏi|mã\s*câu)$/i.test(nonEmptyCols[0]) && nonEmptyCols.some(c => /câu\s*hỏi|phương\s*án|đáp\s*án/i.test(c))) {
            return;
          }

          // Helper to push vertical/stacked Excel rows (e.g. ["A", "Phương án A"] -> "A. Phương án A", ["Đáp án", "B"] -> "Đáp án: B")
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
            // Smart positional detection on nonEmptyCols / cols:
            // Find the question column (first column after STT/short metadata that has length >= 8)
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

          // Case where all 4 options A, B, C, D are inside a single cell (optA or qText)
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

          // Strip leading "A. ", "B. " from table option cells if present
          const cleanOpt = (s, letter) => {
            const re = new RegExp(`^[-*•]?\\s*\\**${letter}[.:)\\-]\\**\\s*`, "i");
            return String(s || "").replace(re, "").trim();
          };

          // If qText itself contains multiline question + options inside a single cell, push to text block parser
          if (qText && !optA && !optB && /\bA[.:)]\s+/i.test(qText)) {
            pushRowToTextBlocks();
            return;
          }

          if (qText.length >= 4 && optA && optB) {
            const qIndexNum = parsedQuestions.length + 1;
            let cIdx = ansRaw
              ? parseAnswerLetterToIdx(ansRaw)
              : (answerKeyMap[qIndexNum] !== undefined ? answerKeyMap[qIndexNum] : 0);

            const rawOpts = [optA, optB, optC || "Phương án C", optD || "Phương án D"];
            const finalOpts = rawOpts.map((o, idx) => {
              let txt = cleanOpt(o, String.fromCharCode(65 + idx));
              if (/\(Đáp án đúng\)|\(Đúng\)|^\*|\*$/i.test(txt)) {
                cIdx = idx;
                txt = txt.replace(/\(Đáp án đúng\)|\(Đúng\)|^\*+|\*+$/gi, "").trim();
              }
              return txt || `Phương án ${String.fromCharCode(65 + idx)}`;
            });

            parsedQuestions.push({
              id: `imp-tbl-${Date.now()}-${qIndexNum}`,
              category: "kien_thuc",
              categoryLabel: "1. Cấu trúc chương trình",
              question: qText.replace(/^(?:Câu(?:\s+hỏi)?\s*\d+|Q\d+|\d+)[.:)\-]\s*/i, "").trim() || qText,
              options: finalOpts,
              correctIndex: cIdx,
              explanation: expText || "Theo bộ câu hỏi đào tạo chuẩn."
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

    // Pre-split lines that contain multiple options on the same line (e.g. "A. ... B. ... C. ... D. ...")
    const rawLines = fullTextToParse.split(/\r?\n/);
    const lines = [];
    rawLines.forEach(rawLine => {
      let l = rawLine.replace(/\t+/g, "  ").trim();
      if (!l || /^===\s*SHEET:/i.test(l)) return;
      // Split inline options like "   B. " or " B. " or " | B. " when preceded by whitespace or pipe
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
          compactOpts.push(`Phương án ${String.fromCharCode(65 + compactOpts.length)}`);
        }
        curQ.options = compactOpts.slice(0, 4);
        if (!curQ.hasExplicitAnswer && curQNumber > 0 && answerKeyMap[curQNumber] !== undefined) {
          curQ.correctIndex = answerKeyMap[curQNumber];
        }
        delete curQ.hasExplicitAnswer;
        parsedQuestions.push(curQ);
      }
      curQ = null;
    }

    lines.forEach(line => {
      // Stop if we hit a standalone "BẢNG ĐÁP ÁN" / "ĐÁP ÁN" section header at the end
      if (/^(?:BẢNG\s+ĐÁP\s+ÁN|ĐÁP\s+ÁN\s+THAM\s+KHẢO|PHẦN\s+ĐÁP\s+ÁN)$/i.test(line)) {
        pushCurQ();
        return;
      }

      const qMatch = line.match(/^(?:#+\s*)?\**(?:Câu(?:\s+hỏi|\s+số)?\s*(\d+)|Question\s*(\d+)|Q(\d+)|(\d{1,3}))\**\s*[.:)\-/]\s*(.+)$/i);
      const qHeaderOnlyMatch = !qMatch && line.match(/^(?:#+\s*)?\**(?:Câu(?:\s+hỏi|\s+số)?\s*(\d+)|Question\s*(\d+))\**\s*[.:)\-]?$/i);
      const optMatch = line.match(/^[-*•]?\s*(\*)?\s*\**\[?([A-D])\]?[.:)\-]\**\s*(.+)$/i);
      const ansMatch = line.match(/^(?:👉\s*|✓\s*)?\**(?:Đáp\s*án(?:\s*đúng)?|Đ\/A|ĐA|Kết\s*quả|KQ|Correct|Answer)\**\s*[:\-=.]\s*\**(?:Câu\s*|Phương\s*án\s*)?([A-D])\**/i);
      const expMatch = line.match(/^(?:💡\s*)?\**(?:Giải\s*thích|Ý\s*nghĩa|Gợi\s*ý(?:\s*tư\s*vấn)?|Hướng\s*dẫn)\**\s*[:\-]\s*(.+)$/i);

      if (qMatch && (!curQ || curQ.options.filter(Boolean).length >= 2 || /^(?:Câu|Question|Q)/i.test(line))) {
        pushCurQ();
        curQNumber = Number(qMatch[1] || qMatch[2] || qMatch[3] || qMatch[4] || (parsedQuestions.length + 1));
        curQ = {
          id: `imp-txt-${Date.now()}-${parsedQuestions.length + 1}`,
          category: "kien_thuc",
          categoryLabel: "1. Cấu trúc chương trình",
          question: qMatch[5].trim(),
          options: [],
          correctIndex: 0,
          hasExplicitAnswer: false,
          explanation: ""
        };
      } else if (qHeaderOnlyMatch && (!curQ || curQ.options.filter(Boolean).length >= 2)) {
        pushCurQ();
        curQNumber = Number(qHeaderOnlyMatch[1] || qHeaderOnlyMatch[2] || (parsedQuestions.length + 1));
        curQ = {
          id: `imp-txt-${Date.now()}-${parsedQuestions.length + 1}`,
          category: "kien_thuc",
          categoryLabel: "1. Cấu trúc chương trình",
          question: "",
          options: [],
          correctIndex: 0,
          hasExplicitAnswer: false,
          explanation: ""
        };
      } else if (optMatch) {
        if (!curQ) {
          curQNumber = parsedQuestions.length + 1;
          curQ = {
            id: `imp-txt-${Date.now()}-${curQNumber}`,
            category: "kien_thuc",
            categoryLabel: "1. Cấu trúc chương trình",
            question: `Câu hỏi ${curQNumber}`,
            options: [],
            correctIndex: 0,
            hasExplicitAnswer: false,
            explanation: ""
          };
        }
        const hasStarPrefix = Boolean(optMatch[1]);
        const letter = optMatch[2].toUpperCase();
        const idx = letter.charCodeAt(0) - 65;
        let optContent = optMatch[3].trim();
        if (hasStarPrefix || /\(Đáp án đúng\)|\(Đúng\)|✓|\*$/i.test(optContent)) {
          curQ.correctIndex = idx;
          curQ.hasExplicitAnswer = true;
          optContent = optContent.replace(/\(Đáp án đúng\)|\(Đúng\)|✓|\*+$/gi, "").trim();
        }
        curQ.options[idx] = optContent;
      } else if (ansMatch && curQ) {
        const letter = ansMatch[1].toUpperCase();
        curQ.correctIndex = Math.max(0, Math.min(3, letter.charCodeAt(0) - 65));
        curQ.hasExplicitAnswer = true;
      } else if (expMatch && curQ) {
        curQ.explanation = expMatch[1].trim();
      } else if (curQ && curQ.question && (/\?$|:$/.test(curQ.question) || curQ.options.length > 0) && curQ.options.filter(Boolean).length < 4) {
        // Handle Word auto-numbered options where "A.", "B.", "C.", "D." were list bullets stripped from <w:t>
        const nextOptIdx = curQ.options.filter(Boolean).length;
        let optContent = line.trim();
        if (/\(Đáp án đúng\)|\(Đúng\)|✓|\*$/i.test(optContent)) {
          curQ.correctIndex = nextOptIdx;
          curQ.hasExplicitAnswer = true;
          optContent = optContent.replace(/\(Đáp án đúng\)|\(Đúng\)|✓|\*+$/gi, "").trim();
        }
        curQ.options[nextOptIdx] = optContent;
      } else if (curQ && curQ.options.filter(Boolean).length === 0) {
        curQ.question = (curQ.question ? curQ.question + "\n" : "") + line;
      } else if (!curQ && line.length > 10 && !/^(?:ĐÁP\s*ÁN|BÀI\s*KIỂM\s*TRA|ĐỀ\s*THI)/i.test(line)) {
        // Unnumbered question line before A. B. C. D.
        curQNumber = parsedQuestions.length + 1;
        curQ = {
          id: `imp-txt-${Date.now()}-${curQNumber}`,
          category: "kien_thuc",
          categoryLabel: "1. Cấu trúc chương trình",
          question: line,
          options: [],
          correctIndex: 0,
          hasExplicitAnswer: false,
          explanation: ""
        };
      }
    });
    pushCurQ();

    return parsedQuestions;
  }

  // =========================================================================
  // VIEW C: ADMIN (MANAGER) DASHBOARD RENDERING
  // =========================================================================
  let adminMatrixSearchQuery = "";
  let adminModuleStatusFilter = "ALL";
  let adminModuleAuthorFilter = "ALL";
  let adminModuleSearchQuery = "";
  let adminActivitySearchQuery = "";

  function renderAdminWorkspace() {
    const allUsers = db.users || [];
    const sales = allUsers.filter(u => u.role === "sale");
    const uploaders = allUsers.filter(u => u.role === "uploader");
    const pubMods = getVisibleModulesForLearner();

    const allMods = db.modules || [];
    const pendingModsCount = allMods.filter(m => m.status === "pending").length;
    const allBugs = db.bugReports || [];
    const openBugsCount = allBugs.filter(b => b.status !== "resolved").length;
    const nowMs = Date.now();
    const allTrackedUsers = [...allUsers, { id: "admin", name: "Admin", role: "admin" }];
    const onlineUsersCount = allTrackedUsers.filter(u => {
      const pr = db.presence && db.presence[u.id];
      return pr && (nowMs - (Date.parse(pr.lastSeenAt || "") || 0) < ONLINE_THRESHOLD_MS);
    }).length;

    document.getElementById("badgeAdminMatrixCount").textContent = `${sales.length} HV`;
    document.getElementById("badgeAdminAnalyticsCount").textContent = `${pubMods.length} bài`;
    const badgeUsers = document.getElementById("badgeAdminUsersCount");
    if (badgeUsers) {
      badgeUsers.textContent = `${sales.length} HV · ${uploaders.length} ĐT`;
    }
    const badgeMods = document.getElementById("badgeAdminModulesCount");
    if (badgeMods) {
      badgeMods.textContent = pendingModsCount > 0 ? `${pendingModsCount} chờ duyệt` : `${allMods.length} bài`;
      badgeMods.classList.toggle("alert", pendingModsCount > 0);
    }
    const badgeAct = document.getElementById("badgeAdminActivityCount");
    if (badgeAct) {
      badgeAct.textContent = `${onlineUsersCount} online`;
      badgeAct.classList.toggle("live", onlineUsersCount > 0);
    }
    const badgeBugs = document.getElementById("badgeAdminBugsCount");
    if (badgeBugs) {
      badgeBugs.textContent = openBugsCount > 0 ? `${openBugsCount} chờ xử lý` : `${allBugs.length} mục`;
      badgeBugs.classList.toggle("alert", openBugsCount > 0);
    }

    // Render Interactive 5-Card KPI Command Strip
    const kpiBar = document.getElementById("adminKpiBar");
    let totalCells = sales.length * pubMods.length;
    let passedCells = 0;
    let totalAttempts = 0;
    let sumBestScores = 0;
    let scoredPairs = 0;

    sales.forEach(s => {
      pubMods.forEach(m => {
        const p = (db.progress || []).find(pr => pr.userId === s.id && pr.moduleId === m.id);
        if (p) {
          if (p.passed) passedCells++;
          if (Array.isArray(p.attempts) && p.attempts.length > 0) {
            totalAttempts += p.attempts.length;
            sumBestScores += Number(p.bestScore || 0);
            scoredPairs++;
          }
        }
      });
    });

    const completionRate = totalCells > 0 ? Math.round((passedCells * 100) / totalCells) : 0;
    const avgScore = scoredPairs > 0 ? Math.round(sumBestScores / scoredPairs) : 0;
    const totalQuestions = allMods.reduce((acc, m) => acc + (Array.isArray(m.questions) ? m.questions.length : 0), 0);

    kpiBar.innerHTML = `
      <button type="button" class="kpi-card ${activeAdminTab === 'matrix' ? 'active-kpi' : ''}" data-kpi-goto="matrix" title="Bấm để xem Ma trận Tiến độ Học Viên">
        <span class="kpi-label">Tiến độ Đạt Toàn đội</span>
        <span class="kpi-val" style="color:#059669;">${completionRate}% (${passedCells}/${totalCells})</span>
        <span class="kpi-sub">${sales.length} Học Viên · Điểm TB: ${avgScore}% (${totalAttempts} lượt thi)</span>
      </button>
      <button type="button" class="kpi-card ${activeAdminTab === 'modules' ? 'active-kpi' : ''}" data-kpi-goto="modules" title="Bấm để Quản lý & Duyệt Học phần">
        <span class="kpi-label">Học phần &amp; Câu hỏi</span>
        <span class="kpi-val">${allMods.length} bài · ${totalQuestions} câu</span>
        <span class="kpi-sub" style="${pendingModsCount > 0 ? 'color:#D97706;font-weight:700;' : ''}">
          ${pendingModsCount > 0 ? `● ${pendingModsCount} bài chờ Admin duyệt` : `✓ ${pubMods.length} bài đã xuất bản`}
        </span>
      </button>
      <button type="button" class="kpi-card ${activeAdminTab === 'users' ? 'active-kpi' : ''}" data-kpi-goto="users" title="Bấm để Quản lý Nhân sự & Mã PIN">
        <span class="kpi-label">Nhân sự &amp; Mã PIN</span>
        <span class="kpi-val">${allUsers.length} nhân sự</span>
        <span class="kpi-sub">${sales.length} Học Viên · ${uploaders.length} Đào tạo</span>
      </button>
      <button type="button" class="kpi-card ${activeAdminTab === 'activity' ? 'active-kpi' : ''}" data-kpi-goto="activity" title="Bấm để xem Trạng thái Online & Lịch sử Hoạt động">
        <span class="kpi-label">Trực tuyến &amp; Hoạt động</span>
        <span class="kpi-val" style="color:#059669;">● ${onlineUsersCount} đang online</span>
        <span class="kpi-sub">${(db.activityLogs || []).length} bản ghi lịch sử hoạt động</span>
      </button>
      <button type="button" class="kpi-card ${activeAdminTab === 'bugs' ? 'active-kpi' : ''}" data-kpi-goto="bugs" title="Bấm để xem Báo lỗi & Phản hồi">
        <span class="kpi-label">Báo lỗi &amp; Phản hồi</span>
        <span class="kpi-val" style="color:${openBugsCount > 0 ? '#DC2626' : '#059669'};">
          ${openBugsCount > 0 ? `${openBugsCount} chờ xử lý` : `✓ 0 lỗi tồn đọng`}
        </span>
        <span class="kpi-sub">Tổng cộng ${allBugs.length} báo lỗi / góp ý đã gửi</span>
      </button>
    `;

    kpiBar.querySelectorAll("[data-kpi-goto]").forEach(btn => {
      btn.onclick = () => {
        activeAdminTab = btn.dataset.kpiGoto;
        renderAdminWorkspace();
      };
    });

    // Sidebar tab buttons
    document.querySelectorAll("[data-admin-tab]").forEach(btn => {
      const tabId = btn.dataset.adminTab;
      btn.classList.toggle("active", activeAdminTab === tabId);
      btn.onclick = () => {
        activeAdminTab = tabId;
        renderAdminWorkspace();
      };
    });

    const pMatrix = document.getElementById("adminPanelMatrix");
    const pDossier = document.getElementById("adminPanelDossier");
    const pAnalytics = document.getElementById("adminPanelAnalytics");
    const pModules = document.getElementById("adminPanelModules");
    const pActivity = document.getElementById("adminPanelActivity");
    const pBugs = document.getElementById("adminPanelBugs");
    const pUsers = document.getElementById("adminPanelUsers");

    pMatrix.classList.toggle("hidden", activeAdminTab !== "matrix");
    pDossier.classList.toggle("hidden", activeAdminTab !== "dossier");
    pAnalytics.classList.toggle("hidden", activeAdminTab !== "analytics");
    if (pModules) pModules.classList.toggle("hidden", activeAdminTab !== "modules");
    if (pActivity) pActivity.classList.toggle("hidden", activeAdminTab !== "activity");
    if (pBugs) pBugs.classList.toggle("hidden", activeAdminTab !== "bugs");
    if (pUsers) pUsers.classList.toggle("hidden", activeAdminTab !== "users");

    if (activeAdminTab === "matrix") {
      renderAdminMatrixPanel(sales, pubMods);
    } else if (activeAdminTab === "modules") {
      renderAdminModulesPanel();
    } else if (activeAdminTab === "users") {
      renderAdminUsersPanel();
    } else if (activeAdminTab === "activity") {
      renderAdminActivityPanel();
    } else if (activeAdminTab === "bugs") {
      renderBugReportsPanelInto("adminPanelBugs");
    } else if (activeAdminTab === "dossier") {
      renderAdminDossierPanel(sales, pubMods);
    } else {
      renderAdminAnalyticsPanel(sales, pubMods);
    }
  }

  function renderAdminMatrixPanel(sales, pubMods) {
    const table = document.getElementById("progressMatrixTable");
    const searchInp = document.getElementById("inputAdminMatrixSearch");
    if (searchInp && !searchInp.dataset.boundMatrixSearch) {
      searchInp.dataset.boundMatrixSearch = "1";
      searchInp.addEventListener("input", () => {
        adminMatrixSearchQuery = searchInp.value.trim().toLowerCase();
        renderAdminMatrixPanel((db.users || []).filter(u => u.role === "sale"), getVisibleModulesForLearner());
      });
    }

    const filteredSales = sales.filter(s => {
      if (!adminMatrixSearchQuery) return true;
      return (
        (s.name || "").toLowerCase().includes(adminMatrixSearchQuery) ||
        String(s.pin || "").toLowerCase().includes(adminMatrixSearchQuery)
      );
    });

    let thead = `<thead><tr><th style="min-width:175px;">Học Viên &amp; Trạng thái Live</th><th style="width:68px;text-align:center;">PIN</th><th style="width:128px;text-align:center;">Tiến độ chung</th>`;
    pubMods.forEach(m => {
      const qCount = Array.isArray(m.questions) ? m.questions.length : 0;
      thead += `
        <th title="${escapeHtml(m.code)} — ${escapeHtml(m.title)} (Tác giả: ${escapeHtml(m.authorName || 'Đào tạo')})">
          <div class="matrix-mod-th-head">
            <div class="matrix-mod-th-top">
              <span class="matrix-mod-th-code">${escapeHtml(m.code)}</span>
              <span class="matrix-mod-th-qcnt">${qCount} câu</span>
            </div>
            <div class="matrix-mod-th-title">${escapeHtml(m.title)}</div>
            <span class="admin-mod-author-sub">TG: ${escapeHtml(m.authorName || "Đào tạo")}</span>
          </div>
        </th>
      `;
    });
    thead += `</tr></thead>`;

    const nowMs = Date.now();
    let tbody = `<tbody>`;
    if (filteredSales.length === 0) {
      tbody += `<tr><td colspan="${pubMods.length + 3}" style="text-align:center;padding:24px;color:#64748B;">Không tìm thấy Học Viên phù hợp.</td></tr>`;
    }
    filteredSales.forEach(s => {
      let sPassed = 0;
      pubMods.forEach(m => {
        const p = (db.progress || []).find(pr => pr.userId === s.id && pr.moduleId === m.id);
        if (p && p.passed) sPassed++;
      });
      const sPct = pubMods.length > 0 ? Math.round((sPassed * 100) / pubMods.length) : 0;
      const pr = db.presence && db.presence[s.id];
      const isOnline = pr && pr.lastSeenAt && (nowMs - (Date.parse(pr.lastSeenAt) || 0) < ONLINE_THRESHOLD_MS);
      const liveText = pr && pr.statusText
        ? `${isOnline ? "● Online:" : "○"} ${pr.statusText}`
        : "○ Chưa có hoạt động gần đây";

      tbody += `
        <tr>
          <td>
            <div class="matrix-learner-cell">
              <button type="button" class="matrix-learner-name-btn" data-goto-learner-dossier="${escapeHtml(s.id)}" title="Bấm để xem Hồ sơ chi tiết của ${escapeHtml(s.name)}">
                <span class="presence-dot ${isOnline ? "online" : ""}"></span>
                ${escapeHtml(s.name)}
              </button>
              <span class="matrix-learner-live-sub">${escapeHtml(liveText)}</span>
            </div>
          </td>
          <td style="text-align:center;"><code>${escapeHtml(s.pin)}</code></td>
          <td style="text-align:center;">
            <span class="sidebar-item-status ${sPassed === pubMods.length && pubMods.length > 0 ? 'done' : 'reading'}">
              ${sPassed}/${pubMods.length} bài (${sPct}%)
            </span>
          </td>
      `;

      pubMods.forEach(m => {
        const p = (db.progress || []).find(pr => pr.userId === s.id && pr.moduleId === m.id);
        const attCount = (p && Array.isArray(p.attempts)) ? p.attempts.length : 0;
        let cls = "empty";
        let label = "Chưa học";
        let sub = "Bấm để xem";

        if (p && p.passed) {
          cls = "done";
          label = `✓ Đạt ${p.bestScore}%`;
          sub = `${attCount} lần thi`;
        } else if (attCount > 0) {
          cls = "failed";
          label = `${p.bestScore}% (Chưa đạt)`;
          sub = `${attCount} lần thi`;
        } else if (p && p.docViewed) {
          cls = "reading";
          label = `Đã mở tài liệu`;
          sub = `Chưa nộp bài`;
        }

        tbody += `
          <td>
            <button type="button" class="matrix-cell-btn ${cls}" data-inspect-sale="${escapeHtml(s.id)}" data-inspect-mod="${escapeHtml(m.id)}">
              <span>${label}</span>
              <span style="font-size:10.5px;opacity:0.85;font-weight:600;">${sub}</span>
            </button>
          </td>
        `;
      });

      tbody += `</tr>`;
    });
    tbody += `</tbody>`;
    table.innerHTML = thead + tbody;

    table.querySelectorAll("[data-inspect-sale]").forEach(btn => {
      btn.addEventListener("click", () => {
        openQuickInspectSaleModal(btn.dataset.inspectSale, btn.dataset.inspectMod);
      });
    });

    table.querySelectorAll("[data-goto-learner-dossier]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeDossierSaleId = btn.dataset.gotoLearnerDossier;
        renderAdminDossierPanel(sales, pubMods, "adminInlineDossierContainer");
        const container = document.getElementById("adminInlineDossierContainer");
        if (container) container.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });

    // Always render the merged Learner Dossier card right below the Progress Matrix
    renderAdminDossierPanel(sales, pubMods, "adminInlineDossierContainer");
  }

  function openQuickInspectSaleModal(saleId, moduleId) {
    const sale = (db.users || []).find(u => u.id === saleId);
    const mod = (db.modules || []).find(m => m.id === moduleId);
    if (!sale || !mod) return;

    const prog = (db.progress || []).find(p => p.userId === sale.id && p.moduleId === mod.id);
    const dlg = document.getElementById("adminQuickInspectModal");
    const titleEl = document.getElementById("quickInspectTitle");
    const metaEl = document.getElementById("quickInspectMeta");
    const bodyEl = document.getElementById("quickInspectBody");
    const btnActAs = document.getElementById("btnInspectActAsSale");

    titleEl.textContent = `${sale.name} — ${mod.code}: ${mod.title}`;
    const attCount = (prog && Array.isArray(prog.attempts)) ? prog.attempts.length : 0;
    metaEl.textContent = `Mã PIN: ${sale.pin} · Điểm chuẩn: >= ${mod.passThreshold || 80}% · Điểm cao nhất: ${prog ? prog.bestScore : 0}% · Số lần làm bài: ${attCount}`;

    if (!prog || attCount === 0) {
      bodyEl.innerHTML = `
        <div style="padding:20px;background:#F8FAFC;border-radius:10px;border:1px solid #E2E8F0;color:#475569;font-size:13.5px;">
          ${prog && prog.docViewed
            ? `Học Viên <strong>${escapeHtml(sale.name)}</strong> đã mở xem tài liệu học phần này nhưng chưa nộp bài kiểm tra trắc nghiệm.`
            : `Học Viên <strong>${escapeHtml(sale.name)}</strong> chưa bắt đầu học phần này.`}
        </div>
      `;
    } else {
      const latest = prog.attempts[0];
      const qList = mod.questions || [];
      const letters = ["A", "B", "C", "D"];

      const qBreakdownHtml = qList.map((q, idx) => {
        const chosen = latest.answers ? latest.answers[q.id] : undefined;
        const isRight = chosen === Number(q.correctIndex);
        return `
          <div style="padding:10px 12px;border-radius:9px;border:1px solid ${isRight ? '#6EE7B7' : '#FDA4AF'};background:${isRight ? '#ECFDF5' : '#FFF1F2'};font-size:12.8px;">
            <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px;">
              <strong>Câu ${idx + 1}: ${escapeHtml(q.question)}</strong>
              <span style="font-weight:800;white-space:nowrap;color:${isRight ? '#065F46' : '#BE123C'};">
                ${isRight ? `✓ Đúng (${letters[q.correctIndex]})` : `✕ Chọn ${chosen !== undefined ? letters[chosen] : 'Trống'} / Đúng: ${letters[q.correctIndex]}`}
              </span>
            </div>
            ${!isRight && chosen !== undefined && q.options[chosen] ? `<div style="color:#9F1239;font-size:12px;">• Đáp án Học Viên đã chọn: ${escapeHtml(q.options[chosen])}</div>` : ""}
            <div style="color:#065F46;font-size:12px;">• Đáp án chuẩn: ${escapeHtml(q.options[q.correctIndex] || "")}</div>
          </div>
        `;
      }).join("");

      const historyHtml = prog.attempts.map((a, i) => {
        const tabBadge = a.tabSwitches > 0 ? ` · Chuyển tab: ${a.tabSwitches} lần` : "";
        const timeBadge = a.timeSpentSec ? ` · ${formatMMSS(a.timeSpentSec)}` : "";
        return `
          <span class="sidebar-item-status ${a.passed ? 'done' : 'failed'}">
            Lần #${prog.attempts.length - i}: ${a.score}% (${a.correctCount}/${a.totalCount})${timeBadge}${tabBadge} · ${new Date(a.timestamp).toLocaleString("vi-VN")}
          </span>
        `;
      }).join(" ");

      bodyEl.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <strong style="font-size:12.5px;">Lịch sử các lần nộp bài:</strong> ${historyHtml}
          </div>
          <h4 style="font-size:13.5px;color:#0F172A;">Chi tiết bài làm gần nhất (${latest.score}% — Đúng ${latest.correctCount}/${latest.totalCount} câu):</h4>
          <div style="display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto;">
            ${qBreakdownHtml}
          </div>
        </div>
      `;
    }

    btnActAs.onclick = () => {
      dlg.close();
      impersonatedSaleUser = sale;
      currentModuleId = mod.id;
      activeWorkspaceView = "sale";
      resetActiveQuizState();
      renderAll();
    };

    dlg.showModal();
  }

  function wrapCanvasTextLines(ctx, text, maxWidth, maxLines = 2) {
    const words = String(text || "").trim().split(/\s+/);
    const lines = [];
    let current = "";
    for (let i = 0; i < words.length; i++) {
      const test = current ? current + " " + words[i] : words[i];
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = words[i];
        if (lines.length >= maxLines - 1) {
          let rest = [current, ...words.slice(i + 1)].join(" ");
          while (ctx.measureText(rest).width > maxWidth && rest.length > 4) {
            rest = rest.slice(0, -4) + "...";
          }
          lines.push(rest);
          return lines;
        }
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  function buildLearnerReportCanvas(saleId) {
    const sale = (db.users || []).find(u => u.id === saleId && u.role === "sale");
    const pubMods = getVisibleModulesForLearner();
    if (!sale) return null;

    let passedCount = 0;
    let totalAttempts = 0;
    let sumBest = 0;
    let attemptedMods = 0;
    const rowsData = pubMods.map(m => {
      const p = (db.progress || []).find(pr => pr.userId === sale.id && pr.moduleId === m.id);
      const attCnt = (p && Array.isArray(p.attempts)) ? p.attempts.length : 0;
      const best = attCnt > 0 ? Number(p.bestScore || 0) : null;
      const passed = Boolean(p && p.passed);
      if (passed) passedCount++;
      if (attCnt > 0) {
        totalAttempts += attCnt;
        sumBest += best;
        attemptedMods++;
      }
      const lastAttempt = attCnt > 0 ? p.attempts[0] : null;
      const dateStr = lastAttempt && lastAttempt.timestamp
        ? new Date(lastAttempt.timestamp).toLocaleDateString("vi-VN")
        : (p && p.docViewed ? "Đã đọc TL" : "—");
      let statusLabel = "Chưa học";
      let statusTone = "empty";
      if (passed) {
        statusLabel = "✓ Đạt chuẩn";
        statusTone = "done";
      } else if (attCnt > 0) {
        statusLabel = "Chưa đạt";
        statusTone = "failed";
      } else if (p && p.docViewed) {
        statusLabel = "Đang đọc TL";
        statusTone = "reading";
      }
      return {
        code: m.code || "HP",
        title: m.title || "",
        attCnt,
        best,
        thresh: Number(m.passThreshold || 80),
        statusLabel,
        statusTone,
        dateStr
      };
    });

    const completionPct = pubMods.length > 0 ? Math.round((passedCount * 100) / pubMods.length) : 0;
    const avgScore = attemptedMods > 0 ? Math.round(sumBest / attemptedMods) : 0;
    const rankLabel = (passedCount === pubMods.length && pubMods.length > 0)
      ? (avgScore >= 90 ? "Hoàn thành Xuất sắc" : "Đạt chuẩn Toàn khóa")
      : (attemptedMods > 0 ? "Đang tiến hành" : "Chưa bắt đầu");

    const scale = 2;
    const width = 920;
    const headerH = 128;
    const infoCardH = 108;
    const tableHeadH = 44;
    const rowH = 58;
    const footerH = 74;
    const height = headerH + 18 + infoCardH + 18 + tableHeadH + rowsData.length * rowH + footerH;

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    // Background
    ctx.fillStyle = "#FFFBF5";
    ctx.fillRect(0, 0, width, height);

    // Top Header Banner (Bright Fresh NovaStars Orange)
    const grad = ctx.createLinearGradient(0, 0, width, headerH);
    grad.addColorStop(0, "#EA580C");
    grad.addColorStop(1, "#F97316");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, headerH);

    // NS Logo Pill
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath();
    ctx.roundRect(28, 24, 52, 52, 12);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "800 22px 'Plus Jakarta Sans', 'Be Vietnam Pro', sans-serif";
    ctx.fillText("NS", 38, 58);

    ctx.fillStyle = "#FFEDD5";
    ctx.font = "700 12px 'Be Vietnam Pro', sans-serif";
    ctx.fillText("NOVASTARS EDUCATION · HỆ THỐNG ĐÀO TẠO CẨM NANG TƯ VẤN MẦM NON CHUYỂN GIAO", 94, 41);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "800 23px 'Plus Jakarta Sans', 'Be Vietnam Pro', sans-serif";
    ctx.fillText("BÁO CÁO KẾT QUẢ HỌC TẬP CỦA HỌC VIÊN", 94, 72);

    const exportedAtStr = new Date().toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });
    ctx.fillStyle = "#FFF7ED";
    ctx.font = "600 12.5px 'Be Vietnam Pro', sans-serif";
    ctx.fillText(`Ngày xuất báo cáo: ${exportedAtStr}   ·   Điểm chuẩn đạt mỗi học phần: >= ${(db.meta && db.meta.defaultPassThreshold) || 80}%`, 94, 100);

    // Student Identity + 4 KPI Summary Strip
    const padX = 28;
    const cardY = headerH + 16;
    const cardW = width - padX * 2;

    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "#FED7AA";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(padX, cardY, cardW, infoCardH, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#9A3412";
    ctx.font = "700 11.5px 'Be Vietnam Pro', sans-serif";
    ctx.fillText("HỌ VÀ TÊN HỌC VIÊN", padX + 20, cardY + 26);

    ctx.fillStyle = "#0F172A";
    ctx.font = "800 22px 'Plus Jakarta Sans', 'Be Vietnam Pro', sans-serif";
    ctx.fillText(sale.name, padX + 20, cardY + 56);

    ctx.fillStyle = "#64748B";
    ctx.font = "600 12.5px 'Be Vietnam Pro', sans-serif";
    ctx.fillText(`${sale.title || "Học Viên"} · Mã PIN: ${sale.pin}`, padX + 20, cardY + 84);

    // Right 3 KPI Summary Tiles inside identity strip
    const tiles = [
      { label: "HOÀN THÀNH", val: `${passedCount}/${pubMods.length} bài (${completionPct}%)`, color: "#059669", bg: "#ECFDF5" },
      { label: "ĐIỂM TB CAO NHẤT", val: attemptedMods > 0 ? `${avgScore}% (${totalAttempts} lượt)` : "Chưa thi", color: "#EA580C", bg: "#FFF7ED" },
      { label: "ĐÁNH GIÁ", val: rankLabel, color: passedCount === pubMods.length ? "#059669" : "#D97706", bg: "#FFFBEB" }
    ];
    let tileX = padX + 355;
    const tileW = 162;
    tiles.forEach(t => {
      ctx.fillStyle = t.bg;
      ctx.beginPath();
      ctx.roundRect(tileX, cardY + 16, tileW, infoCardH - 32, 10);
      ctx.fill();
      ctx.fillStyle = "#64748B";
      ctx.font = "800 10.5px 'Be Vietnam Pro', sans-serif";
      ctx.fillText(t.label, tileX + 12, cardY + 36);
      ctx.fillStyle = t.color;
      ctx.font = "800 14.5px 'Plus Jakarta Sans', 'Be Vietnam Pro', sans-serif";
      ctx.fillText(t.val, tileX + 12, cardY + 64);
      tileX += tileW + 10;
    });

    // Module Table
    let curY = cardY + infoCardH + 18;
    ctx.fillStyle = "#9A3412";
    ctx.beginPath();
    ctx.roundRect(padX, curY, cardW, tableHeadH, [10, 10, 0, 0]);
    ctx.fill();

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "700 12.5px 'Be Vietnam Pro', sans-serif";
    ctx.fillText("MÃ", padX + 16, curY + 27);
    ctx.fillText("TÊN HỌC PHẦN ĐÀO TẠO", padX + 86, curY + 27);
    ctx.fillText("SỐ LẦN THI", padX + 518, curY + 27);
    ctx.fillText("ĐIỂM CAO NHẤT", padX + 616, curY + 27);
    ctx.fillText("TRẠNG THÁI", padX + 744, curY + 27);

    curY += tableHeadH;

    rowsData.forEach((r, idx) => {
      ctx.fillStyle = idx % 2 === 0 ? "#FFFFFF" : "#FFFDF9";
      ctx.fillRect(padX, curY, cardW, rowH);
      ctx.strokeStyle = "#FFEDD5";
      ctx.lineWidth = 1;
      ctx.strokeRect(padX, curY, cardW, rowH);

      // Module code badge
      ctx.fillStyle = "#FFF7ED";
      ctx.beginPath();
      ctx.roundRect(padX + 14, curY + 15, 56, 26, 6);
      ctx.fill();
      ctx.fillStyle = "#EA580C";
      ctx.font = "800 12.5px 'JetBrains Mono', monospace";
      ctx.fillText(r.code, padX + 24, curY + 33);

      // Module Title (up to 2 lines)
      ctx.fillStyle = "#0F172A";
      ctx.font = "700 13px 'Be Vietnam Pro', sans-serif";
      const titleLines = wrapCanvasTextLines(ctx, r.title, 412, 2);
      if (titleLines.length === 1) {
        ctx.fillText(titleLines[0], padX + 86, curY + 34);
      } else {
        ctx.fillText(titleLines[0], padX + 86, curY + 24);
        ctx.fillText(titleLines[1], padX + 86, curY + 42);
      }

      // Attempt count
      ctx.fillStyle = "#334155";
      ctx.font = "700 13.5px 'Be Vietnam Pro', sans-serif";
      ctx.fillText(r.attCnt > 0 ? `${r.attCnt} lần` : "0 lần", padX + 532, curY + 34);

      // Best Score
      if (r.best !== null) {
        ctx.fillStyle = r.statusTone === "done" ? "#059669" : "#D97706";
        ctx.font = "800 16px 'JetBrains Mono', monospace";
        ctx.fillText(`${r.best}%`, padX + 634, curY + 34);
      } else {
        ctx.fillStyle = "#94A3B8";
        ctx.font = "600 13px 'Be Vietnam Pro', sans-serif";
        ctx.fillText("Chưa thi", padX + 632, curY + 34);
      }

      // Status Pill + Date
      const pillBg = r.statusTone === "done" ? "#ECFDF5" : (r.statusTone === "failed" ? "#FEF3C7" : (r.statusTone === "reading" ? "#EFF6FF" : "#F1F5F9"));
      const pillFg = r.statusTone === "done" ? "#065F46" : (r.statusTone === "failed" ? "#92400E" : (r.statusTone === "reading" ? "#1D4ED8" : "#64748B"));
      ctx.fillStyle = pillBg;
      ctx.beginPath();
      ctx.roundRect(padX + 742, curY + 11, 108, 24, 99);
      ctx.fill();
      ctx.fillStyle = pillFg;
      ctx.font = "700 11.5px 'Be Vietnam Pro', sans-serif";
      ctx.fillText(r.statusLabel, padX + 754, curY + 27);

      ctx.fillStyle = "#64748B";
      ctx.font = "500 10.5px 'Be Vietnam Pro', sans-serif";
      ctx.fillText(`Cập nhật: ${r.dateStr}`, padX + 746, curY + 49);

      curY += rowH;
    });

    // Footer Note
    const remainingMods = rowsData.filter(r => r.statusTone !== "done").map(r => r.code);
    const footerText = remainingMods.length === 0
      ? `✓ Chúc mừng ${sale.name} đã hoàn thành Đạt 100% tất cả ${pubMods.length} học phần đào tạo!`
      : `Ghi chú theo dõi: Cần hoàn thành đạt chuẩn (>=80%) các học phần còn lại: ${remainingMods.join(", ")}.`;
    ctx.fillStyle = remainingMods.length === 0 ? "#065F46" : "#9A3412";
    ctx.font = "700 13px 'Be Vietnam Pro', sans-serif";
    ctx.fillText(footerText, padX, curY + 34);

    ctx.fillStyle = "#64748B";
    ctx.font = "500 11.5px 'Be Vietnam Pro', sans-serif";
    ctx.fillText("Hệ thống Đào tạo & Kiểm tra Năng lực Tư vấn Novastars — Báo cáo tổng hợp tự động.", padX, curY + 56);

    return { canvas, sale };
  }

  function openLearnerReportImageModal(saleId) {
    const built = buildLearnerReportCanvas(saleId);
    if (!built) return;
    const { canvas, sale } = built;
    const dataUrl = canvas.toDataURL("image/png");
    const dlg = document.getElementById("learnerReportDialog");
    const imgEl = document.getElementById("learnerReportPreviewImg");
    const titleEl = document.getElementById("learnerReportDialogTitle");
    const btnDownload = document.getElementById("btnDownloadLearnerReportPng");
    const btnCopy = document.getElementById("btnCopyLearnerReportImg");

    if (titleEl) titleEl.textContent = `Báo cáo Kết quả Học tập — ${sale.name}`;
    if (imgEl) imgEl.src = dataUrl;

    if (btnDownload) {
      btnDownload.onclick = () => {
        const a = document.createElement("a");
        const safeName = (sale.name || "HocVien").replace(/\s+/g, "_");
        a.href = dataUrl;
        a.download = `Bao_cao_hoc_tap_${safeName}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    }

    if (btnCopy) {
      btnCopy.onclick = () => {
        const orig = btnCopy.textContent;
        canvas.toBlob(async blob => {
          if (!blob) return;
          try {
            if (navigator.clipboard && window.ClipboardItem) {
              await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
              btnCopy.textContent = "✓ Đã copy Ảnh! Dán (Ctrl+V) vào Zalo";
              setTimeout(() => { btnCopy.textContent = orig; }, 3000);
              return;
            }
          } catch (e) {}
          alert("Trình duyệt không hỗ trợ copy ảnh trực tiếp. Vui lòng bấm nút 'Tải ảnh (.png)' bên cạnh nhé!");
        }, "image/png");
      };
    }

    if (dlg) dlg.showModal();
  }

  function renderAdminDossierPanel(sales, pubMods, targetContainerId = "adminPanelDossier") {
    const panel = document.getElementById(targetContainerId);
    if (!panel) return;
    if (!activeDossierSaleId || !sales.some(s => s.id === activeDossierSaleId)) {
      activeDossierSaleId = sales[0] ? sales[0].id : null;
    }
    const sale = sales.find(s => s.id === activeDossierSaleId);
    if (!sale) {
      panel.innerHTML = `<div class="admin-card">Chưa có Học Viên nào trong danh sách.</div>`;
      return;
    }

    const pillsHtml = sales.map(s => {
      const pCount = pubMods.filter(m => {
        const pr = (db.progress || []).find(p => p.userId === s.id && p.moduleId === m.id);
        return pr && pr.passed;
      }).length;
      return `
        <button type="button" class="dossier-user-pill ${s.id === sale.id ? 'active' : ''}" data-dossier-sale="${escapeHtml(s.id)}">
          ${escapeHtml(s.name)}
          <span class="sidebar-count-badge">${pCount}/${pubMods.length}</span>
        </button>
      `;
    }).join("");

    const modRowsHtml = pubMods.map(m => {
      const p = (db.progress || []).find(pr => pr.userId === sale.id && pr.moduleId === m.id);
      const attCnt = (p && Array.isArray(p.attempts)) ? p.attempts.length : 0;
      const statusBadge = (p && p.passed)
        ? `<span class="sidebar-item-status done">✓ Đã đạt (${p.bestScore}%)</span>`
        : (attCnt > 0
          ? `<span class="sidebar-item-status failed">Chưa đạt (${p.bestScore}%)</span>`
          : (p && p.docViewed ? `<span class="sidebar-item-status reading">Đang đọc tài liệu</span>` : `<span class="sidebar-item-status empty">Chưa học</span>`));

      return `
        <tr>
          <td>
            <div><strong>${escapeHtml(m.code)}</strong> — ${escapeHtml(m.title)}</div>
            <span class="admin-mod-author-sub">Tác giả: ${escapeHtml(m.authorName || "Đào tạo")}</span>
          </td>
          <td>${statusBadge}</td>
          <td><strong>${attCnt > 0 ? `${p.bestScore}%` : "—"}</strong> (Chuẩn &ge;${m.passThreshold || 80}%)</td>
          <td>${attCnt} lần</td>
          <td>
            <button type="button" class="btn-row-act" data-dossier-inspect="${escapeHtml(m.id)}">Xem bài làm</button>
          </td>
        </tr>
      `;
    }).join("");

    panel.innerHTML = `
      <div class="admin-card">
        <div class="dossier-selector-bar">${pillsHtml}</div>
        <div class="admin-card-head" style="padding-top:8px;border-top:1px solid #FFEDD5;">
          <div>
            <h2 class="admin-title">Hồ sơ Đào tạo: ${escapeHtml(sale.name)} (Mã PIN: <code>${escapeHtml(sale.pin)}</code>)</h2>
            <p class="admin-sub">Theo dõi tiến độ đọc tài liệu và lịch sử điểm trắc nghiệm ở từng học phần.</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn-primary" id="btnDossierExportReportImg" style="background:linear-gradient(135deg,#059669,#10B981);box-shadow:0 3px 10px rgba(16,185,129,0.28);">
              Xuất Báo cáo Học tập (Ảnh PNG)
            </button>
            <button type="button" class="btn-secondary" id="btnDossierActAsSale">Xem dưới quyền ${escapeHtml(sale.name)}</button>
          </div>
        </div>
        <div class="table-responsive">
          <table class="progress-matrix-table">
            <thead>
              <tr>
                <th>Học phần đào tạo</th>
                <th>Trạng thái</th>
                <th>Điểm cao nhất</th>
                <th>Số lần thi</th>
                <th>Chi tiết</th>
              </tr>
            </thead>
            <tbody>${modRowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    panel.querySelectorAll("[data-dossier-sale]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeDossierSaleId = btn.dataset.dossierSale;
        renderAdminDossierPanel(sales, pubMods, targetContainerId);
      });
    });

    panel.querySelectorAll("[data-dossier-inspect]").forEach(btn => {
      btn.addEventListener("click", () => {
        openQuickInspectSaleModal(sale.id, btn.dataset.dossierInspect);
      });
    });

    const btnExpImg = document.getElementById("btnDossierExportReportImg");
    if (btnExpImg) {
      btnExpImg.onclick = () => openLearnerReportImageModal(sale.id);
    }

    document.getElementById("btnDossierActAsSale").onclick = () => {
      impersonatedSaleUser = sale;
      activeWorkspaceView = "sale";
      resetActiveQuizState();
      renderAll();
    };
  }

  function renderAdminAnalyticsPanel(sales, pubMods) {
    const panel = document.getElementById("adminPanelAnalytics");
    if (!activeAnalyticsModuleId || !pubMods.some(m => m.id === activeAnalyticsModuleId)) {
      activeAnalyticsModuleId = pubMods[0] ? pubMods[0].id : null;
    }
    const mod = pubMods.find(m => m.id === activeAnalyticsModuleId);
    if (!mod) {
      panel.innerHTML = `<div class="admin-card">Chưa có học phần nào.</div>`;
      return;
    }

    const modPills = pubMods.map(m => `
      <button type="button" class="dossier-user-pill ${m.id === mod.id ? 'active' : ''}" data-analytics-mod="${escapeHtml(m.id)}">
        ${escapeHtml(m.code)} (${(m.questions || []).length} câu)
      </button>
    `).join("");

    const qList = mod.questions || [];
    const letters = ["A", "B", "C", "D"];

    const qRows = qList.map((q, idx) => {
      let totalAnswered = 0;
      let rightCount = 0;
      sales.forEach(s => {
        const p = (db.progress || []).find(pr => pr.userId === s.id && pr.moduleId === mod.id);
        if (p && Array.isArray(p.attempts) && p.attempts.length > 0) {
          const latest = p.attempts[0];
          if (latest.answers && latest.answers[q.id] !== undefined) {
            totalAnswered++;
            if (latest.answers[q.id] === Number(q.correctIndex)) rightCount++;
          }
        }
      });
      const rate = totalAnswered > 0 ? Math.round((rightCount * 100) / totalAnswered) : null;
      return `
        <tr>
          <td style="text-align:center;font-weight:700;">Câu ${idx + 1}</td>
          <td><span class="qq-cat-badge ${escapeHtml(q.category || 'kien_thuc')}">${escapeHtml(q.categoryLabel || getCategoryLabel(q.category))}</span></td>
          <td>
            <strong>${escapeHtml(q.question)}</strong>
            <div style="font-size:12px;color:#065F46;margin-top:3px;">✓ Đáp án đúng (${letters[q.correctIndex]}): ${escapeHtml(q.options[q.correctIndex] || "")}</div>
          </td>
          <td style="text-align:center;">
            ${rate !== null
              ? `<span class="sidebar-item-status ${rate >= 70 ? 'done' : 'failed'}">${rightCount}/${totalAnswered} Học Viên đúng (${rate}%)</span>`
              : `<span class="sidebar-item-status empty">Chưa có dữ liệu thi</span>`}
          </td>
        </tr>
      `;
    }).join("");

    panel.innerHTML = `
      <div class="admin-card">
        <div class="dossier-selector-bar">${modPills}</div>
        <div class="admin-card-head" style="padding-top:8px;border-top:1px solid #FFEDD5;">
          <div>
            <h2 class="admin-title">Phân tích Câu hỏi Trắc nghiệm — ${escapeHtml(mod.code)}: ${escapeHtml(mod.title)}</h2>
            <p class="admin-sub">Tác giả học phần: <strong>${escapeHtml(mod.authorName || "Đào tạo")}</strong> · Giúp Quản lý nắm được câu hỏi nào Sale trả lời tốt và kiến thức nào Sale hay nhầm lẫn.</p>
          </div>
          <button type="button" class="btn-primary" id="btnAnalyticsEditQuiz">Chỉnh sửa bộ câu hỏi này</button>
        </div>
        <div class="table-responsive">
          <table class="progress-matrix-table">
            <thead>
              <tr>
                <th style="width:70px;text-align:center;">Câu</th>
                <th style="width:170px;">Nhóm tiêu chí</th>
                <th>Nội dung câu hỏi &amp; Đáp án chuẩn</th>
                <th style="width:175px;text-align:center;">Tỷ lệ Học Viên làm đúng</th>
              </tr>
            </thead>
            <tbody>${qRows}</tbody>
          </table>
        </div>
      </div>
    `;

    panel.querySelectorAll("[data-analytics-mod]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeAnalyticsModuleId = btn.dataset.analyticsMod;
        renderAdminAnalyticsPanel(sales, pubMods);
      });
    });

    document.getElementById("btnAnalyticsEditQuiz").onclick = () => {
      currentModuleId = mod.id;
      activeWorkspaceView = "uploader";
      activeUploaderTab = "quiz";
      renderAll();
    };
  }

  // =========================================================================
  // MANAGE USERS, PIN CARD IMAGE GENERATOR & UPLOAD HANDLERS
  // =========================================================================
  let editingUserId = null;

  function renderManageUsersModal() {
    const saleBox = document.getElementById("manageSaleList");
    const upBox = document.getElementById("manageUploaderList");
    if (!saleBox || !upBox) return;

    function renderRoleList(container, roleName) {
      container.innerHTML = "";
      const list = (db.users || []).filter(u => u.role === roleName);
      list.forEach(u => {
        const row = document.createElement("div");
        row.className = "manage-item-row";

        if (editingUserId === u.id) {
          row.innerHTML = `
            <div class="inline-edit-group">
              <input type="text" class="inline-edit-input" data-edit-u-name value="${escapeHtml(u.name)}" placeholder="Họ và tên">
              <input type="text" class="inline-edit-input mono-input" data-edit-u-pin value="${escapeHtml(u.pin)}" placeholder="PIN" style="max-width:90px;">
              <button type="button" class="btn-row-act save" data-save-u>✓ Xong</button>
            </div>
          `;
          const nameInp = row.querySelector("[data-edit-u-name]");
          const pinInp = row.querySelector("[data-edit-u-pin]");

          // Auto-save live on every keystroke so pressing F5 or closing never loses edits
          const applyLiveEdit = () => {
            const newName = nameInp.value.trim();
            const newPin = pinInp.value.trim();
            if (newName) u.name = newName;
            if (newPin) u.pin = newPin;
            triggerAutoSave(true, true);
            populateAuthSelects();
          };
          nameInp.addEventListener("input", applyLiveEdit);
          pinInp.addEventListener("input", applyLiveEdit);

          const finishEdit = () => {
            applyLiveEdit();
            editingUserId = null;
            renderManageUsersModal();
            renderAll();
          };
          row.querySelector("[data-save-u]").onclick = finishEdit;
          nameInp.addEventListener("keydown", e => {
            if (e.key === "Enter") {
              e.preventDefault();
              finishEdit();
            }
          });
          pinInp.addEventListener("keydown", e => {
            if (e.key === "Enter") {
              e.preventDefault();
              finishEdit();
            }
          });
        } else {
          const switchLabel = roleName === "sale" ? "Chuyển sang Đào tạo" : "Chuyển sang Học Viên";
          row.innerHTML = `
            <div><strong>${escapeHtml(u.name)}</strong> — Mã PIN: <code>${escapeHtml(u.pin)}</code></div>
            <div class="manage-row-actions">
              <button type="button" class="btn-row-act" data-switch-role-u="${escapeHtml(u.id)}">${switchLabel}</button>
              <button type="button" class="btn-row-act" data-edit-u="${escapeHtml(u.id)}">Sửa tên / PIN</button>
              <button type="button" class="btn-row-act danger" data-del-u="${escapeHtml(u.id)}">Xóa</button>
            </div>
          `;
          row.querySelector("[data-switch-role-u]").onclick = () => {
            u.role = roleName === "sale" ? "uploader" : "sale";
            u.title = u.role === "uploader" ? "Phụ trách Nội dung & Đào tạo" : "Học Viên";
            triggerAutoSave(true, true);
            renderManageUsersModal();
            populateAuthSelects();
            renderAll();
          };
          row.querySelector("[data-edit-u]").onclick = () => {
            editingUserId = u.id;
            renderManageUsersModal();
          };
          row.querySelector("[data-del-u]").onclick = () => {
            if (list.length <= 1) {
              alert("Cần giữ lại ít nhất 1 tài khoản trong nhóm này.");
              return;
            }
            if (confirm(`Xóa tài khoản "${u.name}"?`)) {
              db.users = (db.users || []).filter(item => item.id !== u.id);
              triggerAutoSave(true, true);
              renderManageUsersModal();
              populateAuthSelects();
              renderAll();
            }
          };
        }
        container.appendChild(row);
      });
    }

    renderRoleList(saleBox, "sale");
    renderRoleList(upBox, "uploader");

    document.getElementById("settingAdminPin").value = (db.meta && db.meta.adminPin) ? db.meta.adminPin : "Nvs123456";
    document.getElementById("settingDefaultThreshold").value = (db.meta && db.meta.defaultPassThreshold) ? db.meta.defaultPassThreshold : 80;
  }

  function buildPinCardCanvas() {
    const users = db.users || [];
    const scale = 2;
    const width = 700;
    const rowH = 44;
    const headerH = 126;
    const tableHeadH = 42;
    const footerH = 54;
    const height = headerH + tableHeadH + users.length * rowH + footerH;

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    ctx.fillStyle = "#FFFBF5";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#9A3412";
    ctx.fillRect(0, 0, width, headerH);

    ctx.fillStyle = "#FB7185";
    ctx.font = "bold 13px 'Be Vietnam Pro', sans-serif";
    ctx.fillText("NOVASTARS · CẨM NANG TƯ VẤN MẦM NON CHUYỂN GIAO", 28, 34);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 21px 'Plus Jakarta Sans', 'Be Vietnam Pro', sans-serif";
    ctx.fillText("BẢNG TÀI KHOẢN & MÃ PIN ĐĂNG NHẬP", 28, 68);

    ctx.fillStyle = "#FED7AA";
    ctx.font = "600 13.5px 'JetBrains Mono', monospace";
    ctx.fillText("🔗 Link web: " + (window.location.origin + window.location.pathname), 28, 100);

    const tableX = 24;
    const tableW = width - 48;
    let curY = headerH + 12;

    ctx.fillStyle = "#EA580C";
    ctx.fillRect(tableX, curY, tableW, tableHeadH);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 13.5px 'Be Vietnam Pro', sans-serif";
    ctx.fillText("STT", tableX + 16, curY + 26);
    ctx.fillText("Họ và tên nhân sự", tableX + 70, curY + 26);
    ctx.fillText("Vai trò trên App", tableX + 330, curY + 26);
    ctx.fillText("Mã PIN", tableX + 530, curY + 26);

    curY += tableHeadH;

    users.forEach((u, idx) => {
      ctx.fillStyle = idx % 2 === 0 ? "#FFFFFF" : "#FFF1F2";
      ctx.fillRect(tableX, curY, tableW, rowH);
      ctx.strokeStyle = "#FED7AA";
      ctx.strokeRect(tableX, curY, tableW, rowH);

      ctx.fillStyle = "#9A3412";
      ctx.font = "bold 13.5px 'JetBrains Mono', monospace";
      ctx.fillText(String(idx + 1), tableX + 20, curY + 27);

      ctx.fillStyle = "#1E293B";
      ctx.font = "bold 14.5px 'Be Vietnam Pro', sans-serif";
      ctx.fillText(u.name, tableX + 70, curY + 27);

      ctx.fillStyle = u.role === "uploader" ? "#3730A3" : "#065F46";
      ctx.font = "600 13px 'Be Vietnam Pro', sans-serif";
      ctx.fillText(u.role === "uploader" ? "Đào tạo" : "Học Viên", tableX + 330, curY + 27);

      ctx.fillStyle = "#EA580C";
      ctx.font = "bold 15.5px 'JetBrains Mono', monospace";
      ctx.fillText(u.pin, tableX + 535, curY + 27);

      curY += rowH;
    });

    ctx.fillStyle = "#475569";
    ctx.font = "500 12.5px 'Be Vietnam Pro', sans-serif";
    ctx.fillText("Mở link web → Chọn đúng tab Vai trò → Chọn tên của bạn và nhập Mã PIN 4 số.", 28, curY + 28);

    return canvas;
  }

  async function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const res = String(reader.result || "");
        const b64 = res.includes(",") ? res.split(",")[1] : res;
        resolve(b64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function parseDocxOrXlsxInBrowser(file) {
    const fname = (file.name || "").toLowerCase();
    const parser = new DOMParser();

    if (fname.endsWith(".docx")) {
      if (!window.JSZip) return null;
      const zip = await window.JSZip.loadAsync(file);
      const docXmlFile = zip.file("word/document.xml");
      if (!docXmlFile) return null;
      const xmlStr = await docXmlFile.async("string");
      const xmlDoc = parser.parseFromString(xmlStr, "application/xml");
      const lines = [];
      const tables = [];

      function extractParagraphTextWithMarkers(pNode) {
        let pText = "";
        let hasEmph = false;
        const rNodes = pNode.getElementsByTagName("w:r");
        if (rNodes.length > 0) {
          for (let r = 0; r < rNodes.length; r++) {
            const rNode = rNodes[r];
            const rPr = rNode.getElementsByTagName("w:rPr")[0];
            if (rPr) {
              const bEl = rPr.getElementsByTagName("w:b")[0];
              const uEl = rPr.getElementsByTagName("w:u")[0];
              const hlEl = rPr.getElementsByTagName("w:highlight")[0];
              const colEl = rPr.getElementsByTagName("w:color")[0];
              const bVal = bEl ? (bEl.getAttribute("w:val") || "true") : "";
              const uVal = uEl ? (uEl.getAttribute("w:val") || "single") : "";
              const colVal = colEl ? (colEl.getAttribute("w:val") || "").toUpperCase() : "";
              if (
                (bEl && bVal !== "0" && bVal !== "false") ||
                (uEl && uVal !== "none" && uVal !== "0" && uVal !== "false") ||
                hlEl ||
                (colVal && colVal !== "000000" && colVal !== "AUTO")
              ) {
                hasEmph = true;
              }
            }
            Array.from(rNode.childNodes).forEach(ch => {
              const cLocal = ch.nodeName.replace(/^.*:/, "");
              if (cLocal === "t") pText += ch.textContent || "";
              else if (cLocal === "br" || cLocal === "cr") pText += "\n";
              else if (cLocal === "tab") pText += "  ";
            });
          }
        } else {
          const tNodes = pNode.getElementsByTagName("w:t");
          for (let i = 0; i < tNodes.length; i++) pText += tNodes[i].textContent || "";
        }
        const trimmed = pText.trim();
        if (hasEmph && /^[-*•]?\s*[A-D][.:)\-]\s+/i.test(trimmed) && !/\(Đáp án đúng\)|\(Đúng\)/i.test(trimmed)) {
          return trimmed + " (Đáp án đúng)";
        }
        return trimmed;
      }

      const body = xmlDoc.getElementsByTagName("w:body")[0] || xmlDoc.documentElement;
      Array.from(body.childNodes).forEach(node => {
        const local = node.nodeName.replace(/^.*:/, "");
        if (local === "p") {
          const pText = extractParagraphTextWithMarkers(node);
          if (pText) lines.push(pText);
        } else if (local === "tbl") {
          const rows = [];
          const trNodes = node.getElementsByTagName("w:tr");
          for (let r = 0; r < trNodes.length; r++) {
            const cells = [];
            const tcNodes = trNodes[r].getElementsByTagName("w:tc");
            for (let c = 0; c < tcNodes.length; c++) {
              const pNodes = tcNodes[c].getElementsByTagName("w:p");
              const cellParas = [];
              for (let p = 0; p < pNodes.length; p++) {
                const pt = extractParagraphTextWithMarkers(pNodes[p]);
                if (pt) cellParas.push(pt);
              }
              cells.push(cellParas.join("\n"));
            }
            if (cells.some(Boolean)) {
              rows.push(cells);
              lines.push(cells.join(" | "));
            }
          }
          if (rows.length > 0) tables.push({ sheet: "Bảng trong Word", rows });
        } else {
          // Handle nested paragraphs inside content controls (w:sdt, etc.)
          const nestedPs = node.getElementsByTagName ? node.getElementsByTagName("w:p") : [];
          for (let np = 0; np < nestedPs.length; np++) {
            const pt = extractParagraphTextWithMarkers(nestedPs[np]);
            if (pt) lines.push(pt);
          }
        }
      });
      return { text: lines.join("\n"), tables };
    }

    if (fname.endsWith(".xlsx") || fname.endsWith(".xls") || fname.endsWith(".ods")) {
      // 1. Primary Excel parser using SheetJS (window.XLSX) — supports .xlsx, .xls (97-2003), .ods, formulas, merged cells
      if (window.XLSX) {
        try {
          const ab = await file.arrayBuffer();
          const wb = window.XLSX.read(ab, { type: "array" });
          const lines = [];
          const tables = [];
          (wb.SheetNames || []).forEach(sName => {
            const ws = wb.Sheets[sName];
            if (!ws) return;
            const rawRows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
            const rows = [];
            lines.push(`=== SHEET: ${sName} ===`);
            rawRows.forEach(rArr => {
              if (!Array.isArray(rArr)) return;
              const vals = rArr.map(c => String(c == null ? "" : c).trim());
              if (vals.some(Boolean)) {
                rows.push(vals);
                lines.push(vals.filter(Boolean).join("\n"));
              }
            });
            if (rows.length > 0) tables.push({ sheet: sName, rows });
          });
          if (tables.length > 0 || lines.length > 1) {
            return { text: lines.join("\n"), tables };
          }
        } catch (xlsxErr) {}
      }

      if (!window.JSZip) return null;
      const zip = await window.JSZip.loadAsync(file);
      const sharedStrings = [];
      const ssFile = zip.file("xl/sharedStrings.xml");
      if (ssFile) {
        const ssXml = parser.parseFromString(await ssFile.async("string"), "application/xml");
        const siNodes = ssXml.getElementsByTagName("si");
        for (let i = 0; i < siNodes.length; i++) {
          const tNodes = siNodes[i].getElementsByTagName("t");
          let sVal = "";
          for (let j = 0; j < tNodes.length; j++) sVal += tNodes[j].textContent || "";
          sharedStrings.push(sVal);
        }
      }
      const sheetNames = [];
      const wbFile = zip.file("xl/workbook.xml");
      if (wbFile) {
        const wbXml = parser.parseFromString(await wbFile.async("string"), "application/xml");
        const shNodes = wbXml.getElementsByTagName("sheet");
        for (let i = 0; i < shNodes.length; i++) {
          sheetNames.push(shNodes[i].getAttribute("name") || `Sheet ${i + 1}`);
        }
      }
      const sheetFiles = Object.keys(zip.files)
        .filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
        .sort((a, b) => {
          const na = Number((a.match(/sheet(\d+)/) || [])[1] || 0);
          const nb = Number((b.match(/sheet(\d+)/) || [])[1] || 0);
          return na - nb;
        });

      const lines = [];
      const tables = [];
      for (let idx = 0; idx < sheetFiles.length; idx++) {
        const sName = sheetNames[idx] || `Sheet ${idx + 1}`;
        const wsXml = parser.parseFromString(await zip.file(sheetFiles[idx]).async("string"), "application/xml");
        const rowNodes = wsXml.getElementsByTagName("row");
        const rows = [];
        lines.push(`=== SHEET: ${sName} ===`);

        function colRefToIdx(refStr, fallbackIdx) {
          const m = String(refStr || "").match(/^([A-Z]+)/i);
          if (!m) return fallbackIdx;
          const letters = m[1].toUpperCase();
          let colIdx = 0;
          for (let i = 0; i < letters.length; i++) {
            colIdx = colIdx * 26 + (letters.charCodeAt(i) - 64);
          }
          return Math.max(0, colIdx - 1);
        }

        for (let r = 0; r < rowNodes.length; r++) {
          const cNodes = rowNodes[r].getElementsByTagName("c");
          const vals = [];
          for (let c = 0; c < cNodes.length; c++) {
            const cEl = cNodes[c];
            const cType = cEl.getAttribute("t") || "";
            const cRef = cEl.getAttribute("r") || "";
            const targetIdx = colRefToIdx(cRef, vals.length);
            while (vals.length < targetIdx) vals.push("");
            const vEl = cEl.getElementsByTagName("v")[0];
            const isEl = cEl.getElementsByTagName("is")[0];
            let val = "";
            if (cType === "s" && vEl && vEl.textContent != null) {
              val = sharedStrings[Number(vEl.textContent)] || "";
            } else if (cType === "inlineStr" && isEl) {
              val = isEl.textContent || "";
            } else if (vEl && vEl.textContent != null) {
              val = vEl.textContent;
            }
            vals[targetIdx] = String(val).trim();
          }
          if (vals.some(Boolean)) {
            rows.push(vals);
            lines.push(vals.filter(Boolean).join("\n"));
          }
        }
        if (rows.length > 0) tables.push({ sheet: sName, rows });
      }
      return { text: lines.join("\n"), tables };
    }
    return null;
  }

  async function extractFileContentViaBackendOrFallback(file) {
    const fname = (file.name || "").toLowerCase();
    try {
      const b64 = await readFileAsBase64(file);
      const res = await fetch("/api/extract-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentBase64: b64 })
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && ((data.text && String(data.text).trim().length > 0) || (Array.isArray(data.tables) && data.tables.length > 0))) {
          return { text: data.text || "", tables: data.tables || [] };
        }
      }
    } catch (e) {}

    // Client-side parser for .docx, .xlsx, .xls, .ods (works on both Node server & static hosts like GitHub Pages)
    try {
      if (fname.endsWith(".docx") || fname.endsWith(".xlsx") || fname.endsWith(".xls") || fname.endsWith(".ods")) {
        const parsed = await parseDocxOrXlsxInBrowser(file);
        if (parsed && (parsed.text || (parsed.tables && parsed.tables.length > 0))) {
          return parsed;
        }
      }
    } catch (e) {}

    // Client-side fallback for text/csv/md/json
    if (fname.endsWith(".txt") || fname.endsWith(".md") || fname.endsWith(".csv") || fname.endsWith(".json")) {
      const txt = await file.text();
      const tables = [];
      if (fname.endsWith(".csv")) {
        const rows = txt.split(/\r?\n/).filter(Boolean).map(line => line.split(",").map(c => c.replace(/^"|"$/g, "").trim()));
        if (rows.length > 0) tables.push({ sheet: file.name, rows });
      }
      return { text: txt, tables };
    }
    return { text: `[Đã tải lên file: ${file.name}]`, tables: [] };
  }

  function computeNextModuleCode() {
    let maxNum = (db.modules || []).length;
    (db.modules || []).forEach(m => {
      const match = String(m.code || "").match(/(\d+)/);
      if (match) {
        const n = Number(match[1]);
        if (n > maxNum) maxNum = n;
      }
    });
    const nextNum = maxNum + 1;
    return nextNum < 10 ? `HP0${nextNum}` : `HP${nextNum}`;
  }

  function createNewModuleForCurrentUser(customTitle = "") {
    const code = computeNextModuleCode();
    const newMod = {
      id: `mod-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      code,
      category: "Chuyên đề Đào tạo mới",
      title: customTitle || `Học phần mới ${code}: Tài liệu Đào tạo`,
      subtitle: "Bối cảnh tư vấn Chủ trường và Hiệu trưởng trường mầm non",
      durationMinutes: 20,
      passThreshold: (db.meta && db.meta.defaultPassThreshold) || 80,
      status: (currentUser && currentUser.role === "admin") ? "published" : "pending",
      authorId: currentUser ? currentUser.id : "",
      authorName: currentUser ? currentUser.name : "Đào tạo",
      updatedAt: new Date().toISOString(),
      summaryPoints: [
        "Luận điểm trọng tâm 1 cần nhớ khi tư vấn Chủ trường / Hiệu trưởng.",
        "Luận điểm trọng tâm 2 về điểm khác biệt của chương trình Novastars."
      ],
      contentText: "",
      uploadedTables: [],
      questions: []
    };
    if (!Array.isArray(db.modules)) db.modules = [];
    db.modules.push(newMod);
    currentModuleId = newMod.id;
    activeWorkspaceView = "uploader";
    activeUploaderTab = "doc";
    const statusEl = document.getElementById("upDocFileStatus");
    if (statusEl) statusEl.classList.add("hidden");
    logUserActivity("create_module", "Tạo học phần mới", `${newMod.code}: ${newMod.title}`, newMod.code);
    triggerAutoSave(true, true);
    renderAll();
    const titleInp = document.getElementById("upModTitle");
    if (titleInp) {
      titleInp.focus();
      titleInp.select();
    }
    return newMod;
  }

  function setupUploaderAndAdminEvents() {
    // Create new module buttons (Sidebar, Topbar, and Read-Only Banner)
    ["btnSidebarCreateModule", "btnTopbarCreateNewModule", "btnBannerCreateNewModule"].forEach(btnId => {
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener("click", () => {
          createNewModuleForCurrentUser();
        });
      }
    });

    // Upload Document File (.docx, .xlsx, .pdf, .txt)
    const inpDocFile = document.getElementById("inputUploadDocFile");
    if (inpDocFile) {
      inpDocFile.addEventListener("change", async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        let mod = getCurrentModule();
        const baseFileTitle = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();

        // Safeguard: Never overwrite another author's module (e.g. HP01 created by Phạm Mỹ Linh)!
        const isCoreSeedModule = mod && ["mod-01-tong-quan", "mod-02-nen-tang-sp", "mod-03-10-bai-mau", "mod-04-lo-trinh-72-tiet"].includes(mod.id);
        if (!mod || !canCurrentUserEditModule(mod)) {
          mod = createNewModuleForCurrentUser(baseFileTitle);
        } else if (isCoreSeedModule) {
          const createNew = confirm(`Bạn đang đứng ở học phần gốc "${mod.code} — ${mod.title}".\n\nBấm OK để TẠO HỌC PHẦN MỚI cho file "${file.name}" (Khuyên dùng).\nBấm Cancel nếu bạn thực sự muốn ghi đè lên ${mod.code}.`);
          if (createNew) {
            mod = createNewModuleForCurrentUser(baseFileTitle);
          }
        }

        const statusEl = document.getElementById("upDocFileStatus");
        statusEl.classList.remove("hidden");
        statusEl.textContent = `Đang đọc và trích xuất nội dung từ file "${file.name}"...`;

        const extracted = await extractFileContentViaBackendOrFallback(file);
        mod.sourceFile = {
          name: file.name,
          type: file.name.split(".").pop().toLowerCase()
        };
        if (/^Học phần mới HP\d+/i.test(mod.title || "") && baseFileTitle) {
          mod.title = baseFileTitle;
          const titleInp = document.getElementById("upModTitle");
          if (titleInp) titleInp.value = mod.title;
        }
        if (extracted.text) {
          mod.contentText = extracted.text;
          document.getElementById("upModContentText").value = extracted.text;
          document.getElementById("lblDocCharCount").textContent = `${extracted.text.length.toLocaleString("vi-VN")} ký tự`;

          // Auto-fill summary points if empty
          const lines = extracted.text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 30 && !l.startsWith("==="));
          if (lines.length > 0 && (!mod.summaryPoints || mod.summaryPoints.length <= 2)) {
            mod.summaryPoints = lines.slice(0, 5).map(l => l.slice(0, 220));
            document.getElementById("upModSummaryPoints").value = mod.summaryPoints.join("\n");
          }
        }
        if (Array.isArray(extracted.tables) && extracted.tables.length > 0) {
          mod.uploadedTables = extracted.tables;
          mod.structuredType = ""; // Use uploadedTables rendering
        }

        if (!mod.authorId && currentUser) mod.authorId = currentUser.id;
        mod.authorName = currentUser ? currentUser.name : (mod.authorName || "Đào tạo");
        if (currentUser && currentUser.role === "uploader") {
          mod.status = "pending";
        }
        logUserActivity("upload_doc", "Tải file tài liệu lên học phần", `File: ${file.name} (${(extracted.text || "").length} ký tự)`, mod.code);
        statusEl.innerHTML = `✓ Đã bóc tách thành công tài liệu <strong>${escapeHtml(file.name)}</strong> vào học phần <strong>${escapeHtml(mod.code)}</strong> (${(extracted.text || "").length.toLocaleString("vi-VN")} ký tự, ${(extracted.tables || []).length} bảng dữ liệu). Bạn có thể chuyển sang Bước 2 để tạo bộ câu hỏi trắc nghiệm ngay!`;
        triggerAutoSave(true, true);
        renderUploaderWorkspace();
        renderSidebar();
        inpDocFile.value = "";
      });
    }

    // AI Quiz Converter Button
    const btnRunAi = document.getElementById("btnRunAiQuizConverter");
    if (btnRunAi) {
      btnRunAi.addEventListener("click", () => {
        const mod = getCurrentModule();
        if (!mod) return;
        syncUploaderDocFieldsToModule(mod);

        const rawCountVal = document.getElementById("selAiQuestionCount").value.trim();
        const count = rawCountVal ? Math.max(1, Number(rawCountVal)) : 0;
        const mode = document.getElementById("selAiMergeMode").value || "append";
        const newQuestions = generateQuizFromModuleDocument(mod, count);

        if (mode === "replace" || !Array.isArray(mod.questions)) {
          mod.questions = newQuestions;
        } else {
          mod.questions = mod.questions.concat(newQuestions);
        }

        triggerAutoSave(true, true);
        renderUploaderQuestionBank(mod);
        renderSidebar();
        alert(`Đã chuyển đổi tài liệu sang ${newQuestions.length} câu hỏi trắc nghiệm theo đúng 4 nhóm tiêu chí!\n\nBạn hãy xem trước và chỉnh sửa (nếu cần) ở danh sách bên dưới nhé.`);
      });
    }

    // Copy Prompt for Antigravity Chat
    const btnCopyPrompt = document.getElementById("btnCopyAntigravityPrompt");
    if (btnCopyPrompt) {
      btnCopyPrompt.addEventListener("click", async () => {
        const mod = getCurrentModule();
        if (!mod) return;
        syncUploaderDocFieldsToModule(mod);
        const text = mod.contentText || buildPlainTextFromStructuredData(mod);
        const promptPackage =
          `Hãy chuyển tài liệu đào tạo Sale dưới đây sang bộ câu hỏi trắc nghiệm 4 đáp án (A, B, C, D) theo đúng 4 nhóm tiêu chí (1. Cấu trúc chương trình, 2. Điểm khác biệt USP, 3. Dẫn chứng bài mẫu, 4. Xử lý tình huống) kèm Đáp án đúng và Giải thích & Gợi ý tư vấn:\n\n` +
          `TÊN HỌC PHẦN: ${mod.code} - ${mod.title}\n` +
          `NỘI DUNG TÀI LIỆU:\n${text}`;
        try {
          await navigator.clipboard.writeText(promptPackage);
          const orig = btnCopyPrompt.textContent;
          btnCopyPrompt.textContent = "✓ Đã copy! Dán vào chat Antigravity";
          setTimeout(() => { btnCopyPrompt.textContent = orig; }, 2500);
        } catch (e) {}
      });
    }

    // Import Existing Quiz File (.xlsx, .docx, .csv, .json, .txt)
    const inpQuizFile = document.getElementById("inputImportQuizFile");
    if (inpQuizFile) {
      inpQuizFile.addEventListener("change", async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        let mod = getCurrentModule();
        if (!mod || !canCurrentUserEditModule(mod)) {
          const ownMod = (db.modules || []).find(m => canCurrentUserEditModule(m));
          mod = ownMod || createNewModuleForCurrentUser(file.name.replace(/\.[^.]+$/, ""));
          currentModuleId = mod.id;
        }

        const extracted = await extractFileContentViaBackendOrFallback(file);
        let imported = parseImportedQuizTextOrTables(extracted.text, extracted.tables);
        if (imported.length === 0 && extracted.text && extracted.text.trim().length > 20) {
          // Fallback: auto-convert document/text blocks into 20 multiple-choice questions so a valid file never fails
          imported = generateQuizFromModuleDocument({
            id: mod.id,
            code: mod.code,
            title: mod.title || file.name,
            contentText: extracted.text,
            uploadedTables: extracted.tables || []
          }, 20);
        }
        inpQuizFile.value = "";

        if (imported.length === 0) {
          alert("Không tìm thấy nội dung câu hỏi trong file. Vui lòng kiểm tra lại file hoặc dùng nút 'Dán câu hỏi'.");
          return;
        }

        if (!Array.isArray(mod.questions)) mod.questions = [];
        mod.questions = mod.questions.concat(imported);
        logUserActivity("import_quiz", "Tải file câu hỏi trắc nghiệm", `File: ${file.name} (${imported.length} câu hỏi)`, mod.code);
        triggerAutoSave(true, true);
        renderUploaderWorkspace();
        renderSidebar();
        alert(`✓ Đã chèn thành công ${imported.length} câu hỏi trắc nghiệm từ file "${file.name}" vào học phần ${mod.code}!`);
      });
    }

    // Open Paste Existing Quiz Modal
    const btnOpenPaste = document.getElementById("btnOpenPasteQuizModal");
    if (btnOpenPaste) {
      btnOpenPaste.addEventListener("click", () => {
        document.getElementById("textareaPasteQuiz").value = "";
        document.getElementById("chkPasteReplaceAll").checked = false;
        document.getElementById("pasteQuizDialog").showModal();
      });
    }

    const btnConfirmPaste = document.getElementById("btnConfirmPasteQuiz");
    if (btnConfirmPaste) {
      btnConfirmPaste.addEventListener("click", () => {
        const mod = getCurrentModule();
        if (!mod) return;
        const raw = document.getElementById("textareaPasteQuiz").value;
        const replaceAll = document.getElementById("chkPasteReplaceAll").checked;
        const imported = parseImportedQuizTextOrTables(raw, []);
        if (imported.length === 0) {
          alert("Chưa nhận diện được câu hỏi. Vui lòng kiểm tra định dạng (Câu 1: ... A. ... B. ... C. ... D. ... Đáp án: ...).");
          return;
        }
        if (replaceAll || !Array.isArray(mod.questions)) {
          mod.questions = imported;
        } else {
          mod.questions = mod.questions.concat(imported);
        }
        document.getElementById("pasteQuizDialog").close();
        triggerAutoSave(true, true);
        renderUploaderQuestionBank(mod);
        renderSidebar();
      });
    }

    // Download Quiz Template CSV/Excel
    const btnDlTpl = document.getElementById("btnDownloadQuizTemplate");
    if (btnDlTpl) {
      btnDlTpl.addEventListener("click", () => {
        const csvContent =
          "\ufeffSTT,Câu hỏi trắc nghiệm,Phương án A,Phương án B,Phương án C,Phương án D,Đáp án đúng (A/B/C/D),Giải thích & Gợi ý tư vấn\n" +
          "1,Chương trình KNS Novastars có bao nhiêu tiết mỗi năm cho 1 khối?,36 tiết,72 tiết (2 tiết/tuần x 36 tuần),50 tiết,90 tiết,B,Dạy chuyên sâu 2 tiết/tuần x 36 tuần = 72 tiết/năm cho từng khối Bé - Nhỡ - Lớn.\n" +
          "2,Ở bài B57 khối Lớn mẹo dùng đôi bàn tay giúp trẻ phân biệt cặp chữ nào?,Chữ a và o,Chữ m và n,Chữ b và d (tay trái nút Thích là b - tay phải là d),Chữ p và q,C,Giơ nút Thích bằng tay trái tạo hình chữ b và tay phải tạo hình chữ d.\n";
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "MAU_NHAP_CAU_HOI_TRAC_NGHIEM_SALE.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      });
    }

    // Balance A/B/C/D Answer Positions
    const btnBalance = document.getElementById("btnBalanceAnswerPositions");
    if (btnBalance) {
      btnBalance.addEventListener("click", () => {
        const mod = getCurrentModule();
        if (!mod || !Array.isArray(mod.questions) || mod.questions.length === 0) return;
        const pattern = [0, 2, 1, 3, 2, 0, 3, 1];
        mod.questions.forEach((q, idx) => {
          const targetIdx = pattern[idx % pattern.length];
          const curIdx = Number(q.correctIndex || 0);
          if (curIdx !== targetIdx && Array.isArray(q.options) && q.options.length >= 4) {
            const tmp = q.options[curIdx];
            q.options[curIdx] = q.options[targetIdx];
            q.options[targetIdx] = tmp;
            q.correctIndex = targetIdx;
          }
        });
        triggerAutoSave(true, true);
        renderUploaderQuestionBank(mod);
      });
    }

    // Add Manual Question
    function addNewQuestionToCurrentModule() {
      const mod = getCurrentModule();
      if (!mod) return;
      if (!Array.isArray(mod.questions)) mod.questions = [];
      mod.questions.push({
        id: `q-man-${Date.now().toString(36)}`,
        category: "xu_ly_tinh_huong",
        categoryLabel: "4. Xử lý tình huống",
        question: "Nhập nội dung câu hỏi trắc nghiệm mới...",
        options: [
          "Phương án A",
          "Phương án B (Đáp án đúng)",
          "Phương án C",
          "Phương án D"
        ],
        correctIndex: 1,
        explanation: "Giải thích căn cứ theo tài liệu gốc."
      });
      expandedUploaderQuestionIndex = mod.questions.length - 1;
      triggerAutoSave(true, true);
      renderUploaderQuestionBank(mod);
      renderSidebar();
    }

    const btnAddQTop = document.getElementById("btnAddManualQuestion");
    const btnAddQBot = document.getElementById("btnAddManualQuestionBottom");
    if (btnAddQTop) btnAddQTop.addEventListener("click", addNewQuestionToCurrentModule);
    if (btnAddQBot) btnAddQBot.addEventListener("click", addNewQuestionToCurrentModule);

    // Save Module Buttons
    function saveCurrentModuleAndNotify() {
      const mod = getCurrentModule();
      if (!mod) return;
      syncUploaderDocFieldsToModule(mod);
      if (currentUser) mod.authorName = currentUser.name;
      expandedUploaderQuestionIndex = null;
      logUserActivity("save_module", "Lưu cập nhật học phần", `${mod.code}: ${mod.title} (${(mod.questions || []).length} câu hỏi)`, mod.code);
      triggerAutoSave(true, true);
      renderSidebar();
      renderUploaderWorkspace();
      const btn = document.getElementById("btnUploaderSaveModule");
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "✓ Đã lưu!";
        setTimeout(() => { btn.textContent = orig; }, 1800);
      }
    }

    const btnSaveTop = document.getElementById("btnUploaderSaveModule");
    const btnSaveBot = document.getElementById("btnUploaderSaveBottom");
    if (btnSaveTop) btnSaveTop.addEventListener("click", saveCurrentModuleAndNotify);
    if (btnSaveBot) btnSaveBot.addEventListener("click", saveCurrentModuleAndNotify);

    const btnSubmitApprove = document.getElementById("btnUploaderSubmitForApproval");
    if (btnSubmitApprove) {
      btnSubmitApprove.addEventListener("click", () => {
        const mod = getCurrentModule();
        if (!mod) return;
        syncUploaderDocFieldsToModule(mod);
        if (currentUser) mod.authorName = currentUser.name;
        mod.status = (currentUser && currentUser.role === "admin") ? "published" : "pending";
        mod.updatedAt = new Date().toISOString();
        expandedUploaderQuestionIndex = null;
        logUserActivity(
          "submit_review",
          mod.status === "pending" ? "Gửi học phần chờ Admin duyệt" : "Duyệt & Xuất bản học phần",
          `${mod.code}: ${mod.title} (${(mod.questions || []).length} câu hỏi)`,
          mod.code
        );
        triggerAutoSave(true, true);
        renderSidebar();
        renderUploaderWorkspace();
        alert(
          mod.status === "pending"
            ? `Đã lưu và gửi học phần "${mod.code}: ${mod.title}" sang mục Quản lý Học phần để chờ Admin duyệt xuất bản!`
            : `Đã lưu và xuất bản học phần "${mod.code}: ${mod.title}"!`
        );
      });
    }

    // Preview as Sale Buttons
    function previewCurrentModuleAsSale() {
      const mod = getCurrentModule();
      if (mod) syncUploaderDocFieldsToModule(mod);
      triggerAutoSave(true, true);
      activeWorkspaceView = "sale";
      activeSaleTab = "doc";
      resetActiveQuizState();
      renderAll();
    }

    const btnPrevTop = document.getElementById("btnUploaderPreviewAsSale");
    const btnPrevBot = document.getElementById("btnUploaderPreviewBottom");
    if (btnPrevTop) btnPrevTop.addEventListener("click", previewCurrentModuleAsSale);
    if (btnPrevBot) {
      btnPrevBot.addEventListener("click", () => {
        const mod = getCurrentModule();
        if (mod) syncUploaderDocFieldsToModule(mod);
        triggerAutoSave(true, true);
        activeWorkspaceView = "sale";
        activeSaleTab = "quiz";
        resetActiveQuizState();
        renderAll();
      });
    }

    // Delete Module Button
    document.getElementById("btnUploaderDeleteModule").addEventListener("click", () => {
      if ((db.modules || []).length <= 1) {
        alert("Cần giữ lại ít nhất 1 học phần trong hệ thống.");
        return;
      }
      const mod = getCurrentModule();
      if (!mod) return;
      if (!canCurrentUserEditModule(mod)) {
        alert(`Học phần này do "${mod.authorName || "nhân sự khác"}" tải lên. Bạn chỉ có quyền xóa học phần do chính bạn tải lên.`);
        return;
      }
      if (confirm(`Bạn có chắc muốn xóa học phần "${mod.code}: ${mod.title}" không?`)) {
        db.modules = db.modules.filter(m => m.id !== mod.id);
        currentModuleId = db.modules[0].id;
        triggerAutoSave(true, true);
        renderAll();
      }
    });

    // Admin tools
    const btnRefreshCloud = document.getElementById("btnRefreshCloud");
    if (btnRefreshCloud) {
      btnRefreshCloud.addEventListener("click", async () => {
        const orig = btnRefreshCloud.textContent;
        btnRefreshCloud.textContent = "Đang đồng bộ Cloud...";
        await fetchCloudDb(true);
        btnRefreshCloud.textContent = "✓ Đã cập nhật mới nhất";
        setTimeout(() => { btnRefreshCloud.textContent = orig; }, 1800);
      });
    }

    const btnAdminGoUp = document.getElementById("btnAdminGoToUploader");
    if (btnAdminGoUp) {
      btnAdminGoUp.addEventListener("click", () => {
        activeWorkspaceView = "uploader";
        renderAll();
      });
    }

    const btnOpenManage = document.getElementById("btnOpenManageUsersModal");
    if (btnOpenManage) {
      btnOpenManage.addEventListener("click", () => {
        editingUserId = null;
        renderManageUsersModal();
        document.getElementById("manageDialog").showModal();
      });
    }

    // Manage Modal Tabs
    const tSales = document.getElementById("tabBtnManageSales");
    const tUps = document.getElementById("tabBtnManageUploaders");
    const tSet = document.getElementById("tabBtnManageSettings");
    const pSales = document.getElementById("tabPanelManageSales");
    const pUps = document.getElementById("tabPanelManageUploaders");
    const pSet = document.getElementById("tabPanelManageSettings");

    function switchManageTab(which) {
      [
        [tSales, pSales, which === "sales"],
        [tUps, pUps, which === "uploaders"],
        [tSet, pSet, which === "settings"]
      ].forEach(([t, p, act]) => {
        if (t) t.classList.toggle("active", act);
        if (p) p.classList.toggle("hidden", !act);
      });
    }

    if (tSales) tSales.onclick = () => switchManageTab("sales");
    if (tUps) tUps.onclick = () => switchManageTab("uploaders");
    if (tSet) tSet.onclick = () => switchManageTab("settings");

    function handleAddSale() {
      const nameInp = document.getElementById("newSaleName");
      const pinInp = document.getElementById("newSalePin");
      const name = nameInp ? nameInp.value.trim() : "";
      const pin = (pinInp ? pinInp.value.trim() : "") || "1234";
      if (!name) return;
      db.users.push({
        id: "sale-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5),
        name,
        pin,
        role: "sale",
        title: "Học Viên"
      });
      nameInp.value = "";
      pinInp.value = "";
      triggerAutoSave(true, true);
      renderManageUsersModal();
      populateAuthSelects();
      renderAll();
    }

    function handleAddUploader() {
      const nameInp = document.getElementById("newUploaderName");
      const pinInp = document.getElementById("newUploaderPin");
      const name = nameInp ? nameInp.value.trim() : "";
      const pin = (pinInp ? pinInp.value.trim() : "") || "7777";
      if (!name) return;
      db.users.push({
        id: "up-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5),
        name,
        pin,
        role: "uploader",
        title: "Phụ trách Nội dung & Đào tạo"
      });
      nameInp.value = "";
      pinInp.value = "";
      triggerAutoSave(true, true);
      renderManageUsersModal();
      populateAuthSelects();
      renderAll();
    }

    document.getElementById("btnAddSale").addEventListener("click", handleAddSale);
    ["newSaleName", "newSalePin"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleAddSale();
          }
        });
      }
    });

    document.getElementById("btnAddUploader").addEventListener("click", handleAddUploader);
    ["newUploaderName", "newUploaderPin"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleAddUploader();
          }
        });
      }
    });

    const manageDlg = document.getElementById("manageDialog");
    if (manageDlg) {
      manageDlg.addEventListener("close", () => {
        handleAddSale();
        handleAddUploader();
        editingUserId = null;
        triggerAutoSave(true, true);
        populateAuthSelects();
        renderAll();
      });
    }

    document.getElementById("btnSaveAdminSettings").addEventListener("click", () => {
      const newPin = document.getElementById("settingAdminPin").value.trim() || "Nvs123456";
      const newThresh = Number(document.getElementById("settingDefaultThreshold").value || 80);
      db.meta.adminPin = newPin;
      db.meta.defaultPassThreshold = newThresh;
      triggerAutoSave(true, true);
      alert("✓ Đã lưu cài đặt hệ thống!");
    });

    // Copy Link & Copy PIN Card Image
    const btnCopyUrl = document.getElementById("btnCopySharedUrl");
    if (btnCopyUrl) {
      btnCopyUrl.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(window.location.origin + window.location.pathname);
          const orig = btnCopyUrl.textContent;
          btnCopyUrl.textContent = "✓ Đã copy Link!";
          setTimeout(() => { btnCopyUrl.textContent = orig; }, 2000);
        } catch (e) {}
      });
    }

    const btnCopyCard = document.getElementById("btnCopyPinCardImg");
    if (btnCopyCard) {
      btnCopyCard.addEventListener("click", () => {
        const orig = btnCopyCard.textContent;
        const canvas = buildPinCardCanvas();
        canvas.toBlob(async blob => {
          if (!blob) return;
          try {
            if (navigator.clipboard && window.ClipboardItem) {
              await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
              btnCopyCard.textContent = "✓ Đã copy Ảnh! Nhấn Ctrl+V vào nhóm chat";
              setTimeout(() => { btnCopyCard.textContent = orig; }, 3000);
              return;
            }
          } catch (e) {}
          document.getElementById("lightboxImg").src = canvas.toDataURL("image/png");
          document.getElementById("lightboxDialog").showModal();
        }, "image/png");
      });
    }

    // Export Excel Report
    const btnExport = document.getElementById("btnExportExcel");
    if (btnExport) {
      btnExport.addEventListener("click", async () => {
        try {
          const res = await fetch("/api/export-excel");
          if (res.ok && (res.headers.get("content-type") || "").includes("spreadsheetml")) {
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "BAO_CAO_DAO_TAO_SALE_NOVASTARS.xlsx";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            return;
          }
        } catch (e) {}
        exportExcelClientFallback();
      });
    }
  }

  function exportExcelClientFallback() {
    const sales = (db.users || []).filter(u => u.role === "sale");
    const pubMods = getVisibleModulesForLearner();
    let ths = `<th style="background:#C2410C;color:#fff;padding:10px;">STT</th><th style="background:#C2410C;color:#fff;padding:10px;">Họ và tên Học Viên</th><th style="background:#C2410C;color:#fff;padding:10px;">Mã PIN</th>`;
    pubMods.forEach(m => {
      ths += `<th style="background:#C2410C;color:#fff;padding:10px;">${escapeHtml(m.code)} - ${escapeHtml(m.title)}</th>`;
    });

    let trs = "";
    sales.forEach((s, idx) => {
      let tds = `<td>${idx + 1}</td><td><b>${escapeHtml(s.name)}</b></td><td>${escapeHtml(s.pin)}</td>`;
      pubMods.forEach(m => {
        const p = (db.progress || []).find(pr => pr.userId === s.id && pr.moduleId === m.id);
        if (p && p.passed) {
          tds += `<td style="background:#DCFCE7;color:#065F46;font-weight:bold;">ĐẠT: ${p.bestScore}% (${(p.attempts || []).length} lần)</td>`;
        } else if (p && p.attempts && p.attempts.length > 0) {
          tds += `<td style="background:#FEF3C7;color:#92400E;">CHƯA ĐẠT: ${p.bestScore}% (${p.attempts.length} lần)</td>`;
        } else if (p && p.docViewed) {
          tds += `<td>Đang đọc tài liệu</td>`;
        } else {
          tds += `<td>Chưa học</td>`;
        }
      });
      trs += `<tr>${tds}</tr>`;
    });

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="UTF-8"></head><body><table border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;"><tr>${ths}</tr>${trs}</table></body></html>`;
    const blob = new Blob(["\ufeff", html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "BAO_CAO_DAO_TAO_SALE_NOVASTARS.xls";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function setupSidebarAndDialogs() {
    const searchInp = document.getElementById("sidebarSearchInput");
    const clearBtn = document.getElementById("btnSidebarClearSearch");
    if (searchInp) {
      searchInp.addEventListener("input", e => {
        sidebarSearchQuery = e.target.value;
        clearBtn.classList.toggle("hidden", !sidebarSearchQuery.trim());
        renderSidebar();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        searchInp.value = "";
        sidebarSearchQuery = "";
        clearBtn.classList.add("hidden");
        renderSidebar();
      });
    }

    const sidebar = document.getElementById("moduleSidebar");
    const backdrop = document.getElementById("sidebarBackdrop");
    const btnToggle = document.getElementById("btnToggleSidebar");
    const btnCollapse = document.getElementById("btnCollapseSidebar");
    const btnInlineOpen = document.getElementById("btnInlineOpenSidebar");

    function updateSidebarLayout() {
      const isMobile = window.innerWidth <= 900;
      if (isMobile) {
        sidebar.classList.remove("collapsed");
        if (btnInlineOpen) btnInlineOpen.classList.add("hidden");
      } else {
        sidebar.classList.toggle("collapsed", isSidebarCollapsed);
        if (btnInlineOpen) btnInlineOpen.classList.toggle("hidden", !isSidebarCollapsed);
      }
    }

    function toggleSidebar(forceOpen) {
      const isMobile = window.innerWidth <= 900;
      if (isMobile) {
        const willOpen = typeof forceOpen === "boolean" ? forceOpen : !sidebar.classList.contains("open");
        sidebar.classList.toggle("open", willOpen);
        backdrop.classList.toggle("hidden", !willOpen);
      } else {
        isSidebarCollapsed = typeof forceOpen === "boolean" ? !forceOpen : !isSidebarCollapsed;
        localStorage.setItem("novastars_sale_sidebar_collapsed", String(isSidebarCollapsed));
        updateSidebarLayout();
      }
    }

    if (btnToggle) btnToggle.onclick = () => toggleSidebar();
    if (btnCollapse) btnCollapse.onclick = () => toggleSidebar(false);
    if (btnInlineOpen) btnInlineOpen.onclick = () => toggleSidebar(true);
    if (backdrop) {
      backdrop.onclick = () => {
        sidebar.classList.remove("open");
        backdrop.classList.add("hidden");
      };
    }

    window.addEventListener("resize", updateSidebarLayout);
    updateSidebarLayout();

    // Dialog light-dismiss fallback & close buttons
    document.querySelectorAll("dialog").forEach(dialog => {
      if (!("closedBy" in HTMLDialogElement.prototype)) {
        dialog.addEventListener("click", event => {
          if (event.target !== dialog) return;
          const rect = dialog.getBoundingClientRect();
          const inside =
            rect.top <= event.clientY &&
            event.clientY <= rect.top + rect.height &&
            rect.left <= event.clientX &&
            event.clientX <= rect.left + rect.width;
          if (!inside) dialog.close();
        });
      }
    });

    document.querySelectorAll("[data-close-dialog]").forEach(btn => {
      btn.addEventListener("click", () => {
        const dlg = document.getElementById(btn.dataset.closeDialog);
        if (dlg) dlg.close();
      });
    });

    const btnTopSave = document.getElementById("btnTopSave");
    if (btnTopSave) {
      btnTopSave.addEventListener("click", () => {
        if (activeWorkspaceView === "uploader") {
          const mod = getCurrentModule();
          if (mod) syncUploaderDocFieldsToModule(mod);
        }
        triggerAutoSave(true, true);
      });
    }
  }

  // =========================================================================
  // ADMIN PANEL 4: COURSE MODULE MANAGEMENT & APPROVAL (QUẢN LÝ HỌC PHẦN)
  // =========================================================================
  function renderAdminModulesPanel() {
    const panel = document.getElementById("adminPanelModules");
    if (!panel) return;
    const allMods = db.modules || [];
    const sales = (db.users || []).filter(u => u.role === "sale");
    const pendingCount = allMods.filter(m => m.status === "pending").length;
    const publishedCount = allMods.filter(m => m.status !== "pending" && m.status !== "draft").length;
    const draftCount = allMods.filter(m => m.status === "draft").length;

    const authors = Array.from(new Set(allMods.map(m => m.authorName || "Đào tạo").filter(Boolean)));

    const filteredMods = allMods.filter(m => {
      if (adminModuleStatusFilter === "PUBLISHED" && (m.status === "pending" || m.status === "draft")) return false;
      if (adminModuleStatusFilter === "PENDING" && m.status !== "pending") return false;
      if (adminModuleStatusFilter === "DRAFT" && m.status !== "draft") return false;
      if (adminModuleAuthorFilter !== "ALL" && (m.authorName || "Đào tạo") !== adminModuleAuthorFilter) return false;
      if (adminModuleSearchQuery) {
        const q = adminModuleSearchQuery.toLowerCase();
        const hit =
          (m.code || "").toLowerCase().includes(q) ||
          (m.title || "").toLowerCase().includes(q) ||
          (m.authorName || "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });

    const rowsHtml = filteredMods.length === 0
      ? `<tr><td colspan="6" style="text-align:center;padding:24px;color:#64748B;">Không có học phần nào khớp với bộ lọc hiện tại.</td></tr>`
      : filteredMods.map(m => {
          const qCount = Array.isArray(m.questions) ? m.questions.length : 0;
          const author = m.authorName || "Đào tạo";
          const updatedStr = m.updatedAt ? new Date(m.updatedAt).toLocaleString("vi-VN") : "—";
          const fileLabel = (m.sourceFile && m.sourceFile.name) ? m.sourceFile.name : "Soạn trực tiếp";
          let passedLearners = 0;
          sales.forEach(s => {
            const p = (db.progress || []).find(pr => pr.userId === s.id && pr.moduleId === m.id);
            if (p && p.passed) passedLearners++;
          });

          let statusBadge = `<span class="sidebar-item-status done">✓ Đã duyệt (Hiển thị)</span>`;
          if (m.status === "pending") {
            statusBadge = `<span class="sidebar-item-status pending">Chờ Admin duyệt</span>`;
          } else if (m.status === "draft") {
            statusBadge = `<span class="sidebar-item-status draft">Bản nháp (Ẩn)</span>`;
          }

          return `
            <tr>
              <td style="width:74px;text-align:center;">
                <span class="matrix-mod-th-code">${escapeHtml(m.code)}</span>
              </td>
              <td>
                <div style="font-weight:800;color:#0F172A;line-height:1.4;">${escapeHtml(m.title)}</div>
                <div style="font-size:11.8px;color:#64748B;margin-top:3px;">
                  Chuyên đề: ${escapeHtml(m.category || "Đào tạo")} · File: <code>${escapeHtml(fileLabel)}</code>
                </div>
              </td>
              <td>
                <div style="font-weight:700;color:#1E293B;">${escapeHtml(author)}</div>
                <div style="font-size:11.2px;color:#64748B;">${escapeHtml(updatedStr)}</div>
              </td>
              <td style="text-align:center;">
                <div><strong>${qCount} câu</strong> <span style="font-size:11.5px;color:#64748B;">(&ge;${m.passThreshold || 80}%)</span></div>
                <div style="font-size:11.5px;color:#059669;font-weight:700;margin-top:2px;">Đạt: ${passedLearners}/${sales.length} HV</div>
              </td>
              <td>${statusBadge}</td>
              <td>
                <div style="display:flex;gap:5px;flex-wrap:wrap;">
                  ${m.status !== "published"
                    ? `<button type="button" class="btn-row-act save" data-mod-approve="${escapeHtml(m.id)}">✓ Duyệt</button>`
                    : `<button type="button" class="btn-row-act" data-mod-unpublish="${escapeHtml(m.id)}">Tạm ẩn</button>`
                  }
                  <button type="button" class="btn-row-act" data-mod-edit="${escapeHtml(m.id)}">Sửa bài</button>
                  <button type="button" class="btn-row-act" data-mod-preview="${escapeHtml(m.id)}">Xem thử</button>
                  <button type="button" class="btn-row-act" data-mod-analytics="${escapeHtml(m.id)}" title="Xem thống kê câu hỏi">Thống kê</button>
                  <button type="button" class="btn-row-act danger" data-mod-delete="${escapeHtml(m.id)}">Xóa</button>
                </div>
              </td>
            </tr>
          `;
        }).join("");

    const authorOptionsHtml = [
      `<option value="ALL" ${adminModuleAuthorFilter === "ALL" ? "selected" : ""}>Tất cả tác giả (${authors.length})</option>`,
      ...authors.map(a => `<option value="${escapeHtml(a)}" ${adminModuleAuthorFilter === a ? "selected" : ""}>Tác giả: ${escapeHtml(a)}</option>`)
    ].join("");

    panel.innerHTML = `
      <div class="admin-card">
        <div class="admin-card-head">
          <div>
            <h2 class="admin-title">Quản lý Học phần &amp; Phê duyệt Nội dung Đào tạo (${allMods.length} học phần)</h2>
            <p class="admin-sub">
              Admin có toàn quyền xem, sửa, phê duyệt xuất bản hoặc tạm ẩn tất cả học phần của mọi tác giả.
            </p>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            ${pendingCount > 0 ? `
              <button type="button" class="btn-row-act save" id="btnAdminApproveAllPending" style="padding:8px 13px;font-size:12.5px;">
                ✓ Duyệt xuất bản tất cả (${pendingCount} bài chờ)
              </button>
            ` : ""}
            <button type="button" class="btn-primary" id="btnAdminCreateNewModule">+ Tạo học phần mới</button>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid #FFEDD5;">
          <div class="study-filter-pills">
            <button type="button" class="study-filter-pill ${adminModuleStatusFilter === 'ALL' ? 'active' : ''}" data-mod-filter="ALL">Tất cả (${allMods.length})</button>
            <button type="button" class="study-filter-pill ${adminModuleStatusFilter === 'PUBLISHED' ? 'active' : ''}" data-mod-filter="PUBLISHED">Đã duyệt (${publishedCount})</button>
            <button type="button" class="study-filter-pill ${adminModuleStatusFilter === 'PENDING' ? 'active' : ''}" data-mod-filter="PENDING">Chờ duyệt (${pendingCount})</button>
            <button type="button" class="study-filter-pill ${adminModuleStatusFilter === 'DRAFT' ? 'active' : ''}" data-mod-filter="DRAFT">Bản nháp (${draftCount})</button>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <select id="selAdminModAuthorFilter" class="input-control" style="width:195px;padding:6px 10px;font-size:12.5px;">
              ${authorOptionsHtml}
            </select>
            <input type="text" id="inpAdminModSearch" class="input-control" placeholder="Tìm mã HP, tên bài..." value="${escapeHtml(adminModuleSearchQuery)}" style="width:190px;padding:6px 10px;font-size:12.5px;">
          </div>
        </div>

        <div class="table-responsive">
          <table class="progress-matrix-table">
            <thead>
              <tr>
                <th style="width:74px;text-align:center;">Mã</th>
                <th>Tên Học phần / Tài liệu</th>
                <th style="width:155px;">Tác giả / Cập nhật</th>
                <th style="width:125px;text-align:center;">Câu hỏi &amp; Tỷ lệ Đạt</th>
                <th style="width:150px;">Trạng thái</th>
                <th style="width:295px;">Thao tác</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;

    const btnNew = document.getElementById("btnAdminCreateNewModule");
    if (btnNew) {
      btnNew.onclick = () => createNewModuleForCurrentUser();
    }

    const btnApproveAll = document.getElementById("btnAdminApproveAllPending");
    if (btnApproveAll) {
      btnApproveAll.onclick = () => {
        (db.modules || []).forEach(m => {
          if (m.status === "pending") {
            m.status = "published";
            m.updatedAt = new Date().toISOString();
          }
        });
        logUserActivity("approve_module", "Admin duyệt tất cả học phần chờ duyệt", `${pendingCount} học phần`);
        triggerAutoSave(true, true);
        renderAdminWorkspace();
      };
    }

    panel.querySelectorAll("[data-mod-filter]").forEach(btn => {
      btn.onclick = () => {
        adminModuleStatusFilter = btn.dataset.modFilter;
        renderAdminModulesPanel();
      };
    });

    const selAuthor = document.getElementById("selAdminModAuthorFilter");
    if (selAuthor) {
      selAuthor.onchange = () => {
        adminModuleAuthorFilter = selAuthor.value;
        renderAdminModulesPanel();
      };
    }

    const inpSearch = document.getElementById("inpAdminModSearch");
    if (inpSearch) {
      inpSearch.oninput = () => {
        adminModuleSearchQuery = inpSearch.value;
        renderAdminModulesPanel();
        const newInp = document.getElementById("inpAdminModSearch");
        if (newInp) {
          newInp.focus();
          newInp.setSelectionRange(newInp.value.length, newInp.value.length);
        }
      };
    }

    panel.querySelectorAll("[data-mod-approve]").forEach(btn => {
      btn.onclick = () => {
        const mod = (db.modules || []).find(m => m.id === btn.dataset.modApprove);
        if (!mod) return;
        mod.status = "published";
        mod.updatedAt = new Date().toISOString();
        logUserActivity("approve_module", "Admin duyệt xuất bản học phần", `${mod.code}: ${mod.title}`, mod.code);
        triggerAutoSave(true, true);
        renderAdminWorkspace();
      };
    });

    panel.querySelectorAll("[data-mod-unpublish]").forEach(btn => {
      btn.onclick = () => {
        const mod = (db.modules || []).find(m => m.id === btn.dataset.modUnpublish);
        if (!mod) return;
        mod.status = "draft";
        mod.updatedAt = new Date().toISOString();
        logUserActivity("unpublish_module", "Admin tạm ẩn học phần", `${mod.code}: ${mod.title}`, mod.code);
        triggerAutoSave(true, true);
        renderAdminWorkspace();
      };
    });

    panel.querySelectorAll("[data-mod-edit]").forEach(btn => {
      btn.onclick = () => {
        currentModuleId = btn.dataset.modEdit;
        activeWorkspaceView = "uploader";
        activeUploaderTab = "doc";
        renderAll();
      };
    });

    panel.querySelectorAll("[data-mod-preview]").forEach(btn => {
      btn.onclick = () => {
        currentModuleId = btn.dataset.modPreview;
        activeWorkspaceView = "sale";
        activeSaleTab = "doc";
        resetActiveQuizState();
        renderAll();
      };
    });

    panel.querySelectorAll("[data-mod-analytics]").forEach(btn => {
      btn.onclick = () => {
        activeAnalyticsModuleId = btn.dataset.modAnalytics;
        activeAdminTab = "analytics";
        renderAdminWorkspace();
      };
    });

    panel.querySelectorAll("[data-mod-delete]").forEach(btn => {
      btn.onclick = () => {
        if ((db.modules || []).length <= 1) {
          alert("Cần giữ lại ít nhất 1 học phần trong hệ thống.");
          return;
        }
        const mod = (db.modules || []).find(m => m.id === btn.dataset.modDelete);
        if (!mod) return;
        if (confirm(`Xóa học phần "${mod.code}: ${mod.title}"?`)) {
          db.modules = db.modules.filter(m => m.id !== mod.id);
          currentModuleId = db.modules[0].id;
          logUserActivity("delete_module", "Admin xóa học phần", `${mod.code}: ${mod.title}`, mod.code);
          triggerAutoSave(true, true);
          renderAdminWorkspace();
        }
      };
    });
  }

  // =========================================================================
  // ADMIN PANEL 3: INLINE STAFF & PIN MANAGEMENT (NHÂN SỰ & MÃ PIN)
  // =========================================================================
  function renderAdminUsersPanel() {
    const panel = document.getElementById("adminPanelUsers");
    if (!panel) return;
    const allUsers = db.users || [];
    const sales = allUsers.filter(u => u.role === "sale");
    const uploaders = allUsers.filter(u => u.role === "uploader");
    const pubMods = getVisibleModulesForLearner();
    const allMods = db.modules || [];
    const nowMs = Date.now();

    function buildUserTableRows(list, isUploader) {
      if (list.length === 0) {
        return `<tr><td colspan="5" style="text-align:center;padding:18px;color:#64748B;">Chưa có nhân sự trong nhóm này.</td></tr>`;
      }
      return list.map(u => {
        const pr = db.presence && db.presence[u.id];
        const isOnline = pr && pr.lastSeenAt && (nowMs - (Date.parse(pr.lastSeenAt) || 0) < ONLINE_THRESHOLD_MS);
        let metricHtml = "";
        if (isUploader) {
          const authoredCount = allMods.filter(m => m.authorId === u.id || (m.authorName || "").trim().toLowerCase() === (u.name || "").trim().toLowerCase()).length;
          metricHtml = `<span class="sidebar-item-status reading">${authoredCount} học phần</span>`;
        } else {
          let passedCount = 0;
          pubMods.forEach(m => {
            const p = (db.progress || []).find(item => item.userId === u.id && item.moduleId === m.id);
            if (p && p.passed) passedCount++;
          });
          metricHtml = `<span class="sidebar-item-status ${passedCount === pubMods.length && pubMods.length > 0 ? 'done' : 'reading'}">${passedCount}/${pubMods.length} bài đạt</span>`;
        }

        return `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:7px;font-weight:800;color:#0F172A;">
                <span class="presence-dot ${isOnline ? "online" : ""}"></span>
                <input type="text" class="input-control" data-inline-user-name="${escapeHtml(u.id)}" value="${escapeHtml(u.name)}" style="padding:5px 9px;font-size:13px;font-weight:700;">
              </div>
            </td>
            <td style="width:105px;">
              <input type="text" class="input-control mono-input" data-inline-user-pin="${escapeHtml(u.id)}" value="${escapeHtml(u.pin)}" style="padding:5px 9px;font-size:13px;text-align:center;">
            </td>
            <td style="width:125px;text-align:center;">${metricHtml}</td>
            <td style="width:155px;">
              <div style="display:flex;gap:6px;justify-content:flex-end;">
                ${!isUploader ? `<button type="button" class="btn-row-act" data-inline-act-as="${escapeHtml(u.id)}" title="Xem giao diện học dưới quyền Học Viên này">Xem thử</button>` : ""}
                <button type="button" class="btn-row-act danger" data-inline-del-user="${escapeHtml(u.id)}">Xóa</button>
              </div>
            </td>
          </tr>
        `;
      }).join("");
    }

    const adminPinVal = (db.meta && db.meta.adminPin) ? db.meta.adminPin : "Nvs123456";
    const threshVal = (db.meta && db.meta.defaultPassThreshold) ? db.meta.defaultPassThreshold : 80;

    panel.innerHTML = `
      <div class="admin-card">
        <div class="admin-card-head">
          <div>
            <h2 class="admin-title">Quản lý Danh sách Nhân sự &amp; Cấp Mã PIN Đăng nhập</h2>
            <p class="admin-sub">Sửa trực tiếp Họ tên hoặc Mã PIN tại bảng (hệ thống tự động lưu Cloud ngay khi gõ) hoặc xuất Thẻ PIN gửi vào nhóm Zalo.</p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn-secondary" id="btnUsersPanelCopyUrl">Copy Link Web</button>
            <button type="button" class="btn-primary" id="btnUsersPanelCopyPinCard">Copy Ảnh Thẻ PIN gửi Zalo</button>
          </div>
        </div>

        <div class="admin-users-grid">
          <!-- HỌC VIÊN COLUMN -->
          <div style="border:1px solid #FED7AA;border-radius:12px;padding:14px;background:#FFFBF5;display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <h3 style="font-size:14.5px;font-weight:800;color:#9A3412;">1. Danh sách Học Viên (${sales.length})</h3>
              <span class="presence-role-tag sale">Học &amp; Thi trắc nghiệm</span>
            </div>
            <div class="table-responsive">
              <table class="progress-matrix-table" style="background:#FFFFFF;">
                <thead>
                  <tr>
                    <th>Họ và tên Học Viên</th>
                    <th style="text-align:center;">Mã PIN</th>
                    <th style="text-align:center;">Tiến độ</th>
                    <th style="text-align:right;">Thao tác</th>
                  </tr>
                </thead>
                <tbody>${buildUserTableRows(sales, false)}</tbody>
              </table>
            </div>
            <div class="add-row-form" style="margin-top:4px;">
              <input type="text" id="inpInlineNewSaleName" class="input-control" placeholder="Nhập họ và tên Học Viên mới...">
              <input type="text" id="inpInlineNewSalePin" class="input-control mono-input" placeholder="PIN (4 số)" style="max-width:110px;">
              <button type="button" class="btn-primary" id="btnInlineAddSale">+ Thêm Học Viên</button>
            </div>
          </div>

          <!-- ĐÀO TẠO COLUMN -->
          <div style="border:1px solid #FED7AA;border-radius:12px;padding:14px;background:#FFFBF5;display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <h3 style="font-size:14.5px;font-weight:800;color:#9A3412;">2. Nhân sự Đào tạo (${uploaders.length})</h3>
              <span class="presence-role-tag uploader">Đăng tài liệu &amp; Câu hỏi</span>
            </div>
            <div class="table-responsive">
              <table class="progress-matrix-table" style="background:#FFFFFF;">
                <thead>
                  <tr>
                    <th>Họ và tên Đào tạo</th>
                    <th style="text-align:center;">Mã PIN</th>
                    <th style="text-align:center;">Học phần</th>
                    <th style="text-align:right;">Thao tác</th>
                  </tr>
                </thead>
                <tbody>${buildUserTableRows(uploaders, true)}</tbody>
              </table>
            </div>
            <div class="add-row-form" style="margin-top:4px;">
              <input type="text" id="inpInlineNewUploaderName" class="input-control" placeholder="Nhập họ và tên Đào tạo mới...">
              <input type="text" id="inpInlineNewUploaderPin" class="input-control mono-input" placeholder="PIN (4 số)" style="max-width:110px;">
              <button type="button" class="btn-primary" id="btnInlineAddUploader">+ Thêm Đào tạo</button>
            </div>
          </div>
        </div>

        <div style="margin-top:6px;padding-top:12px;border-top:1px solid #FFEDD5;display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;">
          <div class="form-group" style="width:220px;">
            <label>Mã PIN Admin (Quản lý):</label>
            <input type="text" id="inpInlineAdminPin" class="input-control mono-input" value="${escapeHtml(adminPinVal)}">
          </div>
          <div class="form-group" style="width:220px;">
            <label>Ngưỡng điểm Đạt mặc định (%):</label>
            <input type="number" id="inpInlineDefaultThresh" class="input-control" min="50" max="100" step="5" value="${escapeHtml(threshVal)}">
          </div>
          <button type="button" class="btn-primary" id="btnInlineSaveAdminConfig">✓ Lưu cài đặt Admin</button>
        </div>
      </div>
    `;

    panel.querySelectorAll("[data-inline-user-name]").forEach(inp => {
      inp.addEventListener("input", () => {
        const u = (db.users || []).find(item => item.id === inp.dataset.inlineUserName);
        if (u && inp.value.trim()) {
          u.name = inp.value.trim();
          triggerAutoSave(false, true);
          populateAuthSelects();
        }
      });
    });

    panel.querySelectorAll("[data-inline-user-pin]").forEach(inp => {
      inp.addEventListener("input", () => {
        const u = (db.users || []).find(item => item.id === inp.dataset.inlineUserPin);
        if (u && inp.value.trim()) {
          u.pin = inp.value.trim();
          triggerAutoSave(false, true);
        }
      });
    });

    panel.querySelectorAll("[data-inline-act-as]").forEach(btn => {
      btn.onclick = () => {
        const u = (db.users || []).find(item => item.id === btn.dataset.inlineActAs);
        if (!u) return;
        impersonatedSaleUser = u;
        activeWorkspaceView = "sale";
        resetActiveQuizState();
        renderAll();
      };
    });

    panel.querySelectorAll("[data-inline-del-user]").forEach(btn => {
      btn.onclick = () => {
        const u = (db.users || []).find(item => item.id === btn.dataset.inlineDelUser);
        if (!u) return;
        if (confirm(`Xóa tài khoản nhân sự "${u.name}"?`)) {
          db.users = (db.users || []).filter(item => item.id !== u.id);
          triggerAutoSave(true, true);
          populateAuthSelects();
          renderAdminWorkspace();
        }
      };
    });

    const addInlineUser = (role) => {
      const nameEl = document.getElementById(role === "sale" ? "inpInlineNewSaleName" : "inpInlineNewUploaderName");
      const pinEl = document.getElementById(role === "sale" ? "inpInlineNewSalePin" : "inpInlineNewUploaderPin");
      const name = nameEl ? nameEl.value.trim() : "";
      const pin = (pinEl ? pinEl.value.trim() : "") || (role === "sale" ? "1234" : "7777");
      if (!name) return;
      db.users.push({
        id: `${role === "sale" ? "sale" : "up"}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
        name,
        pin,
        role,
        title: role === "sale" ? "Học Viên" : "Phụ trách Nội dung & Đào tạo"
      });
      triggerAutoSave(true, true);
      populateAuthSelects();
      renderAdminWorkspace();
    };

    const btnAddS = document.getElementById("btnInlineAddSale");
    if (btnAddS) btnAddS.onclick = () => addInlineUser("sale");
    const btnAddU = document.getElementById("btnInlineAddUploader");
    if (btnAddU) btnAddU.onclick = () => addInlineUser("uploader");

    const btnSaveCfg = document.getElementById("btnInlineSaveAdminConfig");
    if (btnSaveCfg) {
      btnSaveCfg.onclick = () => {
        const newPin = document.getElementById("inpInlineAdminPin").value.trim() || "Nvs123456";
        const newThresh = Number(document.getElementById("inpInlineDefaultThresh").value || 80);
        db.meta.adminPin = newPin;
        db.meta.defaultPassThreshold = newThresh;
        document.getElementById("settingAdminPin").value = newPin;
        document.getElementById("settingDefaultThreshold").value = String(newThresh);
        triggerAutoSave(true, true);
        alert("✓ Đã lưu Mã PIN Admin & Ngưỡng điểm Đạt!");
      };
    }

    const btnCopyUrl = document.getElementById("btnUsersPanelCopyUrl");
    if (btnCopyUrl) {
      btnCopyUrl.onclick = () => document.getElementById("btnCopySharedUrl").click();
    }
    const btnCopyCard = document.getElementById("btnUsersPanelCopyPinCard");
    if (btnCopyCard) {
      btnCopyCard.onclick = () => document.getElementById("btnCopyPinCardImg").click();
    }
  }

  // =========================================================================
  // ADMIN PANEL 5: REAL-TIME PRESENCE & ACTIVITY HISTORY
  // =========================================================================
  let activityRoleFilter = "ALL";

  function formatRelativeTimeAgo(isoStr) {
    if (!isoStr) return "Chưa truy cập";
    const diffSec = Math.max(0, Math.floor((Date.now() - (Date.parse(isoStr) || 0)) / 1000));
    if (diffSec < 45) return "Vừa xong (Đang trực tuyến)";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
    return new Date(isoStr).toLocaleString("vi-VN");
  }

  function renderAdminActivityPanel() {
    const panel = document.getElementById("adminPanelActivity");
    if (!panel) return;
    const nowMs = Date.now();

    const allTrackedUsers = [
      ...(db.users || []),
      { id: "admin", name: "Admin", role: "admin", title: "Quản trị hệ thống" }
    ];

    const presenceCardsHtml = allTrackedUsers.map(u => {
      const pr = (db.presence && db.presence[u.id]) ? db.presence[u.id] : null;
      const lastMs = pr && pr.lastSeenAt ? (Date.parse(pr.lastSeenAt) || 0) : 0;
      const isOnline = lastMs > 0 && (nowMs - lastMs < ONLINE_THRESHOLD_MS);
      const roleLabel = u.role === "admin" ? "Admin" : (u.role === "uploader" ? "Đào tạo" : "Học Viên");
      const statusText = pr && pr.statusText
        ? pr.statusText
        : "Chưa có hoạt động ghi nhận";
      const timeMeta = pr && pr.lastSeenAt
        ? `${isOnline ? "● Đang hoạt động" : "○ Offline"} · Cập nhật: ${formatRelativeTimeAgo(pr.lastSeenAt)}`
        : "○ Chưa đăng nhập";

      return `
        <div class="presence-card ${isOnline ? "is-online" : ""}">
          <div class="presence-card-top">
            <span class="presence-user-name">
              <span class="presence-dot ${isOnline ? "online" : ""}"></span>
              ${escapeHtml(u.name)}
            </span>
            <span class="presence-role-tag ${escapeHtml(u.role)}">${roleLabel}</span>
          </div>
          <div class="presence-activity-text">${escapeHtml(statusText)}</div>
          <div class="presence-time-meta">${escapeHtml(timeMeta)}</div>
        </div>
      `;
    }).join("");

    const logs = Array.isArray(db.activityLogs) ? db.activityLogs : [];
    const filteredLogs = logs.filter(item => {
      if (activityRoleFilter === "ALL") return true;
      return item.role === activityRoleFilter;
    });

    const logsHtml = filteredLogs.length === 0
      ? `<div style="padding:20px;text-align:center;color:#64748B;">Chưa có lịch sử hoạt động ở bộ lọc này.</div>`
      : filteredLogs.map(item => {
          const roleLabel = item.role === "admin" ? "Admin" : (item.role === "uploader" ? "Đào tạo" : "Học Viên");
          const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleString("vi-VN") : "";
          const isBugAct = item.actionType === "report_bug";
          return `
            <div class="activity-log-row">
              <div class="activity-log-left" style="flex-wrap:wrap;gap:6px;">
                <span class="presence-role-tag ${escapeHtml(item.role || "sale")}">${roleLabel}</span>
                <strong>${escapeHtml(item.userName || "")}</strong>
                <span>—</span>
                <span style="font-weight:700;color:#C2410C;">${escapeHtml(item.actionLabel || "")}</span>
                ${item.detail ? `<span style="color:#334155;white-space:pre-line;">(${escapeHtml(item.detail)})</span>` : ""}
                ${isBugAct ? `<button type="button" class="btn-row-act" data-open-bug-list-from-act="1" style="padding:3px 9px;font-size:11.5px;">Xem chi tiết báo lỗi</button>` : ""}
              </div>
              <span class="activity-time">${escapeHtml(timeStr)}</span>
            </div>
          `;
        }).join("");

    panel.innerHTML = `
      <div class="admin-card">
        <div class="admin-card-head">
          <div>
            <h2 class="admin-title">Trạng thái Đang hoạt động (Thời gian thực) của từng Nhân sự</h2>
            <p class="admin-sub">Hiển thị nhân sự nào đang mở ứng dụng (chấm xanh) và họ đang đọc bài nào, đang làm bài thi nào hay đang soạn câu hỏi nào.</p>
          </div>
          <button type="button" class="btn-secondary" id="btnRefreshPresenceNow">Làm mới trạng thái</button>
        </div>
        <div class="presence-grid">${presenceCardsHtml}</div>
      </div>

      <div class="admin-card" style="margin-top:14px;">
        <div class="admin-card-head">
          <div>
            <h2 class="admin-title">Lịch sử Hoạt động Chi tiết (${filteredLogs.length} bản ghi)</h2>
            <p class="admin-sub">Ghi lại đầy đủ thời gian đăng nhập, đọc tài liệu, bắt đầu làm bài, nộp bài thi của Học Viên và lịch sử tải tài liệu, tạo/sửa câu hỏi của Đào tạo.</p>
          </div>
          <div class="study-filter-pills">
            <button type="button" class="study-filter-pill ${activityRoleFilter === 'ALL' ? 'active' : ''}" data-act-filter="ALL">Tất cả</button>
            <button type="button" class="study-filter-pill ${activityRoleFilter === 'sale' ? 'active' : ''}" data-act-filter="sale">Học Viên</button>
            <button type="button" class="study-filter-pill ${activityRoleFilter === 'uploader' ? 'active' : ''}" data-act-filter="uploader">Đào tạo</button>
            <button type="button" class="study-filter-pill ${activityRoleFilter === 'admin' ? 'active' : ''}" data-act-filter="admin">Admin</button>
          </div>
        </div>
        <div class="activity-log-list">${logsHtml}</div>
      </div>
    `;

    const btnRef = document.getElementById("btnRefreshPresenceNow");
    if (btnRef) {
      btnRef.onclick = async () => {
        btnRef.textContent = "Đang cập nhật...";
        await fetchCloudDb(true);
      };
    }

    panel.querySelectorAll("[data-act-filter]").forEach(btn => {
      btn.onclick = () => {
        activityRoleFilter = btn.dataset.actFilter;
        renderAdminActivityPanel();
      };
    });

    panel.querySelectorAll("[data-open-bug-list-from-act]").forEach(btn => {
      btn.onclick = () => {
        openBugReportModal({ initialTab: "list" });
      };
    });
  }

  // =========================================================================
  // ADMIN PANEL 6 & ĐÀO TẠO TAB 3: BUG REPORTS WITH SCREENSHOTS
  // =========================================================================
  let bugStatusFilter = "ALL";
  let pendingBugImageDataUrl = "";
  let pendingBugContextMeta = {};
  let activeBugModalTab = "list";

  function updateBugModalTabCounters() {
    const allBugs = Array.isArray(db.bugReports) ? db.bugReports : [];
    const openCount = allBugs.filter(b => b.status !== "resolved").length;
    const lbl = document.getElementById("lblBugModalListCount");
    if (lbl) {
      lbl.textContent = openCount > 0 ? `${openCount} chờ xử lý / ${allBugs.length}` : String(allBugs.length);
    }
  }

  function switchBugModalTab(tabName) {
    activeBugModalTab = tabName === "form" ? "form" : "list";
    const btnList = document.getElementById("btnBugModalTabList");
    const btnForm = document.getElementById("btnBugModalTabForm");
    const listView = document.getElementById("bugModalListView");
    const formView = document.getElementById("formBugReport");

    if (btnList) btnList.classList.toggle("active", activeBugModalTab === "list");
    if (btnForm) btnForm.classList.toggle("active", activeBugModalTab === "form");
    if (listView) listView.classList.toggle("hidden", activeBugModalTab !== "list");
    if (formView) formView.classList.toggle("hidden", activeBugModalTab !== "form");

    updateBugModalTabCounters();
    if (activeBugModalTab === "list") {
      renderBugReportsPanelInto("bugModalListView");
    } else {
      const descInp = document.getElementById("bugDescriptionInput");
      if (descInp) descInp.focus();
    }
  }

  function renderBugReportsPanelInto(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const allBugs = Array.isArray(db.bugReports) ? db.bugReports : [];
    const openCount = allBugs.filter(b => b.status !== "resolved").length;
    updateBugModalTabCounters();

    const filtered = allBugs.filter(b => {
      if (bugStatusFilter === "OPEN") return b.status !== "resolved";
      if (bugStatusFilter === "RESOLVED") return b.status === "resolved";
      return true;
    });

    const cardsHtml = filtered.length === 0
      ? `<div style="padding:28px;text-align:center;color:#64748B;">Chưa có báo lỗi hoặc phản hồi nào trong mục này.</div>`
      : filtered.map(b => {
          const isResolved = b.status === "resolved";
          const createdStr = b.createdAt ? new Date(b.createdAt).toLocaleString("vi-VN") : "";
          const roleLabel = b.reporterRole === "admin" ? "Admin" : (b.reporterRole === "uploader" ? "Đào tạo" : "Học Viên");
          return `
            <div class="bug-item-card ${isResolved ? "resolved" : "open"}">
              <div class="bug-item-head">
                <div class="bug-item-meta">
                  <span class="sidebar-item-status ${isResolved ? "done" : "pending"}">
                    ${isResolved ? "✓ Đã xử lý" : "Chờ xử lý"}
                  </span>
                  <strong>${escapeHtml(b.targetContext || "Báo lỗi chung")}</strong>
                  <span class="qq-cat-badge">${escapeHtml(b.category || "Báo lỗi")}</span>
                </div>
                <span class="activity-time">
                  Người gửi: <strong>${escapeHtml(b.reporterName || "")}</strong> (${roleLabel}) · ${escapeHtml(createdStr)}
                </span>
              </div>

              <div style="font-size:14px;line-height:1.62;color:#0F172A;white-space:pre-line;background:#FFFBF5;border:1px solid #FED7AA;padding:10px 13px;border-radius:9px;">
                ${escapeHtml(b.description || "")}
              </div>

              ${b.screenshotDataUrl ? `
                <div>
                  <img src="${escapeHtml(b.screenshotDataUrl)}" alt="Ảnh chụp màn hình báo lỗi" class="bug-thumb-img" data-zoom-bug-img="${escapeHtml(b.id)}" title="Bấm vào ảnh để phóng to">
                </div>
              ` : ""}

              ${isResolved && b.resolvedBy ? `
                <div style="font-size:12px;color:#065F46;background:#ECFDF5;padding:7px 10px;border-radius:7px;">
                  ✓ Đã được xử lý bởi <strong>${escapeHtml(b.resolvedBy)}</strong> lúc ${b.resolvedAt ? escapeHtml(new Date(b.resolvedAt).toLocaleString("vi-VN")) : ""}
                </div>
              ` : ""}

              <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding-top:4px;">
                ${(b.moduleId && currentUser && currentUser.role !== "sale") ? `
                  <button type="button" class="btn-row-act" data-bug-goto-edit="${escapeHtml(b.id)}">
                    Mở sửa câu hỏi / bài học này ngay
                  </button>
                ` : ""}
                ${(currentUser && currentUser.role !== "sale") ? `
                  <button type="button" class="btn-row-act ${isResolved ? "" : "save"}" data-bug-toggle-resolve="${escapeHtml(b.id)}">
                    ${isResolved ? "Mở lại báo lỗi" : "✓ Đánh dấu Đã xử lý"}
                  </button>
                  <button type="button" class="btn-row-act danger" data-bug-delete="${escapeHtml(b.id)}">
                    Xóa
                  </button>
                ` : ""}
              </div>
            </div>
          `;
        }).join("");

    const isInsideModal = containerId === "bugModalListView";
    container.innerHTML = `
      <div class="admin-card" style="${isInsideModal ? 'border:none;padding:2px;box-shadow:none;' : ''}">
        <div class="admin-card-head" style="${isInsideModal ? 'padding-bottom:10px;margin-bottom:10px;' : ''}">
          <div>
            <h2 class="admin-title" style="${isInsideModal ? 'font-size:15.5px;' : ''}">Danh sách Báo lỗi &amp; Phản hồi (${openCount} lỗi chờ xử lý / Tổng ${allBugs.length})</h2>
            <p class="admin-sub">Nội dung chi tiết các báo lỗi và ảnh chụp màn hình do Học Viên hoặc Đào tạo gửi lên.</p>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <div class="study-filter-pills">
              <button type="button" class="study-filter-pill ${bugStatusFilter === 'ALL' ? 'active' : ''}" data-bug-filter="ALL">Tất cả (${allBugs.length})</button>
              <button type="button" class="study-filter-pill ${bugStatusFilter === 'OPEN' ? 'active' : ''}" data-bug-filter="OPEN">Chờ xử lý (${openCount})</button>
              <button type="button" class="study-filter-pill ${bugStatusFilter === 'RESOLVED' ? 'active' : ''}" data-bug-filter="RESOLVED">Đã xử lý (${allBugs.length - openCount})</button>
            </div>
            <button type="button" class="btn-primary" id="btnNewBugFromList_${escapeHtml(containerId)}">+ Tạo báo lỗi mới</button>
          </div>
        </div>
        <div class="bug-card-list">${cardsHtml}</div>
      </div>
    `;

    const btnNew = container.querySelector(`#btnNewBugFromList_${containerId}`);
    if (btnNew) {
      btnNew.onclick = () => {
        if (isInsideModal) {
          switchBugModalTab("form");
        } else {
          openBugReportModal({ initialTab: "form" });
        }
      };
    }

    container.querySelectorAll("[data-bug-filter]").forEach(btn => {
      btn.onclick = () => {
        bugStatusFilter = btn.dataset.bugFilter;
        renderBugReportsPanelInto(containerId);
      };
    });

    container.querySelectorAll("[data-zoom-bug-img]").forEach(img => {
      img.onclick = () => {
        const bug = (db.bugReports || []).find(item => item.id === img.dataset.zoomBugImg);
        if (!bug || !bug.screenshotDataUrl) return;
        document.getElementById("lightboxTitle").textContent = bug.targetContext || "Ảnh chụp màn hình Báo lỗi";
        document.getElementById("lightboxImg").src = bug.screenshotDataUrl;
        document.getElementById("lightboxDialog").showModal();
      };
    });

    container.querySelectorAll("[data-bug-goto-edit]").forEach(btn => {
      btn.onclick = () => {
        const bug = (db.bugReports || []).find(item => item.id === btn.dataset.bugGotoEdit);
        if (!bug || !bug.moduleId) return;
        const dlg = document.getElementById("bugReportDialog");
        if (dlg && dlg.open) dlg.close();
        currentModuleId = bug.moduleId;
        activeWorkspaceView = "uploader";
        if (bug.questionIndex !== null && bug.questionIndex !== undefined) {
          activeUploaderTab = "quiz";
          expandedUploaderQuestionIndex = Number(bug.questionIndex);
        } else {
          activeUploaderTab = "doc";
        }
        renderAll();
      };
    });

    container.querySelectorAll("[data-bug-toggle-resolve]").forEach(btn => {
      btn.onclick = () => {
        const bug = (db.bugReports || []).find(item => item.id === btn.dataset.bugToggleResolve);
        if (!bug) return;
        if (bug.status === "resolved") {
          bug.status = "open";
          bug.resolvedBy = "";
          bug.resolvedAt = null;
        } else {
          bug.status = "resolved";
          bug.resolvedBy = currentUser ? currentUser.name : "Admin";
          bug.resolvedAt = new Date().toISOString();
          logUserActivity("resolve_bug", "Đánh dấu đã xử lý báo lỗi", bug.targetContext || "");
        }
        bug.updatedAt = new Date().toISOString();
        if (!db.meta) db.meta = {};
        db.meta.bugsModified = true;
        triggerAutoSave(true, false);
        renderTopBar();
        renderBugReportsPanelInto(containerId);
        if (containerId !== "bugModalListView") renderBugReportsPanelInto("bugModalListView");
        if (activeWorkspaceView === "admin") renderAdminWorkspace();
      };
    });

    container.querySelectorAll("[data-bug-delete]").forEach(btn => {
      btn.onclick = () => {
        const bug = (db.bugReports || []).find(item => item.id === btn.dataset.bugDelete);
        if (!bug) return;
        if (confirm("Xóa báo lỗi này?")) {
          db.bugReports = (db.bugReports || []).filter(item => item.id !== bug.id);
          if (!db.meta) db.meta = {};
          db.meta.bugsModified = true;
          triggerAutoSave(true, false);
          renderTopBar();
          renderBugReportsPanelInto(containerId);
          if (containerId !== "bugModalListView") renderBugReportsPanelInto("bugModalListView");
          if (activeWorkspaceView === "admin") renderAdminWorkspace();
        }
      };
    });
  }

  function compressImageBlobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const maxDim = 1100;
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) {
              h = Math.round((h * maxDim) / w);
              w = maxDim;
            } else {
              w = Math.round((w * maxDim) / h);
              h = maxDim;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.78));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function setBugPreviewImage(dataUrl) {
    pendingBugImageDataUrl = dataUrl || "";
    const wrap = document.getElementById("bugImagePreviewWrap");
    const img = document.getElementById("bugImagePreview");
    const promptEl = document.getElementById("bugPastePromptText");
    if (!wrap || !img || !promptEl) return;
    if (pendingBugImageDataUrl) {
      img.src = pendingBugImageDataUrl;
      wrap.classList.remove("hidden");
      promptEl.classList.add("hidden");
    } else {
      img.src = "";
      wrap.classList.add("hidden");
      promptEl.classList.remove("hidden");
    }
  }

  function openBugReportModal(prefill = {}) {
    const mod = getCurrentModule();
    const defaultTarget = prefill.targetContext || (mod ? `${mod.code} — ${mod.title}` : "Hệ thống Cẩm nang Tư vấn");
    pendingBugContextMeta = {
      moduleId: prefill.moduleId !== undefined ? prefill.moduleId : (mod ? mod.id : ""),
      moduleCode: prefill.moduleCode !== undefined ? prefill.moduleCode : (mod ? mod.code : ""),
      moduleTitle: prefill.moduleTitle !== undefined ? prefill.moduleTitle : (mod ? mod.title : ""),
      questionId: prefill.questionId || null,
      questionIndex: prefill.questionIndex !== undefined ? prefill.questionIndex : null
    };

    const targetInp = document.getElementById("bugTargetContext");
    const catSel = document.getElementById("bugCategorySelect");
    const descInp = document.getElementById("bugDescriptionInput");
    if (targetInp) targetInp.value = defaultTarget;
    if (catSel && prefill.category) catSel.value = prefill.category;
    if (descInp) descInp.value = "";
    setBugPreviewImage("");

    const initialTab = prefill.initialTab || "form";
    switchBugModalTab(initialTab);

    const dlg = document.getElementById("bugReportDialog");
    if (dlg) {
      if (!dlg.open) dlg.showModal();
      if (initialTab === "form" && descInp) descInp.focus();
    }

    // Sync latest bug reports from cloud in the background whenever the modal opens
    fetchCloudDb(false).then(() => {
      renderTopBar();
      updateBugModalTabCounters();
      if (activeBugModalTab === "list") {
        renderBugReportsPanelInto("bugModalListView");
      }
    }).catch(() => {});
  }

  function setupBugReportDialog() {
    const btnTabList = document.getElementById("btnBugModalTabList");
    const btnTabForm = document.getElementById("btnBugModalTabForm");
    if (btnTabList) {
      btnTabList.addEventListener("click", () => switchBugModalTab("list"));
    }
    if (btnTabForm) {
      btnTabForm.addEventListener("click", () => switchBugModalTab("form"));
    }

    const btnTopBug = document.getElementById("btnTopOpenBugReport");
    if (btnTopBug) {
      btnTopBug.addEventListener("click", () => {
        const mod = getCurrentModule();
        let targetContext = mod ? `${mod.code} — ${mod.title}` : "Báo lỗi chung";
        let questionIndex = null;
        if (activeWorkspaceView === "sale" && activeSaleTab === "quiz" && mod && Array.isArray(mod.questions) && mod.questions[activeQuizQuestionIndex]) {
          targetContext = `${mod.code} — Câu hỏi ${activeQuizQuestionIndex + 1}`;
          questionIndex = activeQuizQuestionIndex;
        }
        const hasExistingBugs = Array.isArray(db.bugReports) && db.bugReports.length > 0;
        const isStaffOrAdmin = currentUser && (currentUser.role === "admin" || currentUser.role === "uploader");
        openBugReportModal({
          targetContext,
          moduleId: mod ? mod.id : "",
          moduleCode: mod ? mod.code : "",
          moduleTitle: mod ? mod.title : "",
          questionIndex,
          initialTab: (hasExistingBugs || isStaffOrAdmin) ? "list" : "form"
        });
      });
    }

    const fileInp = document.getElementById("bugImageFileInput");
    if (fileInp) {
      fileInp.addEventListener("change", async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const dataUrl = await compressImageBlobToDataUrl(file);
          setBugPreviewImage(dataUrl);
        } catch (err) {}
        fileInp.value = "";
      });
    }

    // Drag & Drop image support on #bugPasteZone AND anywhere inside #bugReportDialog
    const pasteZone = document.getElementById("bugPasteZone");
    const bugDlgEl = document.getElementById("bugReportDialog");
    async function handleDroppedImageEvent(e) {
      e.preventDefault();
      e.stopPropagation();
      if (pasteZone) pasteZone.classList.remove("drag-over");
      const dt = e.dataTransfer;
      if (!dt) return;
      let imgFile = null;
      if (dt.files && dt.files.length > 0) {
        imgFile = Array.from(dt.files).find(f => !f.type || f.type.startsWith("image/")) || dt.files[0];
      } else if (dt.items && dt.items.length > 0) {
        const item = Array.from(dt.items).find(it => it.kind === "file");
        if (item) imgFile = item.getAsFile();
      }
      if (!imgFile) return;
      try {
        if (activeBugModalTab !== "form") switchBugModalTab("form");
        const dataUrl = await compressImageBlobToDataUrl(imgFile);
        setBugPreviewImage(dataUrl);
      } catch (err) {}
    }

    [pasteZone, bugDlgEl].forEach(targetEl => {
      if (!targetEl) return;
      ["dragenter", "dragover"].forEach(evName => {
        targetEl.addEventListener(evName, e => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          if (pasteZone) pasteZone.classList.add("drag-over");
        });
      });
      ["dragleave", "dragend"].forEach(evName => {
        targetEl.addEventListener(evName, e => {
          e.preventDefault();
          e.stopPropagation();
          if (targetEl === pasteZone && pasteZone) pasteZone.classList.remove("drag-over");
        });
      });
      targetEl.addEventListener("drop", handleDroppedImageEvent);
    });

    const btnRemoveImg = document.getElementById("btnRemoveBugImage");
    if (btnRemoveImg) {
      btnRemoveImg.addEventListener("click", e => {
        e.stopPropagation();
        setBugPreviewImage("");
      });
    }

    // Global paste listener when bugReportDialog is open so pressing Ctrl+V / Cmd+V anywhere in the dialog pastes the clipboard screenshot
    document.addEventListener("paste", async e => {
      const dlg = document.getElementById("bugReportDialog");
      if (!dlg || !dlg.open) return;
      const items = (e.clipboardData && e.clipboardData.items) ? Array.from(e.clipboardData.items) : [];
      const imgItem = items.find(it => it.type && it.type.startsWith("image/"));
      if (!imgItem) return;
      e.preventDefault();
      const blob = imgItem.getAsFile();
      if (!blob) return;
      try {
        if (activeBugModalTab !== "form") switchBugModalTab("form");
        const dataUrl = await compressImageBlobToDataUrl(blob);
        setBugPreviewImage(dataUrl);
      } catch (err) {}
    });

    const form = document.getElementById("formBugReport");
    if (form) {
      form.addEventListener("submit", e => {
        e.preventDefault();
        const targetContext = document.getElementById("bugTargetContext").value.trim() || "Báo lỗi chung";
        const category = document.getElementById("bugCategorySelect").value;
        const description = document.getElementById("bugDescriptionInput").value.trim();
        if (!description) return;

        if (!Array.isArray(db.bugReports)) db.bugReports = [];
        const newBug = {
          id: "bug-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
          reporterId: currentUser ? currentUser.id : "guest",
          reporterName: currentUser ? currentUser.name : "Ẩn danh",
          reporterRole: currentUser ? currentUser.role : "sale",
          targetContext,
          category,
          description,
          screenshotDataUrl: pendingBugImageDataUrl || "",
          moduleId: pendingBugContextMeta.moduleId || "",
          moduleCode: pendingBugContextMeta.moduleCode || "",
          moduleTitle: pendingBugContextMeta.moduleTitle || "",
          questionId: pendingBugContextMeta.questionId || null,
          questionIndex: pendingBugContextMeta.questionIndex,
          status: "open",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          resolvedBy: "",
          resolvedAt: null
        };

        db.bugReports.unshift(newBug);
        if (!db.meta) db.meta = {};
        db.meta.bugsModified = true;
        logUserActivity("report_bug", "Gửi báo lỗi / phản hồi", `${targetContext}: ${description}`, newBug.moduleCode);
        triggerAutoSave(true, false);
        switchBugModalTab("list");
        renderAll();
        alert("✓ Đã gửi Báo lỗi cho Admin và bộ phận Đào tạo! Cảm ơn phản hồi của bạn.");
      });
    }
  }

  function renderAll() {
    const authPortal = document.getElementById("authPortal");
    const mainTopBar = document.getElementById("mainTopBar");
    const appShell = document.getElementById("appShell");
    const sidebar = document.getElementById("moduleSidebar");
    const saleWs = document.getElementById("saleWorkspace");
    const upWs = document.getElementById("uploaderWorkspace");
    const adminWs = document.getElementById("adminWorkspace");

    if (!currentUser) {
      authPortal.classList.remove("hidden");
      mainTopBar.classList.add("hidden");
      appShell.classList.add("hidden");
      populateAuthSelects();
      return;
    }

    authPortal.classList.add("hidden");
    mainTopBar.classList.remove("hidden");
    appShell.classList.remove("hidden");

    // Role guardrails
    if (currentUser.role === "sale") {
      activeWorkspaceView = "sale";
    } else if (currentUser.role === "uploader" && activeWorkspaceView === "admin") {
      activeWorkspaceView = "uploader";
    }

    renderTopBar();
    sendPresenceHeartbeat();

    if (activeWorkspaceView === "admin") {
      sidebar.classList.add("hidden");
      saleWs.classList.add("hidden");
      upWs.classList.add("hidden");
      adminWs.classList.remove("hidden");
      renderAdminWorkspace();
    } else if (activeWorkspaceView === "uploader") {
      sidebar.classList.remove("hidden");
      saleWs.classList.add("hidden");
      adminWs.classList.add("hidden");
      upWs.classList.remove("hidden");
      renderSidebar();
      renderUploaderWorkspace();
    } else {
      sidebar.classList.remove("hidden");
      upWs.classList.add("hidden");
      adminWs.classList.add("hidden");
      saleWs.classList.remove("hidden");
      renderSidebar();
      renderSaleWorkspace();
    }
  }

  // Initialize application
  populateAuthSelects();
  setupAuthPortal();
  setupSidebarAndDialogs();
  setupUploaderAndAdminEvents();
  setupBugReportDialog();
  renderAll();
  fetchServerDb();

  // Periodic real-time presence heartbeat & cloud sync every 15s when tab is visible
  setInterval(() => {
    if (document.visibilityState === "visible" && currentUser) {
      sendPresenceHeartbeat();
      fetchCloudDb(false);
    }
  }, 15000);

  // Auto-refresh cloud state when tab becomes visible
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      sendPresenceHeartbeat();
      fetchCloudDb(false);
    }
  });
})();
