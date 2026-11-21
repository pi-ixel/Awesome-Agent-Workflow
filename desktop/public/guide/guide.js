/*
 * 开发指导窗口。
 *
 * 正文来自 `public/guide/guide.md`——它由 `npm run tools:guide-skill` 从
 * `runtime/guide.ts` 生成，与写进工具项目 `AGENTS.md`、用户技能目录的是同一段
 * 文字。窗口里看到的和 AI 读到的不可能互相矛盾。
 *
 * 为什么自己写一个几十行的 markdown 渲染器：整份正文只有标题、列表、表格、
 * 代码块与行内标记，引入 marked 之类的库会给"一个文档窗口"增加一份要跟着
 * 升级的依赖。这里够用，而且渲染结果完全可预期。
 */
(function () {
  "use strict";
  var doc = document.getElementById("doc");

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

  function render(markdown) {
    var lines = markdown.replace(/\r\n/g, "\n").split("\n");
    var html = [];
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
        html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
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
    return html.join("\n");
  }

  fetch("guide.md", { cache: "no-store" })
    .then(function (response) {
      if (!response.ok) throw new Error("读不到 guide.md（" + response.status + "）");
      return response.text();
    })
    .then(function (markdown) {
      doc.innerHTML = render(markdown);
      doc.removeAttribute("aria-busy");
      // 页面底色跟随宿主主题：启动器与主窗都这么做，文档窗口不该例外。
      try {
        var theme = new URLSearchParams(location.search).get("theme");
        if (theme === "warm") document.documentElement.dataset.theme = "warm";
      } catch (_) { /* 没有主题参数就用默认深色 */ }
    })
    .catch(function (error) {
      doc.innerHTML = '<p class="loading">' + escapeHtml(String(error.message || error)) + "</p>";
    });
})();
