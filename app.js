(function () {
  "use strict";

  const STORAGE_KEY = "NOVASTARS_SALE_TRAINING_DB_V1";
  const SESSION_KEY = "NOVASTARS_SALE_CURRENT_USER_V1";
  const NEON_FUNCTION_URL = "https://br-proud-wildflower-bisjmocc-hello.compute.c-5.ap-southeast-1.aws.neon.tech";
  const ROW_CONFIG_ID = "sale_training__config";
  const ROW_PROG_PREFIX = "sale_training__prog__";

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
        meta: { appName: "Cẩm Nang Tư Vấn Mầm Non Chuyển Giao", adminPin: "8888", defaultPassThreshold: 80 },
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
    const targetRosterVersion = (window.INITIAL_TRAINING_DB && window.INITIAL_TRAINING_DB.meta && window.INITIAL_TRAINING_DB.meta.rosterVersion) || 2;
    if (!result.meta) result.meta = {};
    if ((result.meta.rosterVersion || 0) < targetRosterVersion && window.INITIAL_TRAINING_DB && Array.isArray(window.INITIAL_TRAINING_DB.users)) {
      result.users = JSON.parse(JSON.stringify(window.INITIAL_TRAINING_DB.users));
      result.meta.rosterVersion = targetRosterVersion;
      result.meta.updatedAt = new Date().toISOString();
    }
    if (!Array.isArray(result.modules)) {
      result.modules = (window.INITIAL_TRAINING_DB && Array.isArray(window.INITIAL_TRAINING_DB.modules))
        ? JSON.parse(JSON.stringify(window.INITIAL_TRAINING_DB.modules))
        : [];
    }
    if (!Array.isArray(result.progress)) result.progress = [];

    localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
    return result;
  }

  function loadInitialUser() {
    const params = new URLSearchParams(window.location.search);
    const userParam = params.get("user") || params.get("gv");
    const pinParam = params.get("pin");
    const adminPin = (db.meta && db.meta.adminPin) ? String(db.meta.adminPin).trim() : "8888";

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
    return firstSale || { id: "preview-sale", name: "Sale (Xem thử)", role: "sale" };
  }

  function getVisibleModulesForLearner() {
    return (db.modules || []).filter(m => m.status !== "draft");
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

      rows.forEach(row => {
        if (row.id === ROW_CONFIG_ID && row.payload) {
          cloudConfig = row.payload;
        } else if (row.id && row.id.startsWith(ROW_PROG_PREFIX) && row.payload) {
          cloudProgress.push(row.payload);
        }
      });

      if (cloudConfig) {
        const cloudTime = Date.parse((cloudConfig.meta && cloudConfig.meta.updatedAt) || "") || 0;
        const localTime = Date.parse((db.meta && db.meta.updatedAt) || "") || 0;

        if (cloudTime >= localTime) {
          if (cloudConfig.meta) {
            db.meta = { ...db.meta, ...cloudConfig.meta };
          }
          if (Array.isArray(cloudConfig.users)) {
            db.users = cloudConfig.users;
          }
          if (Array.isArray(cloudConfig.modules) && cloudConfig.modules.length > 0) {
            const localStructMap = new Map();
            (db.modules || []).forEach(m => {
              if (m.structuredData) localStructMap.set(m.id, m.structuredData);
            });
            db.modules = cloudConfig.modules.map(cm => ({
              ...cm,
              structuredData: cm.structuredData || localStructMap.get(cm.id)
            }));
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
      selSale.innerHTML = `<option value="" disabled selected>-- Chọn tên Sale --</option>`;
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
        renderAll();
      });
    }

    if (formUploader) {
      formUploader.addEventListener("submit", e => {
        e.preventDefault();
        const userId = document.getElementById("authSelectUploader").value;
        const pin = document.getElementById("authUploaderPin").value.trim();
        const adminPin = (db.meta && db.meta.adminPin) ? String(db.meta.adminPin).trim() : "8888";
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
        localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
        renderAll();
      });
    }

    if (formAdmin) {
      formAdmin.addEventListener("submit", e => {
        e.preventDefault();
        const pin = document.getElementById("authAdminPin").value.trim();
        const adminPin = (db.meta && db.meta.adminPin) ? String(db.meta.adminPin).trim() : "8888";
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
      nameEl.textContent = "Sale · " + currentUser.name;
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

    // Learner Overall Progress Card
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
        isUploaderView ? "Tổng quan Học phần" : `Tiến độ: ${learner.name}`;
      document.getElementById("lblSidebarProgressPct").textContent =
        isUploaderView ? `${pubMods.length}/${(db.modules || []).length}` : `${pct}%`;
      document.getElementById("sidebarProgressBarFill").style.width =
        isUploaderView ? "100%" : `${pct}%`;
      document.getElementById("lblSidebarProgressSub").textContent =
        isUploaderView
          ? `${pubMods.length} bài đã xuất bản · ${db.modules.reduce((acc, m) => acc + (m.questions ? m.questions.length : 0), 0)} câu hỏi`
          : `Đã đạt ${passedCount}/${pubMods.length} học phần (Điểm chuẩn >= 80%)`;
    }

    const q = sidebarSearchQuery.trim().toLowerCase();
    const filtered = modulesList.filter(m => {
      if (!q) return true;
      return (
        (m.code || "").toLowerCase().includes(q) ||
        (m.title || "").toLowerCase().includes(q) ||
        (m.category || "").toLowerCase().includes(q)
      );
    });

    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="padding:24px 12px;text-align:center;color:#64748B;font-size:12.5px;">Không tìm thấy học phần phù hợp.</div>`;
      return;
    }

    // Group by category
    const grouped = {};
    filtered.forEach(m => {
      const cat = m.category || "Chuyên đề Đào tạo";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(m);
    });

    listEl.innerHTML = "";
    Object.keys(grouped).forEach(catName => {
      const groupEl = document.createElement("div");
      groupEl.className = "sidebar-grade-group";

      const titleEl = document.createElement("div");
      titleEl.className = "grade-group-title";
      titleEl.innerHTML = `<span>${escapeHtml(catName)}</span><span>${grouped[catName].length} bài</span>`;
      groupEl.appendChild(titleEl);

      const itemsWrap = document.createElement("div");
      itemsWrap.className = "grade-lessons-list";

      grouped[catName].forEach(mod => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sidebar-lesson-item" + (mod.id === currentModuleId ? " active" : "");

        let statusHtml = "";
        const qCount = Array.isArray(mod.questions) ? mod.questions.length : 0;

        if (isUploaderView) {
          if (mod.status === "draft") {
            statusHtml = `<span class="sidebar-item-status draft">✎ Bản nháp</span>`;
          } else {
            statusHtml = `<span class="sidebar-item-status done">${qCount} câu hỏi</span>`;
          }
        } else {
          const prog = (db.progress || []).find(p => p.userId === learner.id && p.moduleId === mod.id);
          if (prog && prog.passed) {
            statusHtml = `<span class="sidebar-item-status done">✓ Đạt ${prog.bestScore}%</span>`;
          } else if (prog && Array.isArray(prog.attempts) && prog.attempts.length > 0) {
            statusHtml = `<span class="sidebar-item-status failed">${prog.bestScore}% (Làm lại)</span>`;
          } else if (prog && prog.docViewed) {
            statusHtml = `<span class="sidebar-item-status reading">Đã đọc bài</span>`;
          } else {
            statusHtml = `<span class="sidebar-item-status empty">Chưa học</span>`;
          }
        }

        btn.innerHTML = `
          <div class="sidebar-item-top">
            <span class="sidebar-item-code">${escapeHtml(mod.code)}</span>
            ${statusHtml}
          </div>
          <div class="sidebar-item-title">${escapeHtml(mod.title)}</div>
          <div class="sidebar-item-meta">
            <span>${qCount} câu trắc nghiệm</span>
            <span>·</span>
            <span>Chuẩn &ge;${mod.passThreshold || 80}%</span>
          </div>
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

        itemsWrap.appendChild(btn);
      });

      groupEl.appendChild(itemsWrap);
      listEl.appendChild(groupEl);
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
          ? `Đang xem giao diện của Sale: <strong>${escapeHtml(impersonatedSaleUser.name)}</strong>`
          : `Đang xem thử giao diện của <strong>Sale</strong>`;
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

  function buildDocumentSteps(mod) {
    // 1. HP01: 6 Comparison Criteria -> 6 clean steps
    if (mod.structuredType === "comparison_6_criteria" && Array.isArray(mod.structuredData)) {
      return mod.structuredData.map((item, idx) => ({
        pillLabel: `Mục ${idx + 1}`,
        title: `${item.stt}. ${item.title}`,
        html: `
          <article class="study-topic-card">
            <div class="stc-head">
              <div class="stc-head-left">
                <span class="stc-num">Mục ${escapeHtml(item.stt)}/6</span>
                <h4 class="stc-title">${escapeHtml(item.title)}</h4>
              </div>
            </div>
            <div class="stc-grid-2">
              <div class="stc-box traditional">
                <div class="stc-box-label">Chương trình Bộ GD&amp;ĐT</div>
                <div class="stc-box-content">${escapeHtml(item.bo_gddt)}</div>
              </div>
              <div class="stc-box novastars">
                <div class="stc-box-label">Chương trình KNS Novastars</div>
                <div class="stc-box-content">${escapeHtml(item.novastars)}</div>
              </div>
              <div class="stc-box usp">
                <div class="stc-box-label">Điểm khác biệt ăn tiền</div>
                <div class="stc-box-content">${escapeHtml(item.khac_biet_an_tien)}</div>
              </div>
              <div class="stc-box pitch">
                <div class="stc-box-label">Câu chốt nói với Chủ trường / Hiệu trưởng</div>
                <div class="stc-box-content"><strong>"${escapeHtml(item.sale_pitch)}"</strong></div>
              </div>
            </div>
          </article>
        `
      }));
    }

    // 2. HP02: 6 Pedagogical Reasons -> 6 clean steps
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
            <div class="stc-grid-2">
              <div class="stc-box traditional">
                <div class="stc-box-label">Tâm lý trẻ &amp; Cách trường thường dạy</div>
                <div class="stc-box-content"><strong>• Tâm lý trẻ:</strong> ${escapeHtml(item.tam_ly_tre)}\n\n<strong>• Trường thường dạy:</strong> ${escapeHtml(item.cach_truong_thuong_day)}</div>
              </div>
              <div class="stc-box novastars">
                <div class="stc-box-label">Cách Novastars thiết kế sẵn</div>
                <div class="stc-box-content">${escapeHtml(item.cach_novastars)}</div>
              </div>
              <div class="stc-box pitch" style="grid-column: 1 / -1;">
                <div class="stc-box-label">Câu trả lời mẫu thuyết phục Chủ trường / Hiệu trưởng</div>
                <div class="stc-box-content"><strong>"${escapeHtml(item.sale_pitch)}"</strong></div>
              </div>
            </div>
          </article>
        `
      }));
    }

    // 3. HP03: 10 Sample Lessons -> 10 clean steps (1 lesson per card)
    if (mod.structuredType === "sample_10_lessons" && Array.isArray(mod.structuredData)) {
      return mod.structuredData.map((item, idx) => ({
        pillLabel: `Bài ${idx + 1} (${(item.bai_hoc || "").split(" ")[0]})`,
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
            <div class="stc-grid-2">
              <div class="stc-box traditional">
                <div class="stc-box-label">Cách trường thường dạy (${escapeHtml(item.de_tai_quen_thuoc)})</div>
                <div class="stc-box-content">${escapeHtml(item.cach_truong_thuong_day)}</div>
              </div>
              <div class="stc-box novastars">
                <div class="stc-box-label">Nội dung &amp; Cách triển khai của Novastars</div>
                <div class="stc-box-content">${escapeHtml(item.noi_dung_novastars)}\n\n${escapeHtml(item.cach_trien_khai)}</div>
              </div>
              <div class="stc-box pitch" style="grid-column: 1 / -1;">
                <div class="stc-box-label">Điểm ăn tiền để Sale thuyết phục Chủ trường</div>
                <div class="stc-box-content">${escapeHtml(item.diem_an_tien)}</div>
              </div>
            </div>
          </article>
        `
      }));
    }

    // 4. HP04: 3 Age Groups + 72-Lesson Lookup Table -> 4 clean steps
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
            <div class="stc-grid-2">
              <div class="stc-box traditional">
                <div class="stc-box-label">Nội dung trường vẫn dạy theo khung Bộ</div>
                <div class="stc-box-content">${escapeHtml(a.noi_dung_bo)}</div>
              </div>
              <div class="stc-box novastars">
                <div class="stc-box-label">Nội dung nâng cấp của Novastars</div>
                <div class="stc-box-content">${escapeHtml(a.noi_dung_novastars)}</div>
              </div>
              <div class="stc-box pitch" style="grid-column: 1 / -1;">
                <div class="stc-box-label">Điểm nhấn để Sale nói với Hiệu trưởng</div>
                <div class="stc-box-content"><strong>"${escapeHtml(a.diem_nhan_sale)}"</strong></div>
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
          (row.mg_nho || "").toLowerCase().includes(q) ||
          (row.mg_lon || "").toLowerCase().includes(q)
        );
      });

      const rows72Html = filtered72.map(r => `
        <tr>
          <td style="text-align:center;font-family:var(--font-mono);font-weight:700;">Tiết ${escapeHtml(r.tiet)}</td>
          <td><span class="mod-cat-pill">${escapeHtml(r.hoc_ki)}</span></td>
          <td>${escapeHtml(r.mg_be)}</td>
          <td>${escapeHtml(r.mg_nho)}</td>
          <td>${escapeHtml(r.mg_lon)}</td>
        </tr>
      `).join("");

      steps.push({
        pillLabel: "4. Tra cứu 72 tiết",
        title: "Danh sách đủ 72 tiết × 3 khối",
        html: `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            <input type="text" id="inputHp04Search" class="input-control" style="width:240px;padding:7px 11px;font-size:13px;" placeholder="Tìm tên bài trong 72 tiết..." value="${escapeHtml(hp04SearchQuery)}">
            <div style="display:flex;gap:6px;">
              <button type="button" class="study-filter-pill ${hp04TermFilter === 'ALL' ? 'active' : ''}" data-hp04-term="ALL">Cả năm (72)</button>
              <button type="button" class="study-filter-pill ${hp04TermFilter === 'Học kì I' ? 'active' : ''}" data-hp04-term="Học kì I">Học kì I (35)</button>
              <button type="button" class="study-filter-pill ${hp04TermFilter === 'Học kì II' ? 'active' : ''}" data-hp04-term="Học kì II">Học kì II (37)</button>
            </div>
          </div>
          <div class="table-responsive" style="max-height:420px;overflow-y:auto;">
            <table class="progress-matrix-table">
              <thead>
                <tr>
                  <th style="width:75px;text-align:center;">Tiết</th>
                  <th style="width:105px;">Học kì</th>
                  <th>Mẫu giáo Bé (3–4 tuổi)</th>
                  <th>Mẫu giáo Nhỡ (4–5 tuổi)</th>
                  <th>Mẫu giáo Lớn (5–6 tuổi)</th>
                </tr>
              </thead>
              <tbody>${rows72Html}</tbody>
            </table>
          </div>
        `
      });
      return steps;
    }

    // 5. Uploaded Tables or Plain Text -> Split into clean steps
    const customSteps = [];
    if (Array.isArray(mod.uploadedTables) && mod.uploadedTables.length > 0) {
      mod.uploadedTables.forEach((tbl, tIdx) => {
        const rows = tbl.rows || [];
        if (rows.length === 0) return;
        const trs = rows.map((r, rIdx) => {
          const tag = rIdx === 0 ? "th" : "td";
          const cells = r.map(c => `<${tag}>${escapeHtml(c)}</${tag}>`).join("");
          return `<tr>${cells}</tr>`;
        }).join("");
        customSteps.push({
          pillLabel: tbl.sheet ? tbl.sheet.slice(0, 18) : `Bảng ${tIdx + 1}`,
          title: tbl.sheet || `Bảng dữ liệu ${tIdx + 1}`,
          html: `<div class="table-responsive" style="max-height:450px;overflow-y:auto;"><table class="progress-matrix-table">${trs}</table></div>`
        });
      });
    }

    const rawText = (mod.contentText || "").trim();
    if (rawText && customSteps.length === 0) {
      const lines = rawText.split(/\n+/).map(l => l.trim()).filter(Boolean);
      const chunkSize = 8;
      for (let i = 0; i < lines.length; i += chunkSize) {
        const chunk = lines.slice(i, i + chunkSize);
        const stepNum = Math.floor(i / chunkSize) + 1;
        customSteps.push({
          pillLabel: `Phần ${stepNum}`,
          title: `Nội dung phần ${stepNum}`,
          html: `<div style="display:flex;flex-direction:column;gap:10px;">${chunk.map(p => `<p style="font-size:14.2px;line-height:1.65;">${escapeHtml(p)}</p>`).join("")}</div>`
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

    const pillsHtml = steps.map((st, idx) => `
      <button type="button" class="doc-step-pill ${idx === activeDocStepIndex ? 'active' : ''}" data-doc-step="${idx}">
        ${escapeHtml(st.pillLabel)}
      </button>
    `).join("");

    const downloadBtnHtml = (mod.sourceFile && mod.sourceFile.url)
      ? `<a href="${escapeHtml(mod.sourceFile.url)}" download="${escapeHtml(mod.sourceFile.name || 'Tai_lieu.xlsx')}" class="btn-download-source">Tải file gốc</a>`
      : "";

    const isLastStep = activeDocStepIndex === steps.length - 1;

    bodyContainer.innerHTML = `
      <div class="doc-stepper-bar">
        <div class="doc-step-pills">${pillsHtml}</div>
        ${downloadBtnHtml}
      </div>

      <div class="doc-active-step-body">
        ${currentStep.html}
      </div>

      <div class="doc-pager-footer">
        <button type="button" class="btn-secondary" id="btnDocPrevStep" ${activeDocStepIndex === 0 ? "disabled" : ""}>
          ◀ Mục trước
        </button>
        <span class="doc-pager-counter">Mục ${activeDocStepIndex + 1} / ${steps.length}</span>
        ${!isLastStep
          ? `<button type="button" class="btn-primary" id="btnDocNextStep">Mục tiếp theo ▶</button>`
          : `<button type="button" class="btn-start-quiz-cta" id="btnDocStartQuiz">Làm bài Trắc nghiệm ngay ➔</button>`
        }
      </div>
    `;

    bodyContainer.querySelectorAll("[data-doc-step]").forEach(btn => {
      btn.addEventListener("click", () => {
        activeDocStepIndex = Number(btn.dataset.docStep);
        renderSaleDocumentPanel(mod, prog, steps);
      });
    });

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

    // Bind HP04 table filters if on step 4
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
        <span class="qq-num-badge">Câu ${activeQuizQuestionIndex + 1} / ${qList.length}</span>
        <span class="qq-cat-badge ${escapeHtml(catKey)}">${escapeHtml(catLabel)}</span>
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
    const panelDoc = document.getElementById("uploaderPanelDoc");
    const panelQuiz = document.getElementById("uploaderPanelQuiz");

    btnTabDoc.classList.toggle("active", activeUploaderTab === "doc");
    btnTabQuiz.classList.toggle("active", activeUploaderTab === "quiz");
    panelDoc.classList.toggle("hidden", activeUploaderTab !== "doc");
    panelQuiz.classList.toggle("hidden", activeUploaderTab !== "quiz");

    btnTabDoc.onclick = () => {
      activeUploaderTab = "doc";
      renderUploaderWorkspace();
    };
    btnTabQuiz.onclick = () => {
      syncUploaderDocFieldsToModule(mod);
      activeUploaderTab = "quiz";
      renderUploaderWorkspace();
    };

    document.getElementById("upModStatus").value = mod.status || "published";
    document.getElementById("upModCode").value = mod.code || "HP";
    document.getElementById("upModCategory").value = mod.category || "Tài liệu Đào tạo";
    document.getElementById("upModDuration").value = mod.durationMinutes || 20;
    document.getElementById("upModThreshold").value = mod.passThreshold || 80;
    document.getElementById("upModTitle").value = mod.title || "";
    document.getElementById("upModSubtitle").value = mod.subtitle || "";
    document.getElementById("upModSummaryPoints").value = (mod.summaryPoints || []).join("\n");

    const textContent = mod.contentText || buildPlainTextFromStructuredData(mod);
    const contentTa = document.getElementById("upModContentText");
    contentTa.value = textContent;
    document.getElementById("lblDocCharCount").textContent = `${textContent.length.toLocaleString("vi-VN")} ký tự`;

    contentTa.oninput = () => {
      mod.contentText = contentTa.value;
      document.getElementById("lblDocCharCount").textContent = `${contentTa.value.length.toLocaleString("vi-VN")} ký tự`;
      triggerAutoSave(false, true);
    };

    const titleInp = document.getElementById("upModTitle");
    if (titleInp) {
      titleInp.oninput = () => {
        mod.title = titleInp.value.trim() || mod.title;
        triggerAutoSave(false, true);
        renderSidebar();
      };
    }

    document.getElementById("btnGoToQuizGenerator").onclick = () => {
      syncUploaderDocFieldsToModule(mod);
      triggerAutoSave(true, true);
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
    if (!mod) return;
    mod.status = document.getElementById("upModStatus").value || "published";
    mod.title = document.getElementById("upModTitle").value.trim() || mod.title || "Bài học mới";
    mod.contentText = document.getElementById("upModContentText").value;
    mod.updatedAt = new Date().toISOString();
  }

  function renderUploaderQuestionBank(mod) {
    if (!Array.isArray(mod.questions)) mod.questions = [];
    const qList = mod.questions;
    document.getElementById("lblUpQuestionCount").textContent = String(qList.length);

    const listContainer = document.getElementById("uploaderQuestionsList");
    listContainer.innerHTML = "";

    if (qList.length === 0) {
      listContainer.innerHTML = `
        <div class="up-card" style="text-align:center;padding:28px;color:#64748B;">
          Chưa có câu hỏi nào. Hãy bấm <strong>"Tạo tự động từ tài liệu"</strong> hoặc <strong>"📁 Tải file câu hỏi có sẵn"</strong> ở thanh công cụ phía trên.
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
            <button type="button" class="btn-q-mini" data-expand-q="${qIdx}">Sửa</button>
            <button type="button" class="btn-q-mini danger" data-del-q="${qIdx}" title="Xóa câu này"></button>
          </div>
        `;

        row.addEventListener("click", e => {
          if (e.target.closest("[data-del-q]")) return;
          expandedUploaderQuestionIndex = qIdx;
          renderUploaderQuestionBank(mod);
        });

        row.querySelector(`[data-del-q="${qIdx}"]`).addEventListener("click", e => {
          e.stopPropagation();
          if (confirm(`Xóa Câu ${qIdx + 1}?`)) {
            qList.splice(qIdx, 1);
            if (expandedUploaderQuestionIndex === qIdx) expandedUploaderQuestionIndex = null;
            triggerAutoSave(true, true);
            renderUploaderQuestionBank(mod);
            renderSidebar();
          }
        });

        listContainer.appendChild(row);
        return;
      }

      // EXPANDED EDITOR FOR ONLY THE SELECTED QUESTION
      const card = document.createElement("div");
      card.className = "up-q-card";

      const optsRowsHtml = [0, 1, 2, 3].map(oIdx => {
        const isCorrect = Number(q.correctIndex) === oIdx;
        const optVal = (q.options && q.options[oIdx]) ? q.options[oIdx] : "";
        return `
          <div class="up-q-opt-row">
            <button type="button" class="up-opt-radio-btn ${isCorrect ? "is-correct" : ""}" data-set-correct="${qIdx}:${oIdx}">
              ${isCorrect ? "✓ Đúng:" : "Chọn:"} ${letters[oIdx]}
            </button>
            <input type="text" class="input-control" data-edit-opt="${qIdx}:${oIdx}" value="${escapeHtml(optVal)}" placeholder="Phương án ${letters[oIdx]}...">
          </div>
        `;
      }).join("");

      card.innerHTML = `
        <div class="up-q-top">
          <div class="up-q-top-left">
            <span class="qq-num-badge">Đang sửa Câu ${qIdx + 1}</span>
          </div>
          <div class="up-q-actions">
            <button type="button" class="btn-q-mini danger" data-del-q="${qIdx}">Xóa câu</button>
            <button type="button" class="btn-primary" data-collapse-q="${qIdx}" style="padding:5px 12px;font-size:12px;">✓ Xong (Thu gọn)</button>
          </div>
        </div>

        <div class="form-group">
          <label>Câu hỏi:</label>
          <textarea class="input-control" rows="2" data-edit-qtext="${qIdx}">${escapeHtml(q.question || "")}</textarea>
        </div>

        <div class="up-q-options-grid">
          ${optsRowsHtml}
        </div>

        <div class="form-group">
          <label>Giải thích &amp; Gợi ý tư vấn:</label>
          <textarea class="input-control" rows="2" data-edit-exp="${qIdx}">${escapeHtml(q.explanation || "")}</textarea>
        </div>
      `;

      card.querySelector(`[data-collapse-q="${qIdx}"]`).addEventListener("click", () => {
        expandedUploaderQuestionIndex = null;
        triggerAutoSave(true, true);
        renderUploaderQuestionBank(mod);
      });

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

      card.querySelector(`[data-del-q="${qIdx}"]`).addEventListener("click", () => {
        if (confirm(`Xóa Câu ${qIdx + 1}?`)) {
          qList.splice(qIdx, 1);
          expandedUploaderQuestionIndex = null;
          triggerAutoSave(true, true);
          renderUploaderQuestionBank(mod);
          renderSidebar();
        }
      });

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

    for (let i = 0; i < desiredCount; i++) {
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

    // 2. Try Excel/Table rows if tables are provided
    if (Array.isArray(tables) && tables.length > 0) {
      tables.forEach(tbl => {
        const rows = tbl.rows || [];
        rows.forEach((row, rIdx) => {
          if (rIdx === 0 && /câu hỏi|question|stt/i.test(row.join(" "))) return;
          const cols = row.map(c => String(c || "").trim());
          // Support both [STT, Question, A, B, C, D, Correct, Explanation] and [Question, A, B, C, D, Correct, Explanation]
          let qCol = 0;
          if (/^\d+$/.test(cols[0]) && cols.length >= 6) qCol = 1;
          const qText = cols[qCol] || "";
          const optA = cols[qCol + 1] || "";
          const optB = cols[qCol + 2] || "";
          const optC = cols[qCol + 3] || "";
          const optD = cols[qCol + 4] || "";
          const ansRaw = (cols[qCol + 5] || "A").toUpperCase().trim();
          const expText = cols[qCol + 6] || "";

          if (qText.length > 8 && optA && optB) {
            let cIdx = 0;
            if (ansRaw.includes("B") || ansRaw === "2") cIdx = 1;
            else if (ansRaw.includes("C") || ansRaw === "3") cIdx = 2;
            else if (ansRaw.includes("D") || ansRaw === "4") cIdx = 3;

            parsedQuestions.push({
              id: `imp-tbl-${Date.now()}-${parsedQuestions.length + 1}`,
              category: "kien_thuc",
              categoryLabel: "1. Cấu trúc chương trình",
              question: qText,
              options: [optA, optB, optC || "Phương án C", optD || "Phương án D"],
              correctIndex: cIdx,
              explanation: expText || "Theo bộ câu hỏi đào tạo chuẩn."
            });
          }
        });
      });
      if (parsedQuestions.length > 0) return parsedQuestions;
    }

    // 3. Parse free-form Word / Markdown / Text blocks ("Câu 1: ... A. ... B. ... C. ... D. ... Đáp án: ...")
    const lines = (rawText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let curQ = null;

    function pushCurQ() {
      if (curQ && curQ.question && curQ.options.filter(Boolean).length >= 2) {
        while (curQ.options.length < 4) {
          curQ.options.push(`Phương án ${String.fromCharCode(65 + curQ.options.length)}`);
        }
        parsedQuestions.push(curQ);
      }
      curQ = null;
    }

    lines.forEach(line => {
      const qMatch = line.match(/^(?:#+\s*)?(?:Câu(?:\s+hỏi)?\s*\d+|Q\d+|\d+)[.:)\-]\s*(.+)$/i);
      const optMatch = line.match(/^[-*•]?\s*\**([A-D])[.:)\-]\**\s*(.+)$/i);
      const ansMatch = line.match(/^(?:👉\s*)?\**(?:Đáp\s*án(?:\s*đúng)?|Correct|Answer)\**\s*[:\-]\s*\**([A-D])\**/i);
      const expMatch = line.match(/^(?:💡\s*)?\**(?:Giải\s*thích|Ý\s*nghĩa|Gợi\s*ý(?:\s*tư\s*vấn)?)\**\s*[:\-]\s*(.+)$/i);

      if (qMatch && (!curQ || curQ.options.length >= 2)) {
        pushCurQ();
        curQ = {
          id: `imp-txt-${Date.now()}-${parsedQuestions.length + 1}`,
          category: "kien_thuc",
          categoryLabel: "1. Cấu trúc chương trình",
          question: qMatch[1].trim(),
          options: [],
          correctIndex: 0,
          explanation: ""
        };
      } else if (optMatch && curQ) {
        const letter = optMatch[1].toUpperCase();
        const idx = letter.charCodeAt(0) - 65;
        let optContent = optMatch[2].trim();
        if (/\(Đáp án đúng\)|\(Đúng\)/i.test(optContent)) {
          curQ.correctIndex = idx;
          optContent = optContent.replace(/\(Đáp án đúng\)|\(Đúng\)/gi, "").trim();
        }
        curQ.options[idx] = optContent;
      } else if (ansMatch && curQ) {
        const letter = ansMatch[1].toUpperCase();
        curQ.correctIndex = Math.max(0, Math.min(3, letter.charCodeAt(0) - 65));
      } else if (expMatch && curQ) {
        curQ.explanation = expMatch[1].trim();
      } else if (curQ && curQ.options.length === 0) {
        curQ.question += " " + line;
      }
    });
    pushCurQ();

    return parsedQuestions;
  }

  // =========================================================================
  // VIEW C: ADMIN (MANAGER) DASHBOARD RENDERING
  // =========================================================================
  function renderAdminWorkspace() {
    const sales = (db.users || []).filter(u => u.role === "sale");
    const pubMods = getVisibleModulesForLearner();

    document.getElementById("badgeAdminMatrixCount").textContent = `${sales.length} Sale`;
    document.getElementById("badgeAdminAnalyticsCount").textContent = `${pubMods.length} bài`;

    // Render KPI Strip
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
    const totalQuestions = pubMods.reduce((acc, m) => acc + (Array.isArray(m.questions) ? m.questions.length : 0), 0);

    kpiBar.innerHTML = `
      <div class="kpi-card">
        <span class="kpi-label">Nhân sự Sale</span>
        <span class="kpi-val">${sales.length} Sale</span>
        <span class="kpi-sub">Đang tham gia đào tạo</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Học phần &amp; Câu hỏi</span>
        <span class="kpi-val">${pubMods.length} bài</span>
        <span class="kpi-sub">Tổng ${totalQuestions} câu trắc nghiệm</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Tỷ lệ Đạt toàn đội</span>
        <span class="kpi-val" style="color:#059669;">${completionRate}%</span>
        <span class="kpi-sub">${passedCells}/${totalCells} lượt học phần đã Đạt</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-label">Điểm TB các bài đã thi</span>
        <span class="kpi-val">${avgScore}%</span>
        <span class="kpi-sub">Tổng cộng ${totalAttempts} lượt nộp bài</span>
      </div>
    `;

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

    pMatrix.classList.toggle("hidden", activeAdminTab !== "matrix");
    pDossier.classList.toggle("hidden", activeAdminTab !== "dossier");
    pAnalytics.classList.toggle("hidden", activeAdminTab !== "analytics");

    if (activeAdminTab === "matrix") {
      renderAdminMatrixPanel(sales, pubMods);
    } else if (activeAdminTab === "dossier") {
      renderAdminDossierPanel(sales, pubMods);
    } else {
      renderAdminAnalyticsPanel(sales, pubMods);
    }
  }

  function renderAdminMatrixPanel(sales, pubMods) {
    const table = document.getElementById("progressMatrixTable");
    let thead = `<thead><tr><th>Nhân viên Sale</th><th>PIN</th><th>Tiến độ cá nhân</th>`;
    pubMods.forEach(m => {
      thead += `<th>${escapeHtml(m.code)} — ${escapeHtml(m.title)}</th>`;
    });
    thead += `</tr></thead>`;

    let tbody = `<tbody>`;
    sales.forEach(s => {
      let sPassed = 0;
      pubMods.forEach(m => {
        const p = (db.progress || []).find(pr => pr.userId === s.id && pr.moduleId === m.id);
        if (p && p.passed) sPassed++;
      });
      const sPct = pubMods.length > 0 ? Math.round((sPassed * 100) / pubMods.length) : 0;

      tbody += `
        <tr>
          <td><strong>${escapeHtml(s.name)}</strong></td>
          <td><code>${escapeHtml(s.pin)}</code></td>
          <td>
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
          sub = `Chưa nộp bài thi`;
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
            ? `Nhân viên Sale <strong>${escapeHtml(sale.name)}</strong> đã mở xem tài liệu học phần này nhưng chưa nộp bài kiểm tra trắc nghiệm.`
            : `Nhân viên Sale <strong>${escapeHtml(sale.name)}</strong> chưa bắt đầu học phần này.`}
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
            ${!isRight && chosen !== undefined && q.options[chosen] ? `<div style="color:#9F1239;font-size:12px;">• Đáp án Sale đã chọn: ${escapeHtml(q.options[chosen])}</div>` : ""}
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

  function renderAdminDossierPanel(sales, pubMods) {
    const panel = document.getElementById("adminPanelDossier");
    if (!activeDossierSaleId || !sales.some(s => s.id === activeDossierSaleId)) {
      activeDossierSaleId = sales[0] ? sales[0].id : null;
    }
    const sale = sales.find(s => s.id === activeDossierSaleId);
    if (!sale) {
      panel.innerHTML = `<div class="admin-card">Chưa có nhân viên Sale nào trong danh sách.</div>`;
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
          <td><strong>${escapeHtml(m.code)}</strong> — ${escapeHtml(m.title)}</td>
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
          <button type="button" class="btn-primary" id="btnDossierActAsSale">Xem dưới quyền ${escapeHtml(sale.name)}</button>
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
        renderAdminDossierPanel(sales, pubMods);
      });
    });

    panel.querySelectorAll("[data-dossier-inspect]").forEach(btn => {
      btn.addEventListener("click", () => {
        openQuickInspectSaleModal(sale.id, btn.dataset.dossierInspect);
      });
    });

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
              ? `<span class="sidebar-item-status ${rate >= 70 ? 'done' : 'failed'}">${rightCount}/${totalAnswered} Sale đúng (${rate}%)</span>`
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
            <p class="admin-sub">Giúp Quản lý nắm được câu hỏi nào Sale trả lời tốt và kiến thức nào Sale hay nhầm lẫn để đào tạo bổ sung.</p>
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
                <th style="width:175px;text-align:center;">Tỷ lệ Sale làm đúng</th>
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
          const switchLabel = roleName === "sale" ? "Chuyển sang Đào tạo" : "Chuyển sang Sale";
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
            u.title = u.role === "uploader" ? "Phụ trách Nội dung & Đào tạo" : "Chuyên viên Tư vấn (Sale)";
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

    document.getElementById("settingAdminPin").value = (db.meta && db.meta.adminPin) ? db.meta.adminPin : "8888";
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
      ctx.fillText(u.role === "uploader" ? "Đào tạo" : "Sale", tableX + 330, curY + 27);

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
    if (!window.JSZip) return null;
    const fname = (file.name || "").toLowerCase();
    const zip = await window.JSZip.loadAsync(file);
    const parser = new DOMParser();

    if (fname.endsWith(".docx")) {
      const docXmlFile = zip.file("word/document.xml");
      if (!docXmlFile) return null;
      const xmlStr = await docXmlFile.async("string");
      const xmlDoc = parser.parseFromString(xmlStr, "application/xml");
      const lines = [];
      const tables = [];
      const body = xmlDoc.getElementsByTagName("w:body")[0] || xmlDoc.documentElement;
      Array.from(body.childNodes).forEach(node => {
        const local = node.nodeName.replace(/^.*:/, "");
        if (local === "p") {
          const tNodes = node.getElementsByTagName("w:t");
          let pText = "";
          for (let i = 0; i < tNodes.length; i++) pText += tNodes[i].textContent || "";
          if (pText.trim()) lines.push(pText.trim());
        } else if (local === "tbl") {
          const rows = [];
          const trNodes = node.getElementsByTagName("w:tr");
          for (let r = 0; r < trNodes.length; r++) {
            const cells = [];
            const tcNodes = trNodes[r].getElementsByTagName("w:tc");
            for (let c = 0; c < tcNodes.length; c++) {
              const tNodes = tcNodes[c].getElementsByTagName("w:t");
              let cText = "";
              for (let t = 0; t < tNodes.length; t++) cText += tNodes[t].textContent || "";
              cells.push(cText.replace(/\s+/g, " ").trim());
            }
            if (cells.some(Boolean)) {
              rows.push(cells);
              lines.push(cells.join(" | "));
            }
          }
          if (rows.length > 0) tables.push({ sheet: "Bảng trong Word", rows });
        }
      });
      return { text: lines.join("\n"), tables };
    }

    if (fname.endsWith(".xlsx")) {
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
        for (let r = 0; r < rowNodes.length; r++) {
          const cNodes = rowNodes[r].getElementsByTagName("c");
          const vals = [];
          for (let c = 0; c < cNodes.length; c++) {
            const cEl = cNodes[c];
            const cType = cEl.getAttribute("t") || "";
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
            vals.push(String(val).trim());
          }
          if (vals.some(Boolean)) {
            rows.push(vals);
            lines.push(vals.filter(Boolean).join(" | "));
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
        if (data && data.ok) {
          return { text: data.text || "", tables: data.tables || [] };
        }
      }
    } catch (e) {}

    // Client-side parser for .docx and .xlsx (works on static hosts like GitHub Pages & Vercel)
    try {
      if (fname.endsWith(".docx") || fname.endsWith(".xlsx")) {
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

  function setupUploaderAndAdminEvents() {
    // Sidebar create new module button
    const btnCreateMod = document.getElementById("btnSidebarCreateModule");
    if (btnCreateMod) {
      btnCreateMod.addEventListener("click", () => {
        const nextNum = (db.modules || []).length + 1;
        const code = `HP0${nextNum}`;
        const newMod = {
          id: `mod-${Date.now().toString(36)}`,
          code,
          category: "Chuyên đề Đào tạo mới",
          title: `Học phần mới ${code}: Tài liệu Đào tạo Sale`,
          subtitle: "Bối cảnh tư vấn Chủ trường và Hiệu trưởng trường mầm non",
          durationMinutes: 20,
          passThreshold: (db.meta && db.meta.defaultPassThreshold) || 80,
          status: "published",
          authorName: currentUser ? currentUser.name : "Người up nội dung",
          updatedAt: new Date().toISOString(),
          summaryPoints: [
            "Luận điểm trọng tâm 1 cần nhớ khi tư vấn Chủ trường / Hiệu trưởng.",
            "Luận điểm trọng tâm 2 về điểm khác biệt của chương trình Novastars."
          ],
          contentText: "",
          uploadedTables: [],
          questions: []
        };
        db.modules.push(newMod);
        currentModuleId = newMod.id;
        activeWorkspaceView = "uploader";
        activeUploaderTab = "doc";
        triggerAutoSave(true, true);
        renderAll();
      });
    }

    // Upload Document File (.docx, .xlsx, .pdf, .txt)
    const inpDocFile = document.getElementById("inputUploadDocFile");
    if (inpDocFile) {
      inpDocFile.addEventListener("change", async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const mod = getCurrentModule();
        if (!mod) return;

        const statusEl = document.getElementById("upDocFileStatus");
        statusEl.classList.remove("hidden");
        statusEl.textContent = `Đang đọc và trích xuất nội dung từ file "${file.name}"...`;

        const extracted = await extractFileContentViaBackendOrFallback(file);
        mod.sourceFile = {
          name: file.name,
          type: file.name.split(".").pop().toLowerCase()
        };
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

        statusEl.innerHTML = `✓ Đã bóc tách thành công tài liệu <strong>${escapeHtml(file.name)}</strong> (${(extracted.text || "").length.toLocaleString("vi-VN")} ký tự, ${(extracted.tables || []).length} bảng dữ liệu). Bạn có thể chuyển sang Bước 2 để tạo bộ câu hỏi trắc nghiệm ngay!`;
        triggerAutoSave(true, true);
        renderUploaderWorkspace();
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

        const count = Number(document.getElementById("selAiQuestionCount").value || 8);
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
        const mod = getCurrentModule();
        if (!mod) return;

        const extracted = await extractFileContentViaBackendOrFallback(file);
        const imported = parseImportedQuizTextOrTables(extracted.text, extracted.tables);
        inpQuizFile.value = "";

        if (imported.length === 0) {
          alert("Không tìm thấy câu hỏi trắc nghiệm hợp lệ trong file. Bạn có thể bấm '⬇️ Tải mẫu Excel' hoặc dùng nút '📋 Dán nhanh văn bản câu hỏi'.");
          return;
        }

        if (!Array.isArray(mod.questions)) mod.questions = [];
        mod.questions = mod.questions.concat(imported);
        triggerAutoSave(true, true);
        renderUploaderQuestionBank(mod);
        renderSidebar();
        alert(`Đã nhập thành công ${imported.length} câu hỏi trắc nghiệm từ file "${file.name}" vào danh sách Xem trước & Chỉnh sửa!`);
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
      expandedUploaderQuestionIndex = null;
      triggerAutoSave(true, true);
      renderSidebar();
      renderUploaderWorkspace();
      const btn = document.getElementById("btnUploaderSaveModule");
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = "✓ Đã lưu bài học!";
        setTimeout(() => { btn.textContent = orig; }, 1800);
      }
    }

    const btnSaveTop = document.getElementById("btnUploaderSaveModule");
    const btnSaveBot = document.getElementById("btnUploaderSaveBottom");
    if (btnSaveTop) btnSaveTop.addEventListener("click", saveCurrentModuleAndNotify);
    if (btnSaveBot) btnSaveBot.addEventListener("click", saveCurrentModuleAndNotify);

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
        title: "Chuyên viên Tư vấn (Sale)"
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
      const newPin = document.getElementById("settingAdminPin").value.trim() || "8888";
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
    let ths = `<th style="background:#C2410C;color:#fff;padding:10px;">STT</th><th style="background:#C2410C;color:#fff;padding:10px;">Họ và tên Sale</th><th style="background:#C2410C;color:#fff;padding:10px;">Mã PIN</th>`;
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
  renderAll();
  fetchServerDb();

  // Auto-refresh cloud state when tab becomes visible
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      fetchCloudDb(false);
    }
  });
})();
