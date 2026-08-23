(function () {
  "use strict";

  const CFG = Object.assign(
    { apiBase: "/api/v1", timeout: 15000, credentials: "same-origin" },
    window.APP_CONFIG || {}
  );
  const ASSIGNEES = ["张轶勃", "徐哲威", "宋东方", "张立肖", "孙杨宇鑫"];
  const STATUS = { todo: "待处理", in_progress: "处理中", resolved: "已解决" };
  const PRIORITY = { low: "低", medium: "中", high: "高" };
  const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_IMAGES = 10;
  const CARET_MARKER = "\u200B";
  const state = { items: [], editingId: null, version: null, pending: 0, failed: 0 };
  let pasteQueue = Promise.resolve();
  const $ = selector => document.querySelector(selector);
  const editor = () => $("#descriptionEditor");

  function escape(value) {
    return String(value ?? "").replace(
      /[&<>'"]/g,
      char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]
    );
  }

  function date(value) {
    return value
      ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(value)
        )
      : "—";
  }

  function imageUrl(imageId, variant) {
    return `${CFG.apiBase}/issues/images/${encodeURIComponent(imageId)}/${variant}`;
  }

  async function request(path, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.timeout);
    try {
      const res = await fetch(CFG.apiBase + path, Object.assign(
        { headers: { Accept: "application/json" }, credentials: CFG.credentials, signal: controller.signal },
        options
      ));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data.message || `请求失败（${res.status}）`);
        error.code = data.code;
        error.status = res.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  function options(select, placeholder) {
    select.innerHTML =
      (placeholder ? `<option value="">${placeholder}</option>` : "") +
      ASSIGNEES.map(name => `<option value="${name}">${name}</option>`).join("");
  }

  function filters() {
    return {
      status: $("#statusFilter").value,
      assignee: $("#assigneeFilter").value,
      q: $("#searchFilter").value.trim(),
    };
  }

  async function load() {
    const params = new URLSearchParams();
    Object.entries(filters()).forEach(([key, value]) => value && params.set(key, value));
    try {
      const result = await request(`/issues?${params}`);
      state.items = result.items;
      render();
      $("#notice").hidden = true;
    } catch (error) {
      $("#notice").textContent = `暂时无法读取问题：${error.message}`;
      $("#notice").hidden = false;
    }
  }

  function render() {
    $("#openCount").textContent = state.items.filter(item => item.status !== "resolved").length;
    $("#board").innerHTML = Object.keys(STATUS)
      .map(status => {
        const items = state.items.filter(item => item.status === status);
        return `<section class="column"><h2>${STATUS[status]} <span class="column__count">${items.length}</span></h2>${
          items.length ? items.map(card).join("") : '<p class="empty">暂无问题</p>'
        }</section>`;
      })
      .join("");
    document.querySelectorAll(".card").forEach(element =>
      element.addEventListener("click", () => showDetail(element.dataset.id))
    );
  }

  function card(item) {
    const imageHint = item.image_count
      ? `<span class="card__images">▧ ${item.image_count} 张图片</span>`
      : "";
    return `<button class="card" type="button" data-id="${item.id}"><span class="badge priority-${
      item.priority
    }">${PRIORITY[item.priority]}优先级</span><h3>${escape(item.title)}</h3><p>${escape(
      item.description
    )}</p>${imageHint}<div class="card__meta"><span>提：${escape(
      item.reporter
    )} · 责：${escape(item.assignee)}</span><time>${date(item.updated_at)}</time></div></button>`;
  }

  function defaultDocument(description) {
    return { version: 1, nodes: [{ type: "text", text: description || "" }] };
  }

  function renderDocument(document) {
    return (document?.nodes || [])
      .map(node => {
        if (node.type === "text") return `<span class="doc-text">${escape(node.text)}</span>`;
        if (node.type === "image") {
          return `<img src="${imageUrl(node.image_id, "preview")}" data-image-id="${escape(
            node.image_id
          )}" alt="${escape(node.alt)}" loading="lazy" />`;
        }
        return "";
      })
      .join("");
  }

  function activitySummary(activity) {
    if (activity.action === "created") {
      const count = activity.details.images_added || 0;
      return count ? `创建问题，添加 ${count} 张图片` : "创建问题";
    }
    const details = activity.details || {};
    const fields = Object.keys(details).filter(key => !key.startsWith("images_"));
    const parts = fields.length ? [`更新：${fields.join("、")}`] : ["更新问题"];
    if (details.images_added) parts.push(`新增 ${details.images_added} 张图片`);
    if (details.images_removed) parts.push(`移除 ${details.images_removed} 张图片`);
    return parts.join("；");
  }

  async function showDetail(id) {
    try {
      const issue = await request(`/issues/${id}`);
      const activities = issue.activities
        .map(activity => `<li>${date(activity.created_at)} · ${escape(activitySummary(activity))}</li>`)
        .join("");
      $("#detailContent").innerHTML = `<div class="detail"><div class="dialog__head"><h2>${escape(
        issue.title
      )}</h2><button class="icon-btn" type="button" data-close aria-label="关闭">×</button></div><div class="detail__meta"><span>提出人：${escape(
        issue.reporter
      )}</span><span>责任人：${escape(issue.assignee)}</span><span>${
        STATUS[issue.status]
      }</span><span>${PRIORITY[issue.priority]}优先级</span>${
        issue.component ? `<span>${escape(issue.component)}</span>` : ""
      }</div><div class="detail__description">${renderDocument(
        issue.description_doc || defaultDocument(issue.description)
      )}</div><div><strong>处理记录</strong><ul class="activity">${
        activities || "<li>暂无记录</li>"
      }</ul></div><button class="primary" type="button" id="editIssue">编辑问题</button></div>`;
      $("#detailDialog").showModal();
      $("#detailContent [data-close]").onclick = () => $("#detailDialog").close();
      $("#editIssue").onclick = () => edit(issue);
      $("#detailContent").querySelectorAll("[data-image-id]").forEach(image => {
        image.addEventListener("click", () => openLightbox(image.dataset.imageId, image.alt));
        image.addEventListener("error", () => {
          image.alt = "图片已丢失";
          image.classList.add("is-missing");
        });
      });
    } catch (error) {
      alert(error.message);
    }
  }

  function openLightbox(imageId, alt) {
    $("#lightboxImage").src = imageUrl(imageId, "original");
    $("#lightboxImage").alt = alt;
    $("#openOriginal").href = imageUrl(imageId, "original");
    $("#imageLightbox").showModal();
  }

  function createImageNode(imageId, alt) {
    const wrapper = document.createElement("span");
    wrapper.className = "editor-image";
    wrapper.contentEditable = "false";
    wrapper.dataset.imageId = imageId;
    wrapper.dataset.alt = alt;
    const image = document.createElement("img");
    image.src = imageUrl(imageId, "preview");
    image.alt = alt;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除图片");
    remove.textContent = "×";
    remove.onclick = () => {
      const caretNode = wrapper.nextSibling?.nodeType === Node.TEXT_NODE
        ? wrapper.nextSibling
        : null;
      wrapper.remove();
      if (!clearEditorIfEmpty() && caretNode?.isConnected) {
        placeCaretInText(caretNode, caretOffset(caretNode));
      }
      updateEditorState();
      editor().focus();
    };
    wrapper.append(image, remove);
    return wrapper;
  }

  function renderEditorDocument(document) {
    editor().replaceChildren();
    for (const node of (document?.nodes || [])) {
      if (node.type === "text") editor().append(documentNode(node.text));
      if (node.type === "image") editor().append(createImageNode(node.image_id, node.alt));
    }
    if (editor().lastChild?.dataset?.imageId) ensureCaretTextAfter(editor().lastChild);
    updateEditorState();
  }

  function documentNode(text) {
    return document.createTextNode(text);
  }

  function serializeEditor() {
    const nodes = [];
    let text = "";
    const flush = () => {
      if (text) nodes.push({ type: "text", text });
      text = "";
    };
    const walk = element => {
      element.childNodes.forEach((node, index) => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += (node.nodeValue || "").replaceAll(CARET_MARKER, "");
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.classList?.contains("is-uploading") || node.classList?.contains("is-failed")) {
          return;
        }
        if (node.dataset?.imageId) {
          flush();
          nodes.push({ type: "image", image_id: node.dataset.imageId, alt: node.dataset.alt });
          return;
        }
        if (node.tagName === "BR") {
          text += "\n";
          return;
        }
        walk(node);
        if (["DIV", "P"].includes(node.tagName) && index < element.childNodes.length - 1 && !text.endsWith("\n")) {
          text += "\n";
        }
      });
    };
    walk(editor());
    flush();

    const firstText = nodes.find(node => node.type === "text");
    const lastText = [...nodes].reverse().find(node => node.type === "text");
    if (firstText) firstText.text = firstText.text.trimStart();
    if (lastText) lastText.text = lastText.text.trimEnd();
    const cleanNodes = nodes.filter(node => node.type !== "text" || node.text);
    const description = cleanNodes
      .filter(node => node.type === "text")
      .map(node => node.text)
      .join("")
      .trim();
    return {
      description,
      document: { version: 1, nodes: cleanNodes.length ? cleanNodes : [{ type: "text", text: "" }] },
      imageCount: cleanNodes.filter(node => node.type === "image").length,
    };
  }

  function clearEditorIfEmpty() {
    const serialized = serializeEditor();
    if (editor().querySelector(".editor-image") || serialized.description) return false;
    editor().replaceChildren();
    return true;
  }

  function updateEditorState(message, isError) {
    const serialized = serializeEditor();
    $("#descriptionCount").textContent = `${serialized.description.length} / 10000`;
    const status = $("#editorStatus");
    if (message) status.textContent = message;
    else if (state.pending) status.textContent = `正在上传 ${state.pending} 张图片…`;
    else if (state.failed) status.textContent = `${state.failed} 张图片上传失败，请重试或移除`;
    else status.textContent = "可直接 Ctrl+V 粘贴截图";
    status.classList.toggle("editor-status-error", Boolean(isError || state.failed));
    $("#saveIssue").disabled =
      state.pending > 0 || state.failed > 0 || serialized.description.length > 10000;
  }

  function rangeInEditor() {
    const selection = window.getSelection();
    if (selection.rangeCount) {
      const range = selection.getRangeAt(0);
      if (editor().contains(range.commonAncestorContainer) || range.commonAncestorContainer === editor()) {
        return range;
      }
    }
    const range = document.createRange();
    range.selectNodeContents(editor());
    range.collapse(false);
    return range;
  }

  function insertAtCaret(node) {
    const range = rangeInEditor();
    range.deleteContents();
    range.insertNode(node);
    if (node.nodeType === Node.TEXT_NODE) {
      placeCaretInText(node, node.nodeValue?.length || 0);
    } else {
      placeCaretAfter(node);
    }
  }

  function ensureCaretTextAfter(node) {
    let caretNode = node.nextSibling;
    if (!caretNode || caretNode.nodeType !== Node.TEXT_NODE) {
      caretNode = document.createTextNode(CARET_MARKER);
      node.after(caretNode);
    } else if (!caretNode.nodeValue) {
      caretNode.nodeValue = CARET_MARKER;
    }
    return caretNode;
  }

  function caretOffset(node) {
    return node.nodeValue?.startsWith(CARET_MARKER) ? CARET_MARKER.length : 0;
  }

  function placeCaretInText(node, offset) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function placeCaretAfter(node) {
    const caretNode = ensureCaretTextAfter(node);
    placeCaretInText(caretNode, caretOffset(caretNode));
    editor().focus();
  }

  function insertPlainText(text) {
    if (!text) return;
    insertAtCaret(document.createTextNode(text));
    updateEditorState();
  }

  function uploadedImageCount() {
    return editor().querySelectorAll("[data-image-id]").length;
  }

  function validateFile(file) {
    if (!IMAGE_TYPES.has(file.type)) return "只支持 PNG、JPEG 和 WebP 图片";
    if (file.size > MAX_IMAGE_BYTES) return "单张图片不能超过 5 MiB";
    if (uploadedImageCount() + state.pending >= MAX_IMAGES) return "每个问题最多包含 10 张图片";
    return null;
  }

  function addFiles(files) {
    for (const file of files) {
      const validation = validateFile(file);
      if (validation) {
        updateEditorState(validation, true);
        continue;
      }
      const placeholder = document.createElement("span");
      placeholder.className = "editor-image is-uploading";
      placeholder.contentEditable = "false";
      placeholder.textContent = "图片上传中…";
      placeholder._file = file;
      insertAtCaret(placeholder);
      uploadInto(placeholder, file);
    }
  }

  async function uploadInto(placeholder, file) {
    placeholder.className = "editor-image is-uploading";
    placeholder.textContent = "图片上传中…";
    state.pending += 1;
    updateEditorState();
    const body = new FormData();
    body.append("image", file, file.name || "clipboard.png");
    try {
      const uploaded = await request("/issues/images", { method: "POST", body });
      const alt = `问题截图 ${uploadedImageCount() + 1}`;
      const imageNode = createImageNode(uploaded.id, alt);
      placeholder.replaceWith(imageNode);
    } catch (error) {
      state.failed += 1;
      placeholder.className = "editor-image is-failed";
      placeholder.textContent = `上传失败：${error.message}`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry-image";
      retry.textContent = "重试";
      retry.onclick = () => {
        state.failed -= 1;
        uploadInto(placeholder, file);
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", "移除失败图片");
      remove.textContent = "×";
      remove.onclick = () => {
        const caretNode = placeholder.nextSibling?.nodeType === Node.TEXT_NODE
          ? placeholder.nextSibling
          : null;
        state.failed -= 1;
        placeholder.remove();
        if (!clearEditorIfEmpty() && caretNode?.isConnected) {
          placeCaretInText(caretNode, caretOffset(caretNode));
        }
        updateEditorState();
        editor().focus();
      };
      placeholder.append(retry, remove);
    } finally {
      state.pending -= 1;
      updateEditorState();
    }
  }

  function resetEditor(document) {
    state.pending = 0;
    state.failed = 0;
    renderEditorDocument(document || defaultDocument(""));
  }

  function openNew() {
    state.editingId = null;
    state.version = null;
    $("#issueForm").reset();
    $("#dialogTitle").textContent = "新增问题";
    resetEditor(defaultDocument(""));
    $("#issueDialog").showModal();
    editor().focus();
  }

  function edit(issue) {
    state.editingId = issue.id;
    state.version = issue.version;
    $("#detailDialog").close();
    $("#dialogTitle").textContent = "编辑问题";
    const form = $("#issueForm");
    ["title", "reporter", "assignee", "priority", "status", "component", "sr", "ar"].forEach(
      key => (form.elements[key].value = issue[key] || "")
    );
    resetEditor(issue.description_doc || defaultDocument(issue.description));
    $("#issueDialog").showModal();
  }

  async function save(event) {
    event.preventDefault();
    const serialized = serializeEditor();
    if (!serialized.description && !serialized.imageCount) {
      updateEditorState("问题描述需要包含文字或图片", true);
      editor().focus();
      return;
    }
    if (state.pending || state.failed) return;

    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form));
    Object.keys(payload).forEach(key => {
      if (payload[key] === "") payload[key] = null;
    });
    payload.description = serialized.description;
    payload.description_doc = serialized.document;
    if (state.editingId) payload.version = state.version;

    $("#saveIssue").disabled = true;
    try {
      await request(state.editingId ? `/issues/${state.editingId}` : "/issues", {
        method: state.editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      $("#issueDialog").close();
      await load();
    } catch (error) {
      if (error.code === "ISSUE_VERSION_CONFLICT") {
        updateEditorState("保存冲突：此问题已被他人更新。你的内容仍在，请复制后刷新再合并。", true);
      } else {
        updateEditorState(`保存失败：${error.message}`, true);
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    options($("#assigneeFilter"), "全部人员");
    options($("#formAssignee"));
    $("#newIssue").onclick = openNew;
    $("#issueForm").onsubmit = save;
    $("#insertImage").onclick = () => $("#imagePicker").click();
    $("#imagePicker").onchange = event => {
      addFiles([...event.target.files]);
      event.target.value = "";
    };
    editor().addEventListener("input", () => updateEditorState());
    editor().addEventListener("paste", event => {
      event.preventDefault();
      const items = [...event.clipboardData.items];
      pasteQueue = pasteQueue.then(async () => {
        let insertedPlainText = false;
        for (const item of items) {
          if (item.kind === "string" && item.type.startsWith("text/plain")) {
            const text = await new Promise(resolve => item.getAsString(resolve));
            if (text) insertPlainText(text);
            insertedPlainText = true;
          } else if (item.kind === "file") {
            const file = item.getAsFile();
            if (file && IMAGE_TYPES.has(file.type)) addFiles([file]);
          }
        }
        if (!insertedPlainText) {
          const text = event.clipboardData.getData("text/plain");
          if (text) insertPlainText(text);
        }
      }).catch(error => {
        updateEditorState(`粘贴失败：${error.message}`, true);
      });
    });
    document.querySelectorAll("[data-close]").forEach(
      button => (button.onclick = () => button.closest("dialog").close())
    );
    $("#closeLightbox").onclick = () => $("#imageLightbox").close();
    ["#statusFilter", "#assigneeFilter"].forEach(selector => ($(selector).onchange = load));
    let timer;
    $("#searchFilter").oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 250);
    };
    resetEditor(defaultDocument(""));
    load();
  });
})();
