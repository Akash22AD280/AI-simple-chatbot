const appState = {
  chats: [],
  activeChatId: null,
  settings: {
    provider: "gemini",
    model: "gemini-3.5-flash",
    apiKeys: {
      openai: "",
      gemini: "",
      xai: "",
    },
    theme: "dark",
    language: "Auto",
    systemPrompt: "You are a helpful, friendly, concise AI assistant.",
    temperature: 0.7,
    maxTokens: 1200,
    compareMode: false,
    compareProviderB: "openai",
    compareModelB: "gpt-4o-mini",
  },
  files: [],
  abortController: null,
  isStreaming: false,
  providerModels: {}
};

const el = {};

function $(id) { return document.getElementById(id); }

function loadSettings() {
  const saved = localStorage.getItem("ai_chatbot_settings");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      appState.settings = { ...appState.settings, ...parsed, apiKeys: { ...appState.settings.apiKeys, ...(parsed.apiKeys || {}) } };
    } catch (_) {}
  }

  const savedChats = localStorage.getItem("ai_chatbot_chats");
  if (savedChats) {
    try { appState.chats = JSON.parse(savedChats) || []; } catch (_) {}
  }
  appState.activeChatId = localStorage.getItem("ai_chatbot_active_chat_id") || appState.chats[0]?.id || null;
}

function saveState() {
  localStorage.setItem("ai_chatbot_settings", JSON.stringify(appState.settings));
  localStorage.setItem("ai_chatbot_chats", JSON.stringify(appState.chats));
  localStorage.setItem("ai_chatbot_active_chat_id", appState.activeChatId || "");
}

function newId() {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveChat() {
  return appState.chats.find(c => c.id === appState.activeChatId) || null;
}

function ensureChat() {
  let chat = getActiveChat();
  if (!chat) {
    chat = {
      id: newId(),
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: appState.settings.provider,
      model: appState.settings.model,
      messages: []
    };
    appState.chats.unshift(chat);
    appState.activeChatId = chat.id;
    saveState();
  }
  return chat;
}

function providerLabel(value) {
  return {
    openai: "OpenAI",
    gemini: "Gemini",
    xai: "xAI",
  }[value] || value;
}

function effectiveModel() {
  if (el.model.value === "__custom__") return (el.customModel.value || "").trim();
  return el.model.value;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function slug(text) {
  return (text || "chat")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48) || "chat";
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.className = `btn ${cls || ""}`.trim();
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderMarkdownSafe(text) {
  const raw = window.marked ? marked.parse(text || "") : (text || "").replace(/\n/g, "<br>");
  const clean = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
  return clean;
}

function enhanceCodeBlocks(root) {
  const blocks = root.querySelectorAll("pre code");
  blocks.forEach(block => {
    if (window.hljs) hljs.highlightElement(block);
    const pre = block.parentElement;
    if (!pre.querySelector(".copy-code-btn")) {
      const btn = document.createElement("button");
      btn.className = "btn small copy-code-btn";
      btn.style.position = "absolute";
      btn.style.top = "8px";
      btn.style.right = "8px";
      btn.textContent = "Copy code";
      btn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(block.innerText);
        flashStatus("Code copied");
      });
      pre.style.position = "relative";
      pre.appendChild(btn);
    }
  });
}

function scrollChatToBottom() {
  el.chatArea.scrollTop = el.chatArea.scrollHeight;
}

function renderSidebar() {
  const query = (el.chatSearch.value || "").toLowerCase().trim();
  const list = appState.chats.filter(c => !query || `${c.title} ${c.messages.map(m => m.content).join(" ")}`.toLowerCase().includes(query));
  el.chatList.innerHTML = list.length ? "" : `<div class="pill">No chats found.</div>`;

  list.forEach(chat => {
    const item = document.createElement("div");
    item.className = `chat-item ${chat.id === appState.activeChatId ? "active" : ""}`;
    const preview = (chat.messages.filter(m => m.role === "user").slice(-1)[0]?.content || "No messages yet").slice(0, 80);
    item.innerHTML = `
      <div class="chat-item-title">${escapeHtml(chat.title)}</div>
      <div class="chat-item-meta">
        <span>${escapeHtml(preview)}</span>
        <span>${new Date(chat.updatedAt).toLocaleDateString()}</span>
      </div>
    `;
    item.addEventListener("click", () => {
      appState.activeChatId = chat.id;
      syncChatToUI();
      saveState();
      renderSidebar();
    });
    el.chatList.appendChild(item);
  });
}

function createMessageNode(msg, idx, chat) {
  const wrap = document.createElement("div");
  wrap.className = `message ${msg.role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = msg.role === "user" ? "U" : "AI";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "meta-line";
  const roleLabel = msg.role === "user" ? "You" : `${chat.provider || appState.settings.provider} • ${chat.model || appState.settings.model}`;
  meta.innerHTML = `
    <div>${escapeHtml(roleLabel)}</div>
    <div>${formatTime(msg.createdAt || Date.now())}</div>
  `;

  const content = document.createElement("div");
  content.className = "content";
  content.innerHTML = renderMarkdownSafe(msg.content || "");

  const tools = document.createElement("div");
  tools.className = "tools";

  const copyBtn = button("Copy", "small", async () => {
    await navigator.clipboard.writeText(msg.content || "");
    flashStatus("Copied message");
  });

  const regenBtn = msg.role === "assistant" ? button("Regenerate", "small", () => regenerateFromIndex(idx)) : null;
  const delBtn = button("Delete", "small danger", () => deleteMessage(idx));

  tools.appendChild(copyBtn);
  if (regenBtn) tools.appendChild(regenBtn);
  tools.appendChild(delBtn);

  bubble.append(meta, content, tools);
  wrap.append(avatar, bubble);

  msg._node = wrap;
  msg._contentNode = content;
  return wrap;
}

function renderMessages() {
  const chat = getActiveChat();
  el.messages.innerHTML = "";
  if (!chat || !chat.messages.length) {
    el.messages.innerHTML = `
      <div class="panel-card" style="text-align:center; padding:32px;">
        <h2 style="margin:0 0 10px;">Start a conversation</h2>
        <p style="margin:0; color: var(--muted);">Choose a provider, paste your API key, attach files if needed, and send your first prompt.</p>
      </div>`;
    return;
  }

  chat.messages.forEach((msg, idx) => {
    if (msg.role === "system") return;
    el.messages.appendChild(createMessageNode(msg, idx, chat));
  });

  setTimeout(scrollChatToBottom, 30);
}

function renderAttachments() {
  el.fileChips.innerHTML = "";
  if (!appState.files.length) {
    el.fileChips.innerHTML = `<span class="chip">No attachments</span>`;
    return;
  }
  appState.files.forEach((f, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `<span>📎 ${escapeHtml(f.filename)}</span>`;
    const x = document.createElement("button");
    x.className = "btn icon small";
    x.textContent = "×";
    x.title = "Remove attachment";
    x.addEventListener("click", () => {
      appState.files.splice(idx, 1);
      renderAttachments();
      updateStatus("Attachment removed");
    });
    chip.appendChild(x);
    el.fileChips.appendChild(chip);
  });
}

function updateStatus(msg = "") {
  const chat = getActiveChat();
  el.statusProvider.textContent = `Provider: ${providerLabel(el.provider.value)}`;
  el.statusModel.textContent = `Model: ${effectiveModel()}`;
  el.statusChat.textContent = `Chat: ${chat ? chat.title : "New chat"}`;
  el.statusFiles.textContent = `Files: ${appState.files.length}`;
  el.statusMessage.textContent = msg || (appState.isStreaming ? "Generating..." : "Ready");
}

function flashStatus(message) {
  el.statusMessage.textContent = message;
  setTimeout(() => updateStatus(), 1600);
}

function setActiveChatTitleFromFirstUserMessage() {
  const chat = getActiveChat();
  if (!chat) return;
  if (chat.title && chat.title !== "New chat") return;
  const first = chat.messages.find(m => m.role === "user");
  if (first?.content) {
    chat.title = first.content.slice(0, 38);
  }
}

function addUserMessage(text) {
  const chat = ensureChat();
  const msg = { role: "user", content: text, createdAt: Date.now() };
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  setActiveChatTitleFromFirstUserMessage();
  saveState();
  renderSidebar();
  renderMessages();
  return msg;
}

function addAssistantMessage(initial = "") {
  const chat = ensureChat();
  const msg = { role: "assistant", content: initial, createdAt: Date.now(), usage: null, status: "streaming", startedAt: performance.now() };
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  saveState();
  renderSidebar();
  renderMessages();
  return msg;
}

function getContextMessages() {
  const chat = ensureChat();
  return chat.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({ role: m.role, content: m.content }));
}

function updateModelOptions(provider) {
  const models = appState.providerModels[provider] || [];
  el.model.innerHTML = "";
  models.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    el.model.appendChild(opt);
  });
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "Custom model...";
  el.model.appendChild(custom);

  const current = getActiveChat()?.model || appState.settings.model || models[0] || "";
  if (models.includes(current)) {
    el.model.value = current;
    el.customModelWrap.style.display = "none";
  } else {
    el.model.value = "__custom__";
    el.customModelWrap.style.display = "block";
    el.customModel.value = current || "";
  }

  const modelsB = appState.providerModels[el.providerB.value] || [];
  el.modelB.innerHTML = "";
  modelsB.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    el.modelB.appendChild(opt);
  });
  const customB = document.createElement("option");
  customB.value = "__custom__";
  customB.textContent = "Custom model...";
  el.modelB.appendChild(customB);

  const currentB = appState.settings.compareModelB || modelsB[0] || "";
  if (modelsB.includes(currentB)) {
    el.modelB.value = currentB;
    el.customModelBWrap.style.display = "none";
  } else {
    el.modelB.value = "__custom__";
    el.customModelBWrap.style.display = "block";
    el.customModelB.value = currentB;
  }
}

function updateProviderKeyField() {
  el.apiKey.value = appState.settings.apiKeys[el.provider.value] || "";
}

function composeLanguageInstruction() {
  if (appState.settings.language === "Auto") return "";
  return `Reply only in ${appState.settings.language}.`;
}

async function loadProviderInfo() {
  const res = await fetch("/api/providers");
  const data = await res.json();
  if (data.success) {
    appState.providerModels = data.models || {};
  }
}

function updateSettingsFromUI() {
  appState.settings.provider = el.provider.value;
  appState.settings.model = effectiveModel();
  appState.settings.systemPrompt = el.systemPrompt.value;
  appState.settings.language = el.language.value;
  appState.settings.temperature = parseFloat(el.temperature.value || "0.7");
  appState.settings.maxTokens = parseInt(el.maxTokens.value || "1200", 10);
  appState.settings.compareProviderB = el.providerB.value;
  appState.settings.compareModelB = el.modelB.value === "__custom__" ? (el.customModelB.value || "").trim() : el.modelB.value;
  appState.settings.apiKeys[el.provider.value] = el.apiKey.value.trim();
  saveState();
}

function finalizeChatAfterSend() {
  const chat = getActiveChat();
  if (!chat) return;
  chat.updatedAt = Date.now();
  if (!chat.title || chat.title === "New chat") {
    const firstUser = chat.messages.find(m => m.role === "user");
    if (firstUser?.content) chat.title = firstUser.content.slice(0, 36);
  }
  saveState();
  renderSidebar();
  renderMessages();
}

function estimateUsageFallback(messages, completion) {
  const promptLength = (messages || []).map(m => m.content || "").join("\n").length;
  const total = Math.ceil(promptLength / 4) + Math.ceil((completion || "").length / 4);
  return {
    prompt_tokens: Math.ceil(promptLength / 4),
    completion_tokens: Math.ceil((completion || "").length / 4),
    total_tokens: total,
    estimated: true
  };
}

function renderAssistantMeta(msg) {
  if (!msg._node) return;
  let meta = msg._node.querySelector(".assistant-meta");
  if (!meta) {
    meta = document.createElement("div");
    meta.className = "status-bar assistant-meta";
    msg._node.querySelector(".bubble").appendChild(meta);
  }
  const usage = msg.usage || {};
  meta.innerHTML = `
    <span class="status-pill">Time: ${msg.durationSeconds ? msg.durationSeconds.toFixed(2) : "—"}s</span>
    <span class="status-pill">Tokens: ${usage.total_tokens ?? "—"}</span>
    <span class="status-pill">${usage.estimated ? "Estimated usage" : "Provider usage"}</span>
  `;
}

function deleteMessage(index) {
  const chat = getActiveChat();
  if (!chat) return;
  chat.messages.splice(index, 1);
  chat.updatedAt = Date.now();
  saveState();
  renderMessages();
  renderSidebar();
}

async function regenerateFromIndex(index) {
  const chat = getActiveChat();
  if (!chat) return;
  const messages = chat.messages.slice(0, index);
  const userMessage = [...messages].reverse().find(m => m.role === "user");
  if (!userMessage) return;

  chat.messages = chat.messages.slice(0, index);
  saveState();
  renderMessages();
  await sendMessage(userMessage.content, true);
}

async function extractFiles(files) {
  if (!files || !files.length) return;
  const fd = new FormData();
  [...files].forEach(f => fd.append("files", f));
  const res = await fetch("/extract", { method: "POST", body: fd });
  const data = await res.json();
  if (data.success) {
    data.files.forEach(f => appState.files.push(f));
    renderAttachments();
    updateStatus("Files added");
  } else {
    alert(data.error || "Could not extract files");
  }
}

async function sendMessage(overrideText = null, silent = false) {
  const prompt = (overrideText ?? el.prompt.value).trim();
  if (!prompt) return;

  updateSettingsFromUI();

  if (!appState.settings.apiKeys[el.provider.value] && !silent) {
    alert("Paste your API key first.");
    return;
  }

  if (!silent) {
    addUserMessage(prompt);
    el.prompt.value = "";
  } else {
    addUserMessage(prompt);
  }

  const assistant = addAssistantMessage("");
  appState.isStreaming = true;
  updateStatus("Generating...");

  const payload = {
    provider: appState.settings.provider,
    api_key: appState.settings.apiKeys[appState.settings.provider],
    model: appState.settings.model,
    messages: getContextMessages(),
    system_prompt: appState.settings.systemPrompt + (composeLanguageInstruction() ? `\n\n${composeLanguageInstruction()}` : ""),
    attachments_text: appState.files.map(f => `### ${f.filename}\n${f.text}`).join("\n\n"),
    temperature: appState.settings.temperature,
    max_tokens: appState.settings.maxTokens,
    stream: true,
    language: appState.settings.language
  };

  try {
    const controller = new AbortController();
    appState.abortController = controller;

    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalUsage = null;
    let assistantText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.type === "chunk") {
          assistantText += obj.content;
          assistant.content = assistantText;
          assistant.status = "streaming";
          assistant._contentNode.innerHTML = renderMarkdownSafe(assistantText);
          enhanceCodeBlocks(assistant._contentNode);
          scrollChatToBottom();
        } else if (obj.type === "meta") {
          finalUsage = obj.usage || null;
          assistant.usage = finalUsage;
          assistant.status = "done";
          renderAssistantMeta(assistant);
        } else if (obj.type === "error") {
          throw new Error(obj.error || "AI provider error");
        }
      }
    }

    assistant.content = assistantText || assistant.content;
    assistant.status = "done";
    assistant.usage = finalUsage || estimateUsageFallback(payload.messages, assistantText);
    assistant.durationSeconds = (performance.now() - assistant.startedAt) / 1000;
    assistant._contentNode.innerHTML = renderMarkdownSafe(assistant.content);
    enhanceCodeBlocks(assistant._contentNode);
    renderAssistantMeta(assistant);
    finalizeChatAfterSend();
  } catch (err) {
    if (err.name === "AbortError") {
      assistant.content = assistant.content || "Generation stopped.";
      assistant.status = "stopped";
      assistant.durationSeconds = (performance.now() - assistant.startedAt) / 1000;
      assistant._contentNode.innerHTML = renderMarkdownSafe(assistant.content);
      flashStatus("Stopped");
    } else {
      assistant.content = `⚠️ ${err.message}`;
      assistant.status = "error";
      assistant.durationSeconds = (performance.now() - assistant.startedAt) / 1000;
      assistant._contentNode.innerHTML = renderMarkdownSafe(assistant.content);
      flashStatus("Error occurred");
    }
  } finally {
    appState.isStreaming = false;
    appState.abortController = null;
    updateStatus();
    saveState();
    renderSidebar();
  }
}

async function compareModeSend() {
  updateSettingsFromUI();
  const prompt = el.prompt.value.trim();
  if (!prompt) return;

  const apiKeyA = appState.settings.apiKeys[appState.settings.provider];
  const apiKeyB = appState.settings.apiKeys[appState.settings.compareProviderB];

  if (!apiKeyA || !apiKeyB) {
    alert("Paste API keys for both providers before comparing.");
    return;
  }

  addUserMessage(prompt);
  el.prompt.value = "";
  updateStatus("Comparing...");

  const payload = {
    api_key_a: apiKeyA,
    provider_a: appState.settings.provider,
    model_a: appState.settings.model,
    api_key_b: apiKeyB,
    provider_b: appState.settings.compareProviderB,
    model_b: appState.settings.compareModelB,
    messages: getContextMessages(),
    system_prompt: appState.settings.systemPrompt + (composeLanguageInstruction() ? `\n\n${composeLanguageInstruction()}` : ""),
    attachments_text: appState.files.map(f => `### ${f.filename}\n${f.text}`).join("\n\n"),
    temperature: appState.settings.temperature,
    max_tokens: appState.settings.maxTokens,
    language: appState.settings.language
  };

  const res = await fetch("/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.success) {
    alert(data.error || "Compare failed");
    return;
  }

  openCompareModal(data.comparison);
  updateStatus("Compare mode complete");
}

function openCompareModal(results) {
  const container = el.compareResults;
  container.innerHTML = "";
  results.forEach(item => {
    const card = document.createElement("div");
    card.className = "compare-card";
    card.innerHTML = `
      <h3>${escapeHtml(providerLabel(item.provider))} — ${escapeHtml(item.model)}</h3>
      <div class="content">${renderMarkdownSafe(item.response || "")}</div>
    `;
    enhanceCodeBlocks(card);
    container.appendChild(card);
  });
  el.compareBackdrop.style.display = "flex";
}

function closeCompareModal() {
  el.compareBackdrop.style.display = "none";
}

function toggleTheme() {
  appState.settings.theme = appState.settings.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = appState.settings.theme;
  saveState();
  el.themeToggle.textContent = appState.settings.theme === "light" ? "☀ Light" : "☾ Dark";
}

function createNewChat() {
  const chat = {
    id: newId(),
    title: "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    provider: appState.settings.provider,
    model: appState.settings.model,
    messages: []
  };
  appState.chats.unshift(chat);
  appState.activeChatId = chat.id;
  saveState();
  renderSidebar();
  renderMessages();
  updateStatus("New chat created");
}

function deleteCurrentChat() {
  const chat = getActiveChat();
  if (!chat) return;
  if (!confirm("Delete this chat?")) return;
  appState.chats = appState.chats.filter(c => c.id !== chat.id);
  appState.activeChatId = appState.chats[0]?.id || null;
  if (!appState.activeChatId) createNewChat();
  saveState();
  renderSidebar();
  renderMessages();
}

async function exportChat(format) {
  const chat = getActiveChat();
  if (!chat) return;
  if (format === "txt") {
    const res = await fetch("/export/txt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: chat.title, messages: chat.messages })
    });
    const blob = await res.blob();
    downloadBlob(blob, `${slug(chat.title)}.txt`);
  } else if (format === "pdf") {
    const res = await fetch("/export/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: chat.title, messages: chat.messages })
    });
    const blob = await res.blob();
    downloadBlob(blob, `${slug(chat.title)}.pdf`);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function handleVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("Voice input is not supported in this browser.");
    return;
  }
  const rec = new SR();
  rec.lang = appState.settings.language === "Tamil" ? "ta-IN" : appState.settings.language === "Hindi" ? "hi-IN" : "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  let interim = "";
  rec.onresult = (e) => {
    let text = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
    }
    interim = text;
    el.prompt.value = text;
  };
  rec.onerror = () => flashStatus("Voice input error");
  rec.onend = () => {
    if (interim) el.prompt.focus();
  };
  rec.start();
}

function stopGeneration() {
  if (appState.abortController) {
    appState.abortController.abort();
    appState.abortController = null;
  }
}

function createNewChatFromState() {
  if (!appState.chats.length) createNewChat();
}

function bindElements() {
  el.provider = $("provider");
  el.providerB = $("providerB");
  el.model = $("model");
  el.modelB = $("modelB");
  el.customModel = $("customModel");
  el.customModelB = $("customModelB");
  el.customModelWrap = $("customModelWrap");
  el.customModelBWrap = $("customModelBWrap");
  el.apiKey = $("apiKey");
  el.prompt = $("prompt");
  el.systemPrompt = $("systemPrompt");
  el.language = $("language");
  el.temperature = $("temperature");
  el.maxTokens = $("maxTokens");
  el.newChat = $("newChat");
  el.deleteChat = $("deleteChat");
  el.themeToggle = $("themeToggle");
  el.send = $("send");
  el.stop = $("stop");
  el.exportTxt = $("exportTxt");
  el.exportPdf = $("exportPdf");
  el.voiceBtn = $("voiceBtn");
  el.fileBtn = $("fileBtn");
  el.fileInput = $("fileInput");
  el.chatSearch = $("chatSearch");
  el.chatList = $("chatList");
  el.messages = $("messages");
  el.chatArea = $("chatArea");
  el.fileChips = $("fileChips");
  el.statusProvider = $("statusProvider");
  el.statusModel = $("statusModel");
  el.statusChat = $("statusChat");
  el.statusFiles = $("statusFiles");
  el.statusMessage = $("statusMessage");
  el.compareToggle = $("compareToggle");
  el.compareBackdrop = $("compareBackdrop");
  el.compareResults = $("compareResults");
  el.compareClose = $("compareClose");
  el.quickPrompt = $("quickPrompt");
}

function setupEvents() {
  el.newChat.addEventListener("click", createNewChat);
  el.deleteChat.addEventListener("click", deleteCurrentChat);
  el.themeToggle.addEventListener("click", toggleTheme);
  el.send.addEventListener("click", () => appState.settings.compareMode ? compareModeSend() : sendMessage());
  el.stop.addEventListener("click", stopGeneration);
  el.exportTxt.addEventListener("click", () => exportChat("txt"));
  el.exportPdf.addEventListener("click", () => exportChat("pdf"));
  el.voiceBtn.addEventListener("click", handleVoiceInput);
  el.fileBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", (e) => extractFiles(e.target.files));
  el.provider.addEventListener("change", () => {
    updateSettingsFromUI();
    updateModelOptions(el.provider.value);
    updateProviderKeyField();
    renderSidebar();
    updateStatus();
  });
  el.model.addEventListener("change", () => {
    el.customModelWrap.style.display = el.model.value === "__custom__" ? "block" : "none";
    updateSettingsFromUI();
  });
  el.customModel.addEventListener("input", updateSettingsFromUI);
  el.providerB.addEventListener("change", () => {
    updateSettingsFromUI();
    updateModelOptions(el.provider.value);
  });
  el.modelB.addEventListener("change", () => {
    el.customModelBWrap.style.display = el.modelB.value === "__custom__" ? "block" : "none";
    updateSettingsFromUI();
  });
  el.customModelB.addEventListener("input", updateSettingsFromUI);
  el.apiKey.addEventListener("input", updateSettingsFromUI);
  el.systemPrompt.addEventListener("input", updateSettingsFromUI);
  el.language.addEventListener("change", updateSettingsFromUI);
  el.temperature.addEventListener("input", updateSettingsFromUI);
  el.maxTokens.addEventListener("input", updateSettingsFromUI);

  el.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      appState.settings.compareMode ? compareModeSend() : sendMessage();
    }
  });

  el.chatSearch.addEventListener("input", renderSidebar);
  el.compareToggle.addEventListener("click", () => {
    appState.settings.compareMode = !appState.settings.compareMode;
    el.compareToggle.textContent = appState.settings.compareMode ? "Compare: ON" : "Compare: OFF";
    saveState();
    updateStatus(appState.settings.compareMode ? "Comparison mode enabled" : "Chat mode enabled");
  });
  el.compareClose.addEventListener("click", closeCompareModal);
  el.compareBackdrop.addEventListener("click", (e) => {
    if (e.target === el.compareBackdrop) closeCompareModal();
  });

  el.quickPrompt.addEventListener("click", () => {
    el.prompt.value = "Explain this like I'm a beginner, then give one practical example.";
    el.prompt.focus();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderSidebar();
  });
}

function syncChatToUI() {
  const chat = ensureChat();
  el.provider.value = chat.provider || appState.settings.provider;
  el.model.value = chat.model || appState.settings.model;
  el.prompt.value = "";
  el.systemPrompt.value = appState.settings.systemPrompt || "";
  el.language.value = appState.settings.language || "Auto";
  el.temperature.value = appState.settings.temperature ?? 0.7;
  el.maxTokens.value = appState.settings.maxTokens ?? 1200;
  el.providerB.value = appState.settings.compareProviderB || "openai";
  el.modelB.value = appState.settings.compareModelB || "gpt-4o-mini";
  el.apiKey.value = appState.settings.apiKeys[el.provider.value] || "";
  document.documentElement.dataset.theme = appState.settings.theme || "dark";
  el.themeToggle.textContent = appState.settings.theme === "light" ? "☀ Light" : "☾ Dark";
  updateModelOptions(el.provider.value);
  renderMessages();
  renderSidebar();
  renderAttachments();
  updateStatus();
}

async function init() {
  loadSettings();
  bindElements();
  await loadProviderInfo();
  setupEvents();

  document.documentElement.dataset.theme = appState.settings.theme || "dark";
  el.themeToggle.textContent = appState.settings.theme === "light" ? "☀ Light" : "☾ Dark";
  el.compareToggle.textContent = appState.settings.compareMode ? "Compare: ON" : "Compare: OFF";

  renderSidebar();
  syncChatToUI();
  updateSettingsFromUI();
  updateStatus();

  createNewChatFromState();
}

window.addEventListener("load", init);
