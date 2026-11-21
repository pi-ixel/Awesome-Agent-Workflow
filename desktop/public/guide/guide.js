/*
 * 开发指导窗口。
 *
 * 正文有两层（见 `src-tauri/src/tools/guide.rs`）：随包的默认正文，与用户自己
 * 改过的副本。窗口打开时优先向宿主读，宿主不可用（在浏览器里直接打开这个
 * 页面预览）才退回同源 fetch 的默认正文——后者是兜底，不是主路。
 *
 * 为什么自己写一个几十行的 markdown 渲染器：整份正文只有标题、列表、表格、
 * 代码块与行内标记，引入 marked 之类的库会给"一个文档窗口"增加一份要跟着
 * 升级的依赖。这里够用，而且渲染结果完全可预期。
 */
(function () {
  "use strict";

  var doc = document.getElementById("doc");
  var layout = document.getElementById("layout");
  var toc = document.getElementById("toc");
  var badge = document.getElementById("badge");
  var modeBadge = document.getElementById("mode");
  var status = document.getElementById("status");
  var editor = document.getElementById("editor");
  var editorText = document.getElementById("editor-text");
  var editButton = document.getElementById("edit");
  var resetButton = document.getElementById("reset");
  var saveButton = document.getElementById("save");
  var cancelButton = document.getElementById("cancel");

  /** 当前正文与它的来源。`editable` 表示这台窗口有宿主连接，能读写副本。 */
  var state = { markdown: "", edited: false, editable: false };
  var activeId = null;

  // 主题由 Rust 侧用 `initialization_script` 写进 `window.__aawGuideTheme`，
  // 不走 query（`WebviewUrl::App` 收的是 PathBuf，拼 query 属于边界行为）。
  // query 这条只作为旧链接与浏览器预览的兜底保留，所以顺序不能反。
  var theme = window.__aawGuideTheme;
  if (!theme) {
    try {
      theme = new URLSearchParams(location.search).get("theme");
    } catch (_) {
      theme = null;
    }
  }
  if (theme === "warm") document.documentElement.dataset.theme = "warm";

  // ── 宿主通道 ────────────────────────────────────────────────────────────

  /**
   * 调宿主命令。这个页面没有打包器，所以直接用 Tauri 注入的
   * `__TAURI_INTERNALS__`，而不是 `@tauri-apps/api` 的 import。
   */
  function invoke(command, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("当前窗口没有宿主连接"));
    }
    return internals.invoke(command, args);
  }

  function describe(error) {
    return String((error && error.message) || error);
  }

  /** 顶部一行短暂提示。错误停久一点——看漏了就没机会再看。 */
  function flash(message, bad) {
    status.textContent = message;
    status.className = bad ? "status error" : "status";
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () {
      status.textContent = "";
    }, bad ? 6000 : 2400);
  }

  // ── markdown → html ────────────────────────────────────────────────────

  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_match, label, href) {
        // 只放行 http(s) 与页内锚点：文档里不该出现 javascript: 之类的链接。
        if (!/^(https?:|#)/i.test(href)) return label;
        return '<a href="' + href.replace(/"/g, "&quot;") + '" rel="noreferrer noopener">' + label + "</a>";
      });
  }

  /** 目录里显示的纯文字：去掉行内标记，否则侧栏会出现一堆反引号和星号。 */
  function plainText(text) {
    return text.replace(/`/g, "").replace(/\*\*/g, "").trim();
  }

  /**
   * 渲染整份正文。返回 `{ html, toc }`——目录与正文必须来自同一次解析，
   * 分两次解析一定会出现"目录里有一条、正文里没有"的错位。
   */
  function render(markdown) {
    var lines = markdown.replace(/\r\n/g, "\n").split("\n");
    var html = [];
    var headings = [];
    var index = 0;
    while (index < lines.length) {
      var line = lines[index];
      if (/^\s*$/.test(line)) { index += 1; continue; }
      // 代码块
      if (/^```/.test(line)) {
        var code = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) { code.push(lines[index]); index += 1; }
        index += 1;
        html.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
        continue;
      }
      // 表格：整块连续以 | 开头的行
      if (/^\s*\|/.test(line)) {
        var rows = [];
        while (index < lines.length && /^\s*\|/.test(lines[index])) { rows.push(lines[index]); index += 1; }
        var cells = rows.map(function (row) {
          return row.trim().replace(/^\||\|$/g, "").split("|").map(function (cell) { return cell.trim(); });
        });
        var body = cells.filter(function (row) { return !row.every(function (cell) { return /^:?-{2,}:?$/.test(cell); }); });
        if (body.length) {
          html.push("<table>");
          body.forEach(function (row, rowIndex) {
            var tag = rowIndex === 0 ? "th" : "td";
            html.push("<tr>" + row.map(function (cell) { return "<" + tag + ">" + inline(cell) + "</" + tag + ">"; }).join("") + "</tr>");
          });
          html.push("</table>");
        }
        continue;
      }
      // 标题
      var heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        var level = heading[1].length;
        var id = "h" + headings.length;
        // 只有 h1–h3 进目录：h4 在这个窗口里全是"某个字段/某个参数"级别的
        // 小标题，塞进侧栏会把目录撑成一堵墙，反而找不到章节。
        if (level <= 3) headings.push({ id: id, text: plainText(heading[2]), level: level });
        html.push('<h' + level + ' id="' + id + '">' + inline(heading[2]) + "</h" + level + ">");
        index += 1;
        continue;
      }
      // 引用
      if (/^>\s?/.test(line)) {
        var quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^>\s?/, "")); index += 1; }
        html.push("<blockquote>" + inline(quote.join(" ")) + "</blockquote>");
        continue;
      }
      // 有序 / 无序列表（含缩进的子项）
      if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
        var ordered = /^\s*\d+\./.test(line);
        var items = [];
        while (index < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[index])) {
          var raw = lines[index];
          var depth = Math.floor((raw.length - raw.trimStart().length) / 2);
          items.push({ depth: depth, text: raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, "") });
          index += 1;
        }
        var tag = ordered ? "ol" : "ul";
        var depthNow = 0;
        items.forEach(function (item) {
          while (item.depth > depthNow) { html.push("<" + tag + ">"); depthNow += 1; }
          while (item.depth < depthNow) { html.push("</" + tag + ">"); depthNow -= 1; }
          html.push("<li>" + inline(item.text) + "</li>");
        });
        while (depthNow > 0) { html.push("</" + tag + ">"); depthNow -= 1; }
        continue;
      }
      if (/^\s*---+\s*$/.test(line)) { html.push("<hr>"); index += 1; continue; }
      // 段落：吸收连续的普通行
      var paragraph = [line];
      index += 1;
      while (index < lines.length && !/^\s*$/.test(lines[index]) && !/^(#{1,4}\s|```|\s*\||>\s?|\s*(?:[-*]|\d+\.)\s|---)/.test(lines[index])) {
        paragraph.push(lines[index]);
        index += 1;
      }
      html.push("<p>" + inline(paragraph.join(" ")) + "</p>");
    }
    return { html: html.join("\n"), toc: headings };
  }

  // ── 侧栏目录 ────────────────────────────────────────────────────────────

  /** 标题相对滚动容器（`main`）的位置：offsetTop 的 offsetParent 不一定是它。 */
  function offsetInDoc(element) {
    return element.getBoundingClientRect().top - doc.getBoundingClientRect().top + doc.scrollTop;
  }

  function buildToc(headings) {
    toc.textContent = "";
    activeId = null;
    if (headings.length === 0) {
      var empty = document.createElement("p");
      empty.className = "toc-empty";
      empty.textContent = "这份正文没有标题";
      toc.appendChild(empty);
      return;
    }
    headings.forEach(function (heading) {
      var link = document.createElement("a");
      link.href = "#" + heading.id;
      link.className = "toc-item toc-level-" + heading.level;
      link.setAttribute("data-target", heading.id);
      link.textContent = heading.text;
      link.addEventListener("click", function (event) {
        event.preventDefault();
        var target = document.getElementById(heading.id);
        if (target) doc.scrollTo({ top: Math.max(0, offsetInDoc(target) - 16) });
      });
      toc.appendChild(link);
    });
  }

  /** 滚动时点亮"当前章节"。用 rAF 节流：滚动事件一秒能发上百次。 */
  var scrollQueued = false;
  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    window.requestAnimationFrame(function () {
      scrollQueued = false;
      var headings = doc.querySelectorAll("h1[id], h2[id], h3[id]");
      if (headings.length === 0) return;
      var current = headings[0].id;
      for (var i = 0; i < headings.length; i += 1) {
        if (headings[i].getBoundingClientRect().top - doc.getBoundingClientRect().top <= 32) {
          current = headings[i].id;
        }
      }
      if (current === activeId) return;
      activeId = current;
      var links = toc.querySelectorAll(".toc-item");
      for (var j = 0; j < links.length; j += 1) {
        links[j].classList.toggle("active", links[j].getAttribute("data-target") === current);
      }
    });
  }

  // ── 渲染 / 编辑 / 恢复默认 ──────────────────────────────────────────────

  function applyDoc(payload) {
    state.markdown = payload.text;
    state.edited = payload.edited === true;
    var parsed = render(state.markdown);
    doc.innerHTML = parsed.html;
    doc.removeAttribute("aria-busy");
    doc.scrollTop = 0;
    buildToc(parsed.toc);
    badge.hidden = !state.edited;
    if (state.edited) {
      badge.title = "正文来自你自己改过的副本；点「恢复默认」可以回到随包版本";
    }
  }

  function showToolbar() {
    editButton.hidden = !state.editable;
    resetButton.hidden = !state.editable;
    // 没有副本时"恢复默认"没有意义，但也不该藏起来——用户会以为按钮丢了。
    // 直接置灰更清楚：知道有这个能力，只是当前不需要。
    resetButton.disabled = !state.edited;
  }

  function openEditor() {
    editorText.value = state.markdown;
    editor.hidden = false;
    layout.hidden = true;
    editButton.hidden = true;
    resetButton.hidden = true;
    // 顶栏只剩一个标题时，用户不知道自己在什么状态、怎么退出去。
    modeBadge.hidden = false;
    editorText.focus();
    editorText.setSelectionRange(0, 0);
  }

  function closeEditor() {
    editor.hidden = true;
    layout.hidden = false;
    modeBadge.hidden = true;
    showToolbar();
  }

  function save() {
    saveButton.disabled = true;
    invoke("tools_guide_save", { text: editorText.value })
      .then(function (payload) {
        applyDoc(payload);
        closeEditor();
        flash("已保存（只影响这台机器）");
      })
      .catch(function (error) {
        flash("保存失败：" + describe(error), true);
      })
      .then(function () {
        saveButton.disabled = false;
      });
  }

  function reset() {
    if (!window.confirm("恢复默认会丢掉你改过的正文，确定吗？")) return;
    resetButton.disabled = true;
    invoke("tools_guide_reset")
      .then(function (payload) {
        applyDoc(payload);
        showToolbar();
        flash("已恢复默认正文");
      })
      .catch(function (error) {
        flash("恢复默认失败：" + describe(error), true);
        showToolbar();
      });
  }

  /** 失败态：把原因原样显示出来，并给一条能动手的建议。 */
  function showFailure(error) {
    var reason = error && error.name === "AbortError"
      ? "8 秒内没有响应"
      : describe(error);
    doc.innerHTML = '<p class="error">开发指导没能加载：' + escapeHtml(reason) + "</p>" +
      '<p class="hint">关掉这个窗口重开一次通常就好；如果反复如此，说明宿主刚重启过或这次构建里缺了文档。</p>';
    doc.removeAttribute("aria-busy");
  }

  // ── 启动 ────────────────────────────────────────────────────────────────

  /**
   * 读正文。主路是宿主（能拿到用户副本），兜底是同源 fetch 的默认正文。
   * 兜底能成立，是因为 `public/guide/guide.md` 就在同一个目录里。
   */
  function load() {
    return invoke("tools_guide_load").then(function (payload) {
      state.editable = true;
      return payload;
    }, function () {
      // 8 秒还没拿到正文就主动放弃：请求一旦挂住（宿主刚重启、dev server
      // 正在换端口），窗口会永远停在"正在加载"，用户无法判断是慢还是坏。
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 8000);
      return fetch("guide.md", { cache: "no-store", signal: controller.signal })
        .then(function (response) {
          clearTimeout(timer);
          if (!response.ok) throw new Error("读不到 guide.md（HTTP " + response.status + "）");
          return response.text();
        })
        .then(function (text) {
          return { text: text, edited: false };
        });
    });
  }

  editButton.addEventListener("click", openEditor);
  cancelButton.addEventListener("click", closeEditor);
  saveButton.addEventListener("click", save);
  resetButton.addEventListener("click", reset);
  doc.addEventListener("scroll", onScroll, { passive: true });

  load()
    .then(function (payload) {
      applyDoc(payload);
      showToolbar();
    })
    .catch(showFailure);
})();
