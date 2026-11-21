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
  var askBar = document.getElementById("ask");
  var askText = document.getElementById("ask-text");
  var askOk = document.getElementById("ask-ok");
  var askCancel = document.getElementById("ask-cancel");

  /** 当前正文与它的来源。`editable` 表示这台窗口有宿主连接，能读写副本。 */
  var state = { markdown: "", edited: false, editable: false, dirty: false };
  var activeId = null;

  // 主题由 Rust 侧用 `initialization_script` 写进 `window.__aawGuideTheme`，
  // 不走 query（`WebviewUrl::App` 收的是 PathBuf，拼 query 属于边界行为）。
  // query 这条只作为旧链接与浏览器预览的兜底保留，所以顺序不能反。
  //
  // 深色是 `:root` 的默认值，所以非 warm 时必须**显式写回** "dark"：
  // 否则从暖白切回深色时属性还停在 warm 上，窗口会一直是浅色。
  function applyTheme(value) {
    document.documentElement.dataset.theme = value === "warm" ? "warm" : "dark";
  }

  var theme = window.__aawGuideTheme;
  if (!theme) {
    try {
      theme = new URLSearchParams(location.search).get("theme");
    } catch (_) {
      theme = null;
    }
  }
  applyTheme(theme);

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

  /**
   * 给一个 promise 加超时。
   *
   * 光有兜底 fetch 的超时是不够的：主路 `invoke` 一旦挂住（宿主线程堵着、
   * 命令在队列里排着），promise 永远 pending，连失败分支都进不去，窗口就
   * 会一直停在"正在加载"——和当初那个白屏一样没法判断是慢还是坏。
   */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var error = new Error("等了 " + Math.round(ms / 1000) + " 秒还没有响应");
        error.name = "TimeoutError";
        reject(error);
      }, ms);
      promise.then(
        function (value) { clearTimeout(timer); resolve(value); },
        function (error) { clearTimeout(timer); reject(error); }
      );
    });
  }

  /** 顶部一行短暂提示。错误停久一点——看漏了就没机会再看。 */
  function flash(message, bad) {
    status.textContent = message;
    // 窄窗口下状态会被截断，完整句子放在 title 里，悬停能看全。
    status.title = message;
    status.className = bad ? "status error" : "status";
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () {
      status.textContent = "";
      status.title = "";
    }, bad ? 6000 : 2400);
  }

  // ── 确认条 ──────────────────────────────────────────────────────────────

  /**
   * 页内确认条。
   *
   * 为什么不用 `window.confirm`：在 Tauri 的 WebView2 里它**不弹框**，
   * 直接返回 true（2026-11-21 实测：没有出现任何脚本对话框，JS 也没被阻塞）。
   * 拿它做「恢复默认」的二次确认等于没有确认，做「放弃修改」等于悄悄丢掉
   * 用户刚打的字。所以确认必须自己画——顺带也就可测了。
   */
  var askHandler = null;

  function ask(message, onConfirm) {
    askText.textContent = message;
    askBar.hidden = false;
    askHandler = onConfirm;
    askOk.focus();
  }

  function closeAsk() {
    askBar.hidden = true;
    askHandler = null;
  }

  askOk.addEventListener("click", function () {
    var handler = askHandler;
    closeAsk();
    if (handler) handler();
  });
  askCancel.addEventListener("click", closeAsk);

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
        // http(s) 打个标记，交给点击委托转给系统浏览器——让它在当前 webview
        // 里导航会把整个窗口换成网页，目录和编辑入口全丢。
        var external = /^https?:/i.test(href) ? ' data-external="1"' : "";
        return '<a href="' + href.replace(/"/g, "&quot;") + '"' + external +
          ' rel="noreferrer noopener">' + label + "</a>";
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
          // 表格外面套一层滚动容器：列多时在表格内部左右滚，不把整页顶宽。
          html.push('<div class="table-wrap"><table>');
          body.forEach(function (row, rowIndex) {
            var tag = rowIndex === 0 ? "th" : "td";
            html.push("<tr>" + row.map(function (cell) { return "<" + tag + ">" + inline(cell) + "</" + tag + ">"; }).join("") + "</tr>");
          });
          html.push("</table></div>");
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
    state.dirty = false;
    var parsed = render(state.markdown);
    doc.innerHTML = parsed.html;
    doc.removeAttribute("aria-busy");
    doc.scrollTop = 0;
    buildToc(parsed.toc);
    badge.hidden = !state.edited;
    if (state.edited) {
      badge.title = "正文来自你自己改过的副本；点「恢复默认」可以回到随包版本";
    }
    // 首屏不会触发 scroll 事件，目录就一个都不亮。主动算一次，
    // 否则"当前在哪一章"要等用户先滚一下才有答案。
    onScroll();
    // 副本读不出来时宿主会带一条 note：退回默认正文可以接受，但必须说出来，
    // 否则用户会以为自己的改动丢了，然后在窗口里保存一次把它真覆盖掉。
    if (payload.note) flash(payload.note, true);
  }

  function showToolbar() {
    editButton.hidden = !state.editable;
    resetButton.hidden = !state.editable;
    // 没有副本时"恢复默认"没有意义，但也不该藏起来——用户会以为按钮丢了。
    // 直接置灰更清楚：知道有这个能力，只是当前不需要。
    resetButton.disabled = !state.edited;
  }

  /**
   * 把"有没有未保存改动"同步给宿主。
   *
   * 这个比特必须放在 Rust 侧：要拦的是**原生 ×**，它不经过页面，只有窗口
   * 事件看得见。页面只负责在内容变化时上报。
   */
  function setDirty(value) {
    state.dirty = value;
    invoke("tools_guide_dirty", { dirty: value }).catch(function () {});
  }

  /**
   * 内容一变就上报，不去抖。
   *
   * 去抖看起来更省，但省错了地方：判断"能不能关"的是 Rust 侧的那个比特，
   * 用户打完最后一个字就点 × 的话，250 ms 的窗口足够让这次改动被判成
   * "没改过"、窗口直接关掉。`tools_guide_dirty` 只写一个原子变量，一次
   * IPC 比丢一段文字便宜得多。
   */
  function reportDirty() {
    setDirty(!editor.hidden && editorText.value !== state.markdown);
  }

  function openEditor() {
    editorText.value = state.markdown;
    editor.hidden = false;
    layout.hidden = true;
    editButton.hidden = true;
    resetButton.hidden = true;
    // 顶栏只剩一个标题时，用户不知道自己在什么状态、怎么退出去。
    modeBadge.hidden = false;
    setDirty(false);
    editorText.focus();
    editorText.setSelectionRange(0, 0);
  }

  function closeEditor() {
    editor.hidden = true;
    layout.hidden = false;
    modeBadge.hidden = true;
    setDirty(false);
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

  function doReset() {
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

  function reset() {
    // 不用 window.confirm：它在 WebView2 里不弹框、直接返回 true，
    // 那样「恢复默认」就是无确认删文件。
    ask("恢复默认会丢掉你改过的正文，确定吗？", doReset);
  }

  /** 失败态：把原因原样显示出来，并给一条能动手的建议。 */
  function showFailure(error) {
    var timedOut = error && (error.name === "AbortError" || error.name === "TimeoutError");
    var reason = timedOut ? "请求一直没有响应" : describe(error);
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
    return withTimeout(invoke("tools_guide_load"), 5000).then(function (payload) {
      state.editable = true;
      return payload;
    }, function (hostError) {
      // 主路失败或超时。8 秒还没拿到正文就主动放弃：请求一旦挂住（宿主刚重启、
      // dev server 正在换端口），窗口会永远停在"正在加载"，用户无法判断是慢还是坏。
      var reason = describe(hostError);
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 8000);
      return fetch("guide.md", { cache: "no-store", signal: controller.signal })
        .then(function (response) {
          clearTimeout(timer);
          if (!response.ok) throw new Error("读不到 guide.md（HTTP " + response.status + "）");
          return response.text();
        })
        .then(function (text) {
          // 降级到这里说明没有写回通道：能读、不能改。必须说出来——
          // 否则用户看到正文正常，点「编辑」却什么都没有，会以为按钮坏了。
          return {
            text: text,
            edited: false,
            note: "没能连上宿主（" + reason + "）。现在显示的是随包正文，暂时不能编辑。",
          };
        });
    });
  }

  editButton.addEventListener("click", openEditor);
  cancelButton.addEventListener("click", closeEditor);
  saveButton.addEventListener("click", save);
  resetButton.addEventListener("click", reset);
  doc.addEventListener("scroll", onScroll, { passive: true });

  // 外链一律交给系统浏览器。让它在当前 webview 里导航，窗口会整个换成网页，
  // 目录和编辑入口都没了，用户只能关掉重开。
  doc.addEventListener("click", function (event) {
    var link = event.target && event.target.closest
      ? event.target.closest("a[data-external]")
      : null;
    if (!link) return;
    event.preventDefault();
    invoke("tools_guide_open_url", { url: link.getAttribute("href") || "" })
      .catch(function (error) {
        flash("打开链接失败：" + describe(error), true);
      });
  });

  // 编辑器里的键盘习惯：Esc 退出、Ctrl/Cmd+S 保存。
  //
  // 监听挂在 document 的捕获阶段，而不是 textarea 上：用户点过确认条的
  // "取消"、或点过顶栏按钮之后，焦点就不在 textarea 里了，绑在 textarea 上
  // 的快捷键会静默失效——按 Ctrl+S 没反应，用户只会以为保存坏了。
  //
  // `isComposing` 必须先判：中文输入法用 Esc 取消候选词、用回车/空格上屏，
  // 这两下都不能被当成"退出编辑"或"提交"。
  editorText.addEventListener("input", reportDirty);
  document.addEventListener("keydown", function (event) {
    if (!askBar.hidden) {
      // 确认条显示时只认 Esc（关掉它），别让 Ctrl+S 在背后偷偷保存。
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAsk();
      }
      return;
    }
    if (editor.hidden || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (editorText.value === state.markdown) {
        closeEditor();
        return;
      }
      ask("放弃这次修改？", closeEditor);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "s") {
      event.preventDefault();
      if (!saveButton.disabled) save();
    }
  }, true);

  // 窗口重新获得焦点时问一次主题：主窗刚切过主题的话，这里跟上，不用重开。
  window.addEventListener("focus", function () {
    invoke("tools_guide_theme")
      .then(function (value) { applyTheme(value); })
      .catch(function () {});
  });

  /**
   * 原生 × 的第二次机会。Rust 侧在 dirty 时 prevent_close 并调这个函数；
   * 用户确认后走 `tools_guide_close`（destroy 不会再触发 CloseRequested）。
   */
  window.__aawGuideBeforeClose = function () {
    if (!state.dirty) {
      invoke("tools_guide_close").catch(function () {});
      return;
    }
    ask("正文有未保存的修改，确定关闭吗？", function () {
      setDirty(false);
      invoke("tools_guide_close").catch(function () {});
    });
  };

  /**
   * 把脚本发起的 `window.close()` 并回正规销毁路径。
   *
   * WebView2 里 `window.close()` 只关掉 webview 控制器，**不会关掉宿主 HWND**：
   * 窗口表里条目还在、系统也认为窗口有效，于是下次点「开发指导」只会把一个
   * 已经空白的外壳 show 出来——用户看到的就是白屏，而且没有任何窗口能关掉它。
   * （2026-11-21 用 CDP 实测：调用后 target 列表里页面消失，但 `IsWindow(hwnd)`
   * 仍返回真。）`tools_guide_close` 走的是 `window.destroy()`，整窗一起退。
   */
  window.close = function () {
    // 走和原生 × 完全相同的那道门：有未保存改动就先问一句。
    if (window.__aawGuideBeforeClose) {
      window.__aawGuideBeforeClose();
      return;
    }
    invoke("tools_guide_close").catch(function () {});
  };

  load()
    .then(function (payload) {
      applyDoc(payload);
      showToolbar();
    })
    .catch(showFailure);
})();
