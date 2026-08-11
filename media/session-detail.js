(() => {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const activityPanel = byId("activity-panel");
  const tablist = document.querySelector('[role="tablist"]');
  const mergeTab = document.createElement("button");
  mergeTab.className = "tab"; mergeTab.id = "merge-tab"; mergeTab.type = "button"; mergeTab.setAttribute("role", "tab"); mergeTab.setAttribute("aria-selected", "false"); mergeTab.setAttribute("aria-controls", "merge-panel"); mergeTab.dataset.tab = "merge"; mergeTab.tabIndex = -1; mergeTab.textContent = "マージキュー";
  tablist.append(mergeTab);
  const worktreeTab = document.createElement("button");
  worktreeTab.className = "tab"; worktreeTab.id = "worktree-tab"; worktreeTab.type = "button"; worktreeTab.setAttribute("role", "tab"); worktreeTab.setAttribute("aria-selected", "false"); worktreeTab.setAttribute("aria-controls", "worktree-panel"); worktreeTab.dataset.tab = "worktree"; worktreeTab.tabIndex = -1; worktreeTab.textContent = "ワークツリー";
  tablist.append(worktreeTab);
  const mergePanel = document.createElement("section");
  mergePanel.className = "tabpanel"; mergePanel.id = "merge-panel"; mergePanel.setAttribute("role", "tabpanel"); mergePanel.hidden = true;
  const mergeStyle = document.createElement("style");
  mergeStyle.nonce = document.querySelector("style[nonce]")?.nonce || "";
  mergeStyle.textContent = ".merge-row{min-width:0;padding:5px 4px}.merge-summary,.merge-summary label{display:flex;min-width:0;align-items:center;gap:5px}.merge-summary{width:100%;flex-wrap:nowrap}.merge-summary label{flex:1;overflow:hidden}.merge-summary input{flex:none;margin:0}.merge-summary strong{flex:none;white-space:nowrap}.merge-separator{flex:none;color:var(--vscode-descriptionForeground)}.merge-path{min-width:0;overflow:hidden;color:var(--vscode-descriptionForeground);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.merge-actions{flex:none;flex-wrap:nowrap;justify-content:flex-end;gap:3px;margin:0 0 0 auto;padding:0}.merge-panel-actions{gap:3px;margin-top:5px}.merge-panel-actions button,.merge-actions button{padding:1px;font:inherit;font-size:11px;line-height:1.25;white-space:nowrap}.merge-actions button{flex:none;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}";
  document.head.append(mergeStyle);
  mergePanel.innerHTML = '<div class="actions merge-panel-actions"><button type="button" id="refresh-merge">更新</button><button type="button" id="run-commit" disabled>選択分をコミット</button><button type="button" id="run-merge" disabled>選択分をマージ</button></div><div id="merge-candidates"><p class="empty">マージ前のworktreeはありません。</p></div>';
  document.querySelector("#audit-panel").after(mergePanel);
  const worktreePanel = document.createElement("section");
  worktreePanel.className = "tabpanel"; worktreePanel.id = "worktree-panel"; worktreePanel.setAttribute("role", "tabpanel"); worktreePanel.hidden = true;
  worktreePanel.innerHTML = '<div class="actions merge-panel-actions"><button type="button" id="refresh-worktrees">更新</button><button type="button" id="remove-worktrees" disabled>選択分を削除</button></div><div id="merged-worktrees"><p class="empty">マージ済みworktreeはありません。</p></div>';
  mergePanel.after(worktreePanel);
  const auditBody = document.querySelector("#audit-panel tbody");
  const activityNodes = new Map();
  const auditNodes = new Map();
  let mergeRunning = false;

  function reconcile(container, items, nodes, tag) {
    const active = new Set(items.map((item) => item.key));
    for (const [key, node] of nodes) if (!active.has(key)) { node.remove(); nodes.delete(key); }
    let previous;
    for (const item of items) {
      let node = nodes.get(item.key);
      if (!node) { node = document.createElement(tag); node.dataset.key = item.key; node.innerHTML = item.html; nodes.set(item.key, node); }
      const expected = previous ? previous.nextElementSibling : container.firstElementChild;
      if (expected !== node) container.insertBefore(node, expected);
      previous = node;
    }
  }

  function update(session) {
    byId("title").textContent = session.title;
    byId("status").textContent = session.status;
    byId("current-activity").textContent = session.currentActivity;
    byId("cwd").textContent = session.cwd;
    byId("interrupt").hidden = !session.canInterrupt;
    const attention = byId("attention");
    if (attention.dataset.html !== session.attentionHtml) { attention.dataset.html = session.attentionHtml; attention.innerHTML = session.attentionHtml; }
    reconcile(activityPanel, session.activities, activityNodes, "article");
    activityPanel.querySelector(".empty").hidden = session.activities.length > 0;
    reconcile(auditBody, session.audits, auditNodes, "tr");
    document.querySelector("#audit-panel .empty").hidden = session.audits.length > 0;
  }

  function updateMergeQueue(candidates) {
    const mergeContainer = byId("merge-candidates");
    const worktreeContainer = byId("merged-worktrees");
    mergeContainer.replaceChildren(); worktreeContainer.replaceChildren();
    let mergeCount = 0; let worktreeCount = 0;
    for (const candidate of candidates) {
      const container = candidate.mergeStatus === "merged" ? worktreeContainer : mergeContainer;
      if (candidate.mergeStatus === "merged") worktreeCount += 1; else mergeCount += 1;
      const row = document.createElement("article");
      row.className = "merge-row";
      const summary = document.createElement("div"); summary.className = "merge-summary";
      const label = document.createElement("label");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox";
      const mergeable = !candidate.dirty && candidate.conflict !== true && candidate.mergeStatus === "unmerged" && candidate.baseBranch === "develop";
      const removable = !candidate.dirty && !candidate.inUse && candidate.mergeStatus === "merged" && candidate.baseBranch === "develop";
      if (candidate.dirty) checkbox.dataset.commitCandidate = candidate.id;
      else if (mergeable) checkbox.dataset.mergeCandidate = candidate.id;
      else if (removable) checkbox.dataset.cleanupCandidate = candidate.id;
      checkbox.disabled = !candidate.dirty && !mergeable && !removable; checkbox.addEventListener("change", updateMergeAction);
      const title = document.createElement("strong"); title.textContent = candidate.branch + " → " + candidate.baseBranch;
      const separator = document.createElement("span"); separator.textContent = "/"; separator.className = "merge-separator";
      const stateText = candidate.dirty ? "未コミット差分あり" : candidate.conflict === true ? "競合あり" : candidate.inUse ? "セッションで使用中" : candidate.mergeStatus === "merged" ? "マージ済み" : candidate.mergeStatus === "unmerged" ? "未マージ" : "判定不能";
      const detail = document.createElement("span"); detail.className = "merge-path"; detail.textContent = compactWorktreePath(candidate.rootPath); detail.title = candidate.rootPath + "（" + stateText + "）";
      const actions = document.createElement("div"); actions.className = "actions merge-actions";
      const changes = document.createElement("button"); changes.type = "button"; changes.textContent = "差分"; changes.dataset.openChanges = candidate.id;
      actions.append(changes);
      if (candidate.dirty) { const commit = document.createElement("button"); commit.type = "button"; commit.textContent = "コミット依頼"; commit.dataset.commitWorktree = candidate.id; actions.append(commit); }
      if (candidate.conflict === true) { const resolve = document.createElement("button"); resolve.type = "button"; resolve.textContent = "競合解決を依頼"; resolve.dataset.resolveConflict = candidate.id; actions.append(resolve); }
      label.append(checkbox, title, separator, detail); summary.append(label, actions); row.append(summary); container.append(row);
    }
    if (!mergeCount) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "マージ前のworktreeはありません。"; mergeContainer.append(empty); }
    if (!worktreeCount) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "マージ済みworktreeはありません。"; worktreeContainer.append(empty); }
    updateMergeAction();
  }

  function updateMergeAction() { byId("run-commit").disabled = mergeRunning || !document.querySelector("[data-commit-candidate]:checked"); byId("run-merge").disabled = mergeRunning || !document.querySelector("[data-merge-candidate]:checked"); byId("remove-worktrees").disabled = mergeRunning || !document.querySelector("[data-cleanup-candidate]:checked"); }

  function compactWorktreePath(value) {
    const separator = value.includes("\\") ? "\\" : "/";
    const parts = value.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 3) return value;
    const root = /^[A-Za-z]:$/.test(parts[0]) ? parts.shift() : value.startsWith("/") ? "" : parts.shift();
    return (root ? root + separator : separator) + "…" + separator + parts.slice(-2).join(separator);
  }

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activateTab(name, focus = false) {
    for (const tab of tabs) { const selected = tab.dataset.tab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; byId(tab.getAttribute("aria-controls")).hidden = !selected; if (selected && focus) tab.focus(); }
    vscode.setState({ ...vscode.getState(), detailTab: name });
  }
  for (const tab of tabs) { tab.addEventListener("click", () => activateTab(tab.dataset.tab)); tab.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const current = tabs.indexOf(tab); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length; activateTab(tabs[next].dataset.tab, true); }); }
  const savedTab = vscode.getState()?.detailTab;
  activateTab(["activity", "audit", "merge", "worktree"].includes(savedTab) ? savedTab : "activity");

  const form = byId("message-form"); const input = byId("message");
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!input.value.trim()) return; vscode.postMessage({ type: "send", text: input.value }); input.value = ""; });
  input.addEventListener("keydown", (event) => { if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return; event.preventDefault(); form.requestSubmit(); });
  byId("interrupt").addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
  byId("refresh-merge").addEventListener("click", () => vscode.postMessage({ type: "refreshMergeQueue" }));
  byId("refresh-worktrees").addEventListener("click", () => vscode.postMessage({ type: "refreshMergeQueue" }));
  byId("run-merge").addEventListener("click", () => {
    if (mergeRunning) return;
    const candidateIds = [...document.querySelectorAll("[data-merge-candidate]:checked")].map((checkbox) => checkbox.dataset.mergeCandidate);
    if (candidateIds.length) { mergeRunning = true; updateMergeAction(); vscode.postMessage({ type: "mergeQueue", candidateIds }); }
  });
  byId("run-commit").addEventListener("click", () => {
    if (mergeRunning) return;
    const candidateIds = [...document.querySelectorAll("[data-commit-candidate]:checked")].map((checkbox) => checkbox.dataset.commitCandidate);
    if (candidateIds.length) { mergeRunning = true; updateMergeAction(); vscode.postMessage({ type: "commitWorktrees", candidateIds }); }
  });
  byId("remove-worktrees").addEventListener("click", () => {
    if (mergeRunning) return;
    const candidateIds = [...document.querySelectorAll("[data-cleanup-candidate]:checked")].map((checkbox) => checkbox.dataset.cleanupCandidate);
    if (candidateIds.length) { mergeRunning = true; updateMergeAction(); vscode.postMessage({ type: "removeWorktrees", candidateIds }); }
  });
  const handleWorktreeAction = (event) => {
    const changes = event.target.closest?.("[data-open-changes]");
    if (changes) vscode.postMessage({ type: "openWorktreeChanges", candidateId: changes.dataset.openChanges });
    const commit = event.target.closest?.("[data-commit-worktree]");
    if (commit && !mergeRunning) { mergeRunning = true; updateMergeAction(); vscode.postMessage({ type: "commitWorktree", candidateId: commit.dataset.commitWorktree }); }
    const conflict = event.target.closest?.("[data-resolve-conflict]");
    if (conflict && !mergeRunning) { mergeRunning = true; updateMergeAction(); vscode.postMessage({ type: "resolveConflict", candidateId: conflict.dataset.resolveConflict }); }
  };
  byId("merge-candidates").addEventListener("click", handleWorktreeAction);
  byId("merged-worktrees").addEventListener("click", handleWorktreeAction);
  byId("attention").addEventListener("click", (event) => { const button = event.target.closest?.("[data-decision]"); if (button) vscode.postMessage({ type: "approval", decision: button.dataset.decision }); });
  window.addEventListener("message", (event) => { if (event.data?.type === "sessionDetail") update(event.data.session); else if (event.data?.type === "mergeQueue") updateMergeQueue(event.data.candidates || []); else if (event.data?.type === "mergeQueueComplete") { mergeRunning = false; updateMergeAction(); } });
  vscode.postMessage({ type: "ready" });
})();
