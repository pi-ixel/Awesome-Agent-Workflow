/**
 * 把工具开发指导的 Markdown 渲染成静态 HTML。
 *
 * 为什么在构建期渲染而不是运行期：指导文档是纯文本，没必要让 Electron 窗口
 * 再带一个 markdown 解析器；渲染一次写进 guide.html，打开即显示，也不会有
 * 脚本执行失败导致白屏的可能。这里只实现文档实际用到的语法（标题、段落、
 * 列表、代码块、表格、行内代码/粗体/链接、引用、分隔线），刻意不追求通用。
 */

const escapeHtml = (text) => text
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

/** 行内标记：先转义，再按固定顺序替换；代码片段用占位符保护，避免里面的星号被当粗体。 */
function inline(text) {
  const codes = [];
  let value = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code) => {
    codes.push(`<code>${code}</code>`);
    // 占位符用普通字符：控制字符虽然不会出现在正文里，但正则里写它会触发
    // no-control-regex，而且没有任何必要冒这个险。
    return `%%AAWCODE${codes.length - 1}%%`;
  });
  value = value
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return value.replace(/%%AAWCODE(\d+)%%/g, (_match, index) => codes[Number(index)]);
}

function renderTable(rows) {
  const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const thead = `<thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
}

const blockStart = /^\s*(```|\||#{1,3}\s|[-*]\s|\d+\.\s|>|---+\s*$)/;

/**
 * @param {string} markdown
 * @returns {{ toc: string, body: string }}
 */
export function renderGuide(markdown) {
  const lines = markdown.split(/\r?\n/);
  const toc = [];
  const out = [];
  let index = 0;
  let sectionOpen = false;
  let list = null; // "ul" | "ol" | null

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeSection = () => { if (sectionOpen) { out.push("</section>"); sectionOpen = false; } };

  while (index < lines.length) {
    const line = lines[index];

    if (/^\s*```/.test(line)) {
      closeList();
      const language = line.trim().slice(3).trim();
      const buffer = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) { buffer.push(lines[index]); index += 1; }
      index += 1;
      out.push(`<pre${language ? ` data-lang="${escapeHtml(language)}"` : ""}><code>${escapeHtml(buffer.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[index + 1] ?? "")) {
      closeList();
      const rows = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) { rows.push(lines[index].trim()); index += 1; }
      out.push(renderTable(rows));
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1) { index += 1; continue; } // 文档标题由页头承担
      if (level === 2) {
        closeList();
        closeSection();
        const id = `s${toc.length + 1}`;
        toc.push({ id, text });
        out.push(`<section class="doc-section" id="${id}"><h2>${inline(text)}</h2>`);
        sectionOpen = true;
      } else {
        out.push(`<h3>${inline(text)}</h3>`);
      }
      index += 1;
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const type = bullet ? "ul" : "ol";
      if (list && list !== type) closeList();
      if (!list) { out.push(`<${type} class="doc-list">`); list = type; }
      const text = (bullet ?? ordered)[1];
      const check = /^\[( |x)\]\s+(.*)$/.exec(text);
      if (check) out.push(`<li class="doc-check${check[1] === "x" ? " is-done" : ""}"><span aria-hidden="true"></span>${inline(check[2])}</li>`);
      else out.push(`<li>${inline(text)}</li>`);
      index += 1;
      continue;
    }

    closeList();

    if (/^\s*>/.test(line)) {
      const buffer = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) { buffer.push(lines[index].replace(/^\s*>\s?/, "")); index += 1; }
      out.push(`<blockquote>${inline(buffer.join(" "))}</blockquote>`);
      continue;
    }

    if (!line.trim()) { index += 1; continue; }

    const buffer = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (!next.trim() || blockStart.test(next)) break;
      buffer.push(next.trim());
      index += 1;
    }
    out.push(`<p>${inline(buffer.join(" "))}</p>`);
  }

  closeList();
  closeSection();

  const tocHtml = toc
    .map((item, at) => `<a href="#${item.id}"><span>${at + 1}</span>${escapeHtml(item.text)}</a>`)
    .join("");
  return { toc: tocHtml, body: out.join("\n") };
}
