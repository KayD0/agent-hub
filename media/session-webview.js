(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const root = document.getElementById("sessions");
  const cards = new Map();
  const sessionsById = new Map();
  const openResults = new Set();
  const resultCloseTimers = new Map();
  const inputCloseTimers = new Map();
  const selectedRepositoryGroupIds = new Set();
  const labels = {
    ready: "待機中", starting: "開始中", running: "実行中",
    waiting_for_approval: "承認待ち", waiting_for_input: "入力待ち",
    completed: "完了", failed: "失敗", interrupted: "中断", disconnected: "切断",
  };
  let sessions = [];
  let authentication = { status: "checking" };
  let grid;
  let empty;
  let approvalBanner;
  let draggedSessionId;
  let composingSessionId;
  const maxImages = 4;
  const interruptibleStatuses = new Set(["starting", "running", "waiting_for_input"]);

  function pastedImages(event) {
    return supportedFiles([...(event.clipboardData?.items || [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean));
  }

  function attachmentType(file) { const name = (file.name || "").toLowerCase(); return file.type || (name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg" : ""); }
  function imageData(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ mimeType: attachmentType(file), dataUrl: reader.result.replace(/^data:[^;]*;/, `data:${attachmentType(file)};`), name: file.name }); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
  }

  function supportedFiles(files) { return [...files].filter((file) => ["image/png", "image/jpeg", "application/pdf"].includes(attachmentType(file))); }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, title, action, secondary) {
    const node = el("button", secondary ? "secondary" : "", label);
    node.type = "button";
    node.title = title;
    node.setAttribute("aria-label", title);
    node.addEventListener("click", action);
    return node;
  }

  function sessionFor(card) {
    return sessionsById.get(card.dataset.sessionId);
  }

  function interruptSession(sessionId) {
    const session = sessionsById.get(sessionId);
    if (session && interruptibleStatuses.has(session.status)) vscode.postMessage({ type: "interrupt", sessionId });
  }

  function ensureGrid() {
    if (empty) { empty.remove(); empty = undefined; }
    if (grid) return grid;
    grid = el("div", "sessions-grid");
    grid.addEventListener("dragover", (event) => {
      if (!draggedSessionId) return;
      const target = event.target.closest(".session");
      const dragged = cards.get(draggedSessionId);
      if (!target || !dragged || target === dragged) return;
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      target[event.clientY > rect.top + rect.height / 2 ? "after" : "before"](dragged);
    });
    grid.addEventListener("drop", (event) => {
      if (!draggedSessionId) return;
      event.preventDefault();
      publishOrder();
    });
    root.append(grid);
    return grid;
  }

  function showEmpty(message) {
    if (grid) { grid.remove(); grid = undefined; }
    for (const card of cards.values()) card.remove();
    cards.clear();
    if (!message) { empty?.remove(); empty = undefined; return; }
    if (!empty) { empty = el("p", "empty"); root.append(empty); }
    empty.textContent = message;
  }

  function updateApprovalBanner() {
    const approvals = sessions.filter((session) => session.pendingInteraction?.kind === "approval");
    const safe = approvals.filter((session) => session.pendingInteraction.matchedRule);
    if (!approvalBanner) {
      approvalBanner = el("section", "approval-banner");
      approvalBanner.setAttribute("aria-label", "承認待ちの操作");
      approvalBanner.setAttribute("aria-live", "polite");
      const summary = el("span", "approval-banner-summary");
      const actions = el("div", "approval-banner-actions");
      const review = button("内容を確認", "最初の承認待ちセッションへ移動", () => {
        const first = sessions.find((session) => session.pendingInteraction?.kind === "approval");
        const card = first ? cards.get(first.id) : undefined;
        card?.scrollIntoView({ block: "center", behavior: "smooth" });
        card?.focus({ preventScroll: true });
      }, true);
      const approve = button("安全に一括承認", "安全ポリシーに一致する操作を今回のみ一括承認", () => vscode.postMessage({ type: "bulkApprove" }));
      approve.classList.add("bulk-approve");
      actions.append(review, approve);
      approvalBanner.append(summary, actions);
      root.prepend(approvalBanner);
    }
    approvalBanner.hidden = authentication.status !== "authenticated" || !approvals.length;
    approvalBanner.querySelector(".approval-banner-summary").textContent = `承認待ち ${approvals.length}件・一括承認対象 ${safe.length}件`;
    const approve = approvalBanner.querySelector(".bulk-approve");
    approve.hidden = !safe.length;
    approve.disabled = !safe.length;
    approve.textContent = `安全に一括承認 (${safe.length})`;
  }

  function publishOrder() {
    if (!grid) return;
    const visibleIds = [...grid.querySelectorAll(".session")].map((card) => card.dataset.sessionId);
    const visibleSet = new Set(visibleIds);
    let index = 0;
    const sessionIds = sessions.map((session) => visibleSet.has(session.id) ? visibleIds[index++] : session.id);
    vscode.postMessage({ type: "reorder", sessionIds });
  }

  function createCard(session) {
    const card = el("article", "session");
    card.dataset.sessionId = session.id;
    card.tabIndex = 0;
    card.addEventListener("dblclick", (event) => {
      if (event.target.closest("button,input,textarea,select,a,label,form,fieldset,[role=button],[contenteditable=true]")) return;
      vscode.postMessage({ type: "open", sessionId: card.dataset.sessionId });
    });
    card.addEventListener("keydown", (event) => {
      if (event.target !== card || event.key !== "Enter") return;
      event.preventDefault();
      vscode.postMessage({ type: "open", sessionId: card.dataset.sessionId });
    });

    const head = el("div", "session-head");
    const handle = el("span", "drag-handle", "⠿");
    handle.draggable = true;
    handle.tabIndex = 0;
    handle.title = "ドラッグまたは矢印キーで並べ替え";
    handle.setAttribute("role", "button");
    handle.addEventListener("dragstart", (event) => {
      draggedSessionId = card.dataset.sessionId;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedSessionId);
    });
    handle.addEventListener("dragend", () => {
      draggedSessionId = undefined;
      card.classList.remove("dragging");
    });
    handle.addEventListener("keydown", (event) => {
      const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
      const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
      if (!backward && !forward) return;
      event.preventDefault();
      const sibling = backward ? card.previousElementSibling : card.nextElementSibling;
      if (!sibling) return;
      if (backward) sibling.before(card); else sibling.after(card);
      publishOrder();
      handle.focus();
    });
    const main = el("div", "session-main");
    main.append(el("div", "title"));
    head.append(handle, main, el("span", "status"), el("div", "header-actions"));
    card.append(head);

    const origin = el("div", "session-origin");
    origin.hidden = true;
    card.append(origin);

    const relatedIssues = el("div", "last-instruction related-issues");
    relatedIssues.hidden = true;
    card.append(relatedIssues);
    const instruction = el("div", "last-instruction");
    instruction.hidden = true;
    card.append(instruction);

    const quickActions = el("div", "card-quick-actions");
    const inputPopover = createInputPopover(card);
    const analysisResult = button("分析結果", "課題分析結果を候補一覧で表示", () => vscode.postMessage({ type: "openAnalysisResult", sessionId: card.dataset.sessionId }), true);
    analysisResult.className = "analysis-result-toggle";
    analysisResult.hidden = true;
    quickActions.append(analysisResult, inputPopover);
    card.append(quickActions, el("div", "pending-slot"));
    return card;
  }

  function createInputPopover(card) {
    const popover = el("div", "card-input-popover");
    const toggle = el("button", "card-input-toggle", "追加入力");
    toggle.type = "button";
    toggle.setAttribute("aria-haspopup", "dialog");
    const form = el("form", "card-input-form");
    form.setAttribute("role", "dialog");
    const input = el("textarea");
    let images = [];
    input.rows = 2;
    input.placeholder = "このセッションへ指示...";
    input.title = "Enterで送信、Ctrl+Enter（MacはCommand+Enter）で改行";
    const send = el("button", "", "送信");
    send.type = "submit";
    send.title = "指示を送信";
    send.setAttribute("aria-label", "指示を送信");
    const attachments = el("span", "card-attachments", "📎 0");
    attachments.hidden = true;
    attachments.title = "貼り付けた画像をすべて削除";
    attachments.tabIndex = 0;
    const clearImages = () => { images = []; attachments.hidden = true; attachments.textContent = "📎 0"; };
    const addFiles = async (files) => {
      const supported = supportedFiles(files);
      if (!supported.length) return false;
      if (images.length + supported.length > maxImages || supported.some((file) => file.size > 10 * 1024 * 1024)) { window.alert("PNG/JPEG/PDFを合計4件まで、1件10MB以内で添付できます。"); return true; }
      images.push(...await Promise.all(supported.map(imageData)));
      attachments.hidden = false;
      attachments.textContent = "📎 " + images.length;
      attachments.setAttribute("aria-label", `添付ファイル${images.length}件。押すとすべて削除`);
      return true;
    };
    attachments.addEventListener("click", clearImages);
    attachments.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") clearImages(); });
    form.append(input, attachments, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text && !images.length) return;
      const message = { type: "send", sessionId: card.dataset.sessionId, text };
      if (images.length) message.images = images;
      vscode.postMessage(message);
      input.value = "";
      clearImages();
    });
    input.addEventListener("paste", async (event) => {
      const files = pastedImages(event);
      if (!files.length) return;
      event.preventDefault();
      await addFiles(files);
    });
    form.addEventListener("dragover", (event) => { if (!supportedFiles(event.dataTransfer?.files || []).length) return; event.preventDefault(); form.classList.add("attachment-dragover"); });
    form.addEventListener("dragleave", () => form.classList.remove("attachment-dragover"));
    form.addEventListener("drop", async (event) => { form.classList.remove("attachment-dragover"); if (await addFiles(event.dataTransfer?.files || [])) event.preventDefault(); });
    input.addEventListener("compositionstart", () => { composingSessionId = card.dataset.sessionId; });
    input.addEventListener("compositionend", () => { composingSessionId = undefined; });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || composingSessionId === card.dataset.sessionId) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end");
        return;
      }
      form.requestSubmit();
    });
    popover.addEventListener("mouseenter", () => openCardInput(card.dataset.sessionId, popover));
    popover.addEventListener("mouseleave", () => closeCardInputLater(card.dataset.sessionId, popover));
    popover.addEventListener("focusin", () => openCardInput(card.dataset.sessionId, popover));
    popover.addEventListener("focusout", () => closeCardInputLater(card.dataset.sessionId, popover));
    popover.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse" || document.activeElement === input || composingSessionId) return;
      input.focus({ preventScroll: true });
      if (input.selectionStart === 0 && input.selectionEnd === 0) input.setSelectionRange(input.value.length, input.value.length);
    });
    popover.append(toggle, form);
    return popover;
  }

  function updateCard(card, session) {
    card.dataset.status = session.status;
    card.title = "ダブルクリックまたはEnterで詳細を開く";
    card.setAttribute("aria-label", session.title + "。" + (labels[session.status] || session.status) + "。Enterで詳細を開く");
    const handle = card.querySelector(".drag-handle");
    handle.setAttribute("aria-label", session.title + "を並べ替え");
    card.querySelector(".title").textContent = session.title;
    card.querySelector(".status").textContent = labels[session.status] || session.status;
    const inputToggle = card.querySelector(".card-input-toggle");
    const inputForm = card.querySelector(".card-input-form");
    const textarea = inputForm.querySelector("textarea");
    inputToggle.setAttribute("aria-label", session.title + "へ追加入力");
    inputForm.setAttribute("aria-label", session.title + "への追加入力");
    textarea.dataset.session = session.id;
    textarea.setAttribute("aria-label", session.title + "への指示");
    updateHeaderActions(card, session);
    updateOrigin(card, session);
    updateAnalysisResult(card, session);
    updateRelatedIssues(card, session);
    updateInstruction(card, session);
    updateResult(card, session);
    updatePending(card, session);
  }

  function updateOrigin(card, session) {
    const node = card.querySelector(".session-origin");
    const origin = session.origin?.kind === "folder_analysis" ? session.origin : undefined;
    node.hidden = !origin;
    node.textContent = origin ? "課題分析 · " + origin.repositoryName : "";
    node.title = origin?.rootPath || "";
    if (origin) node.setAttribute("aria-label", "課題分析の対象フォルダ: " + origin.repositoryName + "、" + origin.rootPath);
    else node.removeAttribute("aria-label");
  }

  function updateAnalysisResult(card, session) {
    const button = card.querySelector(".analysis-result-toggle");
    const available = session.origin?.kind === "folder_analysis";
    button.hidden = !available;
    button.disabled = !available;
    if (available) button.setAttribute("aria-label", session.origin.repositoryName + "の課題分析結果を表示");
  }

  function updateHeaderActions(card, session) {
    const container = card.querySelector(".header-actions");
    if (container.dataset.signature !== session.status) {
      container.dataset.signature = session.status;
      container.replaceChildren();
      const auto = el("label", "auto-control");
      auto.title = "安全ポリシーに一致する要求だけを自動承認（再起動時にOFF）";
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => vscode.postMessage({ type: "autoApprove", sessionId: card.dataset.sessionId, enabled: checkbox.checked }));
      auto.append(checkbox, document.createTextNode("Auto"));
      const unrestrictedAuto = el("label", "auto-control unrestricted-auto-control");
      unrestrictedAuto.title = "安全ポリシーを適用せず、すべての承認要求を自動承認（再起動時にOFF）";
      const unrestrictedCheckbox = el("input");
      unrestrictedCheckbox.type = "checkbox";
      unrestrictedCheckbox.addEventListener("change", () => vscode.postMessage({ type: "unrestrictedAutoApprove", sessionId: card.dataset.sessionId, enabled: unrestrictedCheckbox.checked }));
      unrestrictedAuto.append(unrestrictedCheckbox, document.createTextNode("無制限Auto"));
      if (["starting", "running", "waiting_for_input"].includes(session.status)) {
        const interrupt = button("中断", "処理を中断 (Esc)", () => interruptSession(card.dataset.sessionId), true);
        interrupt.classList.add("header-action");
        container.append(interrupt);
      }
      container.append(auto, unrestrictedAuto);
      if (["ready", "completed", "failed", "interrupted", "disconnected"].includes(session.status)) {
        const remove = button("×", "一覧から削除", () => vscode.postMessage({ type: "remove", sessionId: card.dataset.sessionId }));
        remove.className = "icon-button";
        container.append(remove);
      }
    }
    const checkbox = container.querySelector(".auto-control input");
    checkbox.checked = session.autoApprove;
    checkbox.setAttribute("aria-label", session.title + "の安全なAuto承認");
    const unrestrictedCheckbox = container.querySelector(".unrestricted-auto-control input");
    unrestrictedCheckbox.checked = session.unrestrictedAutoApprove;
    unrestrictedCheckbox.setAttribute("aria-label", session.title + "の無制限Auto承認");
    card.dataset.unrestrictedAuto = session.unrestrictedAutoApprove ? "true" : "false";
  }

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || composingSessionId) return;
    const focusedCard = event.target.closest?.(".session");
    const candidates = focusedCard
      ? [sessionFor(focusedCard)].filter(Boolean)
      : sessions.filter((session) => interruptibleStatuses.has(session.status));
    if (candidates.length !== 1 || !interruptibleStatuses.has(candidates[0].status)) return;
    event.preventDefault();
    interruptSession(candidates[0].id);
  });

  function updateInstruction(card, session) {
    const node = card.querySelector(".last-instruction");
    node.hidden = !session.lastInstruction;
    node.textContent = session.lastInstruction || "";
    node.title = session.lastInstruction || "";
    if (session.lastInstruction) node.setAttribute("aria-label", "最後の指示: " + session.lastInstruction);
    else node.removeAttribute("aria-label");
  }

  function updateRelatedIssues(card, session) {
    const node = card.querySelector(".related-issues");
    const issues = session.relatedIssues || [];
    const text = issues.map((issue) => issue.repository + "#" + issue.number + (issue.branch ? " · " + issue.branch : "")).join(", ");
    node.hidden = !issues.length;
    node.textContent = issues.length ? "関連Issue: " + text : "";
    node.title = issues.map((issue) => [issue.title, issue.branch, issue.worktree, issue.url].filter(Boolean).join(" · ")).join("\n");
    if (issues.length) node.setAttribute("aria-label", "関連Issue: " + text);
    else node.removeAttribute("aria-label");
  }

  function updateResult(card, session) {
    const quickActions = card.querySelector(".card-quick-actions");
    let popover = quickActions.querySelector(".result-popover");
    if (!session.finalResult) { popover?.remove(); openResults.delete(session.id); return; }
    if (!popover) {
      const resultId = "result-" + session.id.replace(/[^a-zA-Z0-9_-]/g, "-");
      popover = el("div", "result-popover");
      popover.dataset.resultSession = session.id;
      const toggle = el("button", "result-toggle", "最終結果");
      toggle.type = "button";
      toggle.setAttribute("aria-label", "最終結果の詳細を開く");
      toggle.setAttribute("aria-describedby", resultId);
      toggle.addEventListener("click", () => vscode.postMessage({ type: "open", sessionId: session.id }));
      const result = el("div", "result");
      result.id = resultId;
      result.setAttribute("role", "tooltip");
      result.append(el("span", "result-label", "最終結果"), document.createTextNode(""));
      popover.addEventListener("mouseenter", () => openResult(session.id, popover));
      popover.addEventListener("mouseleave", () => closeResultLater(session.id));
      popover.append(toggle, result);
      quickActions.insertBefore(popover, quickActions.querySelector(".card-input-popover"));
    }
    popover.classList.toggle("is-open", openResults.has(session.id));
    const result = popover.querySelector(".result");
    result.lastChild.nodeValue = session.finalResult;
  }

  function updatePending(card, session) {
    const slot = card.querySelector(".pending-slot");
    const signature = JSON.stringify(session.pendingInteraction || null);
    if (slot.dataset.signature === signature) return;
    slot.dataset.signature = signature;
    slot.replaceChildren();
    const pending = session.pendingInteraction;
    if (pending?.kind === "approval") {
      const actions = el("div", "actions");
      actions.append(button("今回のみ許可", "今回のみ許可", () => postApproval(card, "accept")));
      if (pending.allowForSession) actions.append(button("セッションで許可", "このセッションで許可", () => postApproval(card, "acceptForSession")));
      actions.append(button("拒否", "拒否", () => postApproval(card, "decline"), true));
      slot.append(actions);
    } else if (pending?.kind === "input") slot.append(renderInputRequest(card, pending));
  }

  function postApproval(card, decision) {
    vscode.postMessage({ type: "approval", sessionId: card.dataset.sessionId, decision });
  }

  function renderInputRequest(card, pending) {
    const form = el("form", "input-request");
    for (const question of pending.questions) {
      const field = el("fieldset", "input-question");
      field.dataset.questionId = question.id;
      field.append(el("legend", "", question.header || question.question));
      if (question.header && question.question) field.append(el("div", "auth-detail", question.question));
      const inputType = question.isMultiSelect ? "checkbox" : "radio";
      for (const option of question.options || []) {
        const label = el("label", "input-option");
        const input = el("input");
        input.type = inputType;
        input.name = "question-" + question.id;
        input.value = option.label;
        input.required = !question.isMultiSelect;
        label.append(input, document.createTextNode(option.label));
        if (option.description) label.append(el("span", "", option.description));
        field.append(label);
      }
      if (question.isOther || !(question.options || []).length) {
        const other = el("input", "input-other");
        other.type = question.isSecret ? "password" : "text";
        other.placeholder = question.isOther ? "その他の回答" : "回答を入力";
        other.setAttribute("aria-label", question.question);
        other.dataset.other = "true";
        if (!(question.options || []).length) other.required = true;
        field.append(other);
      }
      form.append(field);
    }
    form.append(button("回答を送信", "すべての回答を送信", () => form.requestSubmit()));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const answers = {};
      for (const field of form.querySelectorAll(".input-question")) {
        const selected = [...field.querySelectorAll("input:checked")].map((input) => input.value);
        const other = field.querySelector("[data-other]")?.value.trim();
        if (other) selected.push(other);
        if (!selected.length) { field.querySelector("input")?.focus(); return; }
        answers[field.dataset.questionId] = selected;
      }
      vscode.postMessage({ type: "answer", sessionId: card.dataset.sessionId, answers });
    });
    return form;
  }

  function renderSessions() {
    sessionsById.clear();
    for (const session of sessions) sessionsById.set(session.id, session);
    updateApprovalBanner();
    if (authentication.status !== "authenticated") { showEmpty(""); return; }
    const visible = selectedRepositoryGroupIds.size
      ? sessions.filter((session) => session.status === "waiting_for_approval" || session.repositoryGroupIds?.some((id) => selectedRepositoryGroupIds.has(id)))
      : sessions;
    if (!visible.length) {
      showEmpty(sessions.length ? "選択したフォルダのセッションはありません。" : "セッションはまだありません。");
      return;
    }
    const currentGrid = ensureGrid();
    const visibleIds = new Set(visible.map((session) => session.id));
    for (const [id, card] of cards) {
      if (!visibleIds.has(id)) { card.remove(); cards.delete(id); }
    }
    let previousCard;
    for (const session of visible) {
      let card = cards.get(session.id);
      if (!card) { card = createCard(session); cards.set(session.id, card); }
      updateCard(card, session);
      const expected = previousCard ? previousCard.nextElementSibling : currentGrid.firstElementChild;
      if (expected !== card) currentGrid.insertBefore(card, expected);
      previousCard = card;
    }
  }

  function clearPopoverTimers() {
    for (const timer of resultCloseTimers.values()) clearTimeout(timer);
    for (const timer of inputCloseTimers.values()) clearTimeout(timer);
    resultCloseTimers.clear();
    inputCloseTimers.clear();
  }

  function openResult(sessionId, popover) {
    root.querySelector(".card-input-popover:focus-within textarea")?.blur();
    clearPopoverTimers();
    openResults.clear();
    root.querySelectorAll(".result-popover.is-open,.card-input-popover.is-open").forEach((node) => node.classList.remove("is-open"));
    openResults.add(sessionId);
    popover.classList.add("is-open");
  }

  function closeResultLater(sessionId) {
    clearTimeout(resultCloseTimers.get(sessionId));
    resultCloseTimers.set(sessionId, setTimeout(() => {
      resultCloseTimers.delete(sessionId);
      openResults.delete(sessionId);
      cards.get(sessionId)?.querySelector(".result-popover")?.classList.remove("is-open");
    }, 250));
  }

  function openCardInput(sessionId, popover) {
    clearPopoverTimers();
    openResults.clear();
    root.querySelectorAll(".result-popover.is-open,.card-input-popover.is-open").forEach((node) => node.classList.remove("is-open"));
    popover.classList.add("is-open");
  }

  function closeCardInputLater(sessionId, popover) {
    clearTimeout(inputCloseTimers.get(sessionId));
    inputCloseTimers.set(sessionId, setTimeout(() => {
      inputCloseTimers.delete(sessionId);
      if (!popover.matches(":hover") && !popover.matches(":focus-within")) popover.classList.remove("is-open");
    }, 250));
  }

  root.addEventListener("focusin", (event) => {
    const popover = event.target.closest?.(".result-popover");
    const sessionId = popover?.dataset.resultSession;
    if (sessionId) openResult(sessionId, popover);
  });
  root.addEventListener("focusout", (event) => {
    const popover = event.target.closest?.(".result-popover");
    const sessionId = popover?.dataset.resultSession;
    if (sessionId) closeResultLater(sessionId);
  });
  window.addEventListener("message", (event) => {
    if (event.data?.type !== "sessions") return;
    sessions = event.data.sessions;
    selectedRepositoryGroupIds.clear();
    for (const id of event.data.repositoryGroupFilterIds || []) selectedRepositoryGroupIds.add(id);
    authentication = event.data.authentication || { status: "checking" };
    renderSessions();
  });
  vscode.postMessage({ type: "ready" });
})();
