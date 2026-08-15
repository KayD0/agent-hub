(() => {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const activityPanel = byId("activity-panel");
  const auditBody = document.querySelector("#audit-panel tbody");
  const activityNodes = new Map();
  const auditNodes = new Map();
  let images = [];
  let canInterrupt = false;
  let templates = [];
  if (!byId("prompt-template")) {
    const toolbar = document.createElement("div");
    toolbar.hidden = true;
    toolbar.innerHTML = '<select id="prompt-template"></select><button id="save-template" type="button"></button><button id="delete-template" type="button"></button>';
    byId("message-form").before(toolbar);
  }
  if (!byId("rename-template")) {
    const rename = document.createElement("button");
    rename.id = "rename-template"; rename.type = "button"; rename.className = "secondary"; rename.textContent = "名前変更"; rename.disabled = true;
    byId("save-template").after(rename);
  }

  function drawImages() {
    let container = byId("message-images");
    if (!container) { container = document.createElement("div"); container.id = "message-images"; container.setAttribute("aria-label", "添付画像"); byId("message-form").prepend(container); }
    container.replaceChildren(...images.map((image, index) => { const item = document.createElement("span"); item.className = "message-image"; const preview = document.createElement("canvas"); preview.width = 96; preview.height = 64; preview.setAttribute("aria-label", `添付画像${index + 1}のサムネイル`); createImageBitmap(image.file).then((bitmap) => { const scale = Math.min(preview.width / bitmap.width, preview.height / bitmap.height); const width = bitmap.width * scale; const height = bitmap.height * scale; preview.getContext("2d").drawImage(bitmap, (preview.width - width) / 2, (preview.height - height) / 2, width, height); bitmap.close(); }); const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `添付画像${index + 1}を削除`); remove.onclick = () => { images.splice(index, 1); drawImages(); }; item.append(preview, remove); return item; }));
    container.hidden = !images.length;
  }

  function imageData(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ mimeType: file.type, dataUrl: reader.result, file }); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }

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
    canInterrupt = session.canInterrupt;
    byId("interrupt").hidden = !session.canInterrupt;
    updateTemplates(session.promptTemplates || []);
    const attention = byId("attention");
    if (attention.dataset.html !== session.attentionHtml) { attention.dataset.html = session.attentionHtml; attention.innerHTML = session.attentionHtml; }
    reconcile(activityPanel, session.activities, activityNodes, "article");
    activityPanel.querySelector(".empty").hidden = session.activities.length > 0;
    reconcile(auditBody, session.audits, auditNodes, "tr");
    document.querySelector("#audit-panel .empty").hidden = session.audits.length > 0;
  }

  function updateTemplates(nextTemplates) {
    const select = byId("prompt-template");
    const selected = select.value;
    templates = nextTemplates;
    const groups = new Map();
    for (const template of templates) {
      if (!groups.has(template.category)) groups.set(template.category, []);
      groups.get(template.category).push(template);
    }
    const placeholder = document.createElement("option");
    placeholder.value = ""; placeholder.textContent = "テンプレートを選択...";
    const nodes = [placeholder];
    for (const [category, items] of groups) {
      const group = document.createElement("optgroup"); group.label = category;
      for (const template of items) { const option = document.createElement("option"); option.value = template.id; option.textContent = template.name; group.append(option); }
      nodes.push(group);
    }
    select.replaceChildren(...nodes);
    if (templates.some((template) => template.id === selected)) select.value = selected;
    updateDeleteButton();
  }

  function updateDeleteButton() {
    const selected = templates.find((template) => template.id === byId("prompt-template").value);
    byId("delete-template").disabled = !selected;
    byId("rename-template").disabled = !selected || selected.builtIn;
    byId("save-template").textContent = selected && !selected.builtIn ? "上書き保存" : "現在の本文を保存";
  }

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activateTab(name, focus = false) {
    for (const tab of tabs) { const selected = tab.dataset.tab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; byId(tab.getAttribute("aria-controls")).hidden = !selected; if (selected && focus) tab.focus(); }
    vscode.setState({ ...vscode.getState(), detailTab: name });
  }
  for (const tab of tabs) { tab.addEventListener("click", () => activateTab(tab.dataset.tab)); tab.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const current = tabs.indexOf(tab); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length; activateTab(tabs[next].dataset.tab, true); }); }
  const savedTab = vscode.getState()?.detailTab;
  activateTab(["activity", "audit"].includes(savedTab) ? savedTab : "activity");

  const form = byId("message-form"); const input = byId("message");
  byId("prompt-template").addEventListener("change", (event) => { const template = templates.find((item) => item.id === event.target.value); if (template) { input.value = template.text; input.focus(); input.setSelectionRange(input.value.length, input.value.length); } updateDeleteButton(); });
  byId("save-template").addEventListener("click", () => { if (!input.value.trim()) { window.alert("保存する本文を入力してください。"); return; } const selected = templates.find((template) => template.id === byId("prompt-template").value); const message = { type: "saveTemplate", text: input.value }; if (selected && !selected.builtIn) message.templateId = selected.id; vscode.postMessage(message); });
  byId("rename-template").addEventListener("click", () => { const templateId = byId("prompt-template").value; if (templateId) vscode.postMessage({ type: "renameTemplate", templateId }); });
  byId("delete-template").addEventListener("click", () => { const templateId = byId("prompt-template").value; if (templateId) vscode.postMessage({ type: "deleteTemplate", templateId }); });
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!input.value.trim() && !images.length) return; const message = { type: "send", text: input.value }; if (images.length) message.images = images.map(({ mimeType, dataUrl }) => ({ mimeType, dataUrl })); vscode.postMessage(message); input.value = ""; images = []; drawImages(); });
  input.addEventListener("paste", async (event) => { const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && ["image/png", "image/jpeg"].includes(item.type)).map((item) => item.getAsFile()).filter(Boolean); if (!files.length) return; event.preventDefault(); if (images.length + files.length > 4 || files.some((file) => file.size > 10 * 1024 * 1024)) { window.alert("画像はPNG/JPEG、1枚10MB以内、一度に4枚までです。"); return; } images.push(...await Promise.all(files.map(imageData))); drawImages(); });
  input.addEventListener("keydown", (event) => { if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return; event.preventDefault(); form.requestSubmit(); });
  byId("interrupt").addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || !canInterrupt) return;
    event.preventDefault();
    vscode.postMessage({ type: "interrupt" });
  });
  byId("attention").addEventListener("click", (event) => { const button = event.target.closest?.("[data-decision]"); if (button) vscode.postMessage({ type: "approval", decision: button.dataset.decision }); });
  window.addEventListener("message", (event) => { if (event.data?.type === "sessionDetail") update(event.data.session); else if (event.data?.type === "templateSelected") { byId("prompt-template").value = event.data.templateId; updateDeleteButton(); } });
  vscode.postMessage({ type: "ready" });
})();
