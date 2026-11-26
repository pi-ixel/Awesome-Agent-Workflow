/**
 * 讲解图套件运行时：注册 v-* 自定义元素。
 *
 * 本函数必须自包含（不引用模块作用域的任何东西）：沙箱路径用
 * `installVisualKit.toString()` 把同一份代码内联进 iframe，内联路径在
 * 主窗口直接调用。图标表由调用方作为参数传入。
 *
 * 元素都在 connectedCallback 里一次性补齐结构（dataset.vReady 防重入）；
 * 内联路径插入的是已完整解析的片段，沙箱路径在正文之后才执行本脚本，
 * 两种情况下升级时子节点都已就位。
 */
export function installVisualKit(
  win: Window & typeof globalThis,
  icons: Readonly<Record<string, string>>,
  aliases: Readonly<Record<string, string>>,
): void {
  const registry = win.customElements;
  if (registry.get("v-box") !== undefined) return;

  const svgOpen =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const iconSvg = (raw: string | null): string => {
    const name = (raw ?? "").trim().toLowerCase();
    const body = icons[name] ?? icons[aliases[name] ?? ""] ?? icons.dot ?? "";
    return `${svgOpen}${body}</svg>`;
  };
  const make = (
    owner: Element,
    tag: string,
    className?: string,
    text?: string | null,
  ) => {
    const node = owner.ownerDocument.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };
  const firstRun = (element: HTMLElement): boolean => {
    if (element.dataset.vReady === "1") return false;
    element.dataset.vReady = "1";
    return true;
  };
  /** 标题属性转存为 data-title，避免整块悬停出现原生提示。 */
  const takeTitle = (element: HTMLElement): string | null => {
    const title = element.getAttribute("title");
    if (title !== null) {
      element.dataset.title = title;
      element.removeAttribute("title");
      return title;
    }
    return element.dataset.title ?? null;
  };
  const childrenOf = (element: Element, tag: string): HTMLElement[] =>
    Array.from(element.children).filter(
      (child): child is HTMLElement => child.localName === tag,
    );

  class VBox extends win.HTMLElement {
    connectedCallback() {
      if (!firstRun(this)) return;
      const title = takeTitle(this);
      const sub = this.getAttribute("sub");
      if (!title && !sub) return;
      const head = make(this, "div", "v-head");
      if (title) head.append(make(this, "div", "v-title", title));
      if (sub) head.append(make(this, "div", "v-sub", sub));
      this.prepend(head);
    }
  }

  class VItem extends win.HTMLElement {
    connectedCallback() {
      if (!firstRun(this)) return;
      const title = takeTitle(this);
      const sub = this.getAttribute("sub");
      const body = make(this, "div", "v-body");
      const content = Array.from(this.childNodes);
      if (title) {
        body.append(make(this, "div", "v-title", title));
        if (sub) body.append(make(this, "div", "v-sub", sub));
        if (content.length > 0) {
          const extra = make(this, "div", "v-sub");
          extra.append(...content);
          body.append(extra);
        }
      } else {
        const main = make(this, "div", "v-title");
        main.append(...content);
        body.append(main);
        if (sub) body.append(make(this, "div", "v-sub", sub));
      }
      this.replaceChildren();
      const icon = this.getAttribute("icon");
      if (icon) {
        const glyph = make(this, "span", "v-glyph");
        glyph.innerHTML = iconSvg(icon);
        this.append(glyph);
      }
      this.append(body);
    }
  }

  class VIcon extends win.HTMLElement {
    connectedCallback() {
      if (!firstRun(this)) return;
      const title = takeTitle(this);
      this.innerHTML = iconSvg(this.getAttribute("name"));
      if (title) {
        this.setAttribute("role", "img");
        this.setAttribute("aria-label", title);
      }
    }
  }

  class VGrid extends win.HTMLElement {
    connectedCallback() {
      if (!firstRun(this)) return;
      const cols = Number(this.getAttribute("cols"));
      if (Number.isFinite(cols) && cols > 0)
        this.style.setProperty(
          "--v-cols",
          String(Math.min(Math.floor(cols), 12)),
        );
      const repeat = Math.min(Number(this.getAttribute("repeat")) || 0, 200);
      const template = this.firstElementChild;
      if (template === null) return;
      for (let count = this.childElementCount; count < repeat; count += 1)
        this.append(template.cloneNode(true));
    }
  }

  class VArrow extends win.HTMLElement {
    connectedCallback() {
      if (!firstRun(this)) return;
      const direction = (
        this.getAttribute("to") ??
        this.getAttribute("dir") ??
        ""
      )
        .trim()
        .toLowerCase();
      const parent = this.parentElement?.localName ?? "";
      const vertical =
        direction === "down" ||
        direction === "up" ||
        (direction === "" && parent !== "v-row");
      const both = direction === "both";
      const reverse = direction === "left" || direction === "up";
      if (vertical) this.dataset.axis = "y";
      // 箭头字形按轴向预先定义：箭杆两端正好落在箭尖上，箭头与箭杆合成
      // 一条路径，任何方向都不会错位露头。横向（.v-h）与竖向（.v-v）两个
      // 字形都生成，由样式按所在位置显示其一：横排改竖排时直接换竖向字形，
      // 不靠旋转，长度与线宽和普通竖向箭头一致。end = 右 / 下，start = 左 / 上。
      const glyph = (
        cls: string,
        view: string,
        shaft: string,
        end: string,
        start: string,
      ) =>
        `<svg class="${cls}" viewBox="${view}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${shaft}${both || !reverse ? end : ""}${both || reverse ? start : ""}"/></svg>`;
      const label = this.getAttribute("label") ?? takeTitle(this);
      this.replaceChildren();
      if (label) this.append(make(this, "span", "v-label", label));
      this.insertAdjacentHTML(
        "beforeend",
        glyph(
          "v-h",
          "0 0 48 16",
          "M2 8H46",
          "M41 3 46 8 41 13",
          "M7 3 2 8 7 13",
        ) +
          glyph(
            "v-v",
            "0 0 16 32",
            "M8 2V30",
            "M3 25 8 30 13 25",
            "M3 7 8 2 13 7",
          ),
      );
    }
  }

  class VTabs extends win.HTMLElement {
    connectedCallback() {
      if (!firstRun(this)) return;
      const tabs = childrenOf(this, "v-tab");
      if (tabs.length === 0) return;
      const bar = make(this, "div", "v-bar");
      bar.setAttribute("role", "tablist");
      const buttons = tabs.map((tab, index) => {
        const button = make(
          this,
          "button",
          "v-kbtn",
          tab.getAttribute("label") ?? takeTitle(tab) ?? String(index + 1),
        );
        button.setAttribute("type", "button");
        button.setAttribute("role", "tab");
        tab.setAttribute("role", "tabpanel");
        button.addEventListener("click", () => select(index));
        bar.append(button);
        return button;
      });
      const select = (active: number) => {
        tabs.forEach((tab, index) => (tab.hidden = index !== active));
        buttons.forEach((button, index) =>
          button.setAttribute("aria-selected", String(index === active)),
        );
      };
      const initial = tabs.findIndex((tab) => tab.hasAttribute("active"));
      select(initial < 0 ? 0 : initial);
      this.prepend(bar);
    }
  }

  class VSteps extends win.HTMLElement {
    connectedCallback() {
      if (!firstRun(this)) return;
      const steps = childrenOf(this, "v-step");
      if (steps.length === 0) return;
      const chevron = (path: string) =>
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
      const nav = make(this, "div", "v-nav");
      const previous = make(this, "button", "v-kbtn") as HTMLButtonElement;
      previous.type = "button";
      previous.setAttribute("aria-label", "上一步");
      previous.innerHTML = chevron("m15 18-6-6 6-6");
      const next = make(this, "button", "v-kbtn") as HTMLButtonElement;
      next.type = "button";
      next.setAttribute("aria-label", "下一步");
      next.innerHTML = chevron("m9 18 6-6-6-6");
      const progress = make(this, "div", "v-progress");
      const label = make(this, "span", "v-step-label");
      const dots = make(this, "span", "v-dots");
      const marks = steps.map(() => make(this, "i"));
      dots.append(...marks);
      progress.append(label, dots);
      nav.append(previous, progress, next);
      let current = 0;
      const show = (index: number) => {
        current = Math.max(0, Math.min(steps.length - 1, index));
        steps.forEach((step, position) => (step.hidden = position !== current));
        marks.forEach((mark, position) =>
          mark.toggleAttribute("data-on", position === current),
        );
        const name =
          steps[current]?.getAttribute("label") ??
          takeTitle(steps[current]!) ??
          "";
        label.textContent = `${current + 1} / ${steps.length}${name ? ` · ${name}` : ""}`;
        previous.disabled = current === 0;
        next.disabled = current === steps.length - 1;
      };
      previous.addEventListener("click", () => show(current - 1));
      next.addEventListener("click", () => show(current + 1));
      show(0);
      this.append(nav);
    }
  }

  /**
   * 横排放不下时自动改竖排：按子元素构成估算横排最小宽度（含条目的方框
   * 170、其余 140；带标签箭头 104、无标签 64；胶囊标签 72、图标 40；
   * 间距 12）。只依赖自身宽度，
   * 竖排后宽度不变，不会来回切换。宁可竖排也不把内容挤成逐字换行。
   */
  class VRow extends win.HTMLElement {
    private observer: ResizeObserver | null = null;
    private frame = 0;
    connectedCallback() {
      if (this.observer !== null || typeof win.ResizeObserver === "undefined")
        return;
      let last = "";
      // 只读源码属性：v-row 先于子元素升级，此时箭头标签节点还没生成
      const needed = () =>
        Array.from(this.children).reduce(
          (sum, child) => {
            if (child.localName === "v-arrow")
              return (
                sum +
                (child.hasAttribute("label") ||
                child.hasAttribute("title") ||
                child.hasAttribute("data-title")
                  ? 104
                  : 64)
              );
            if (child.localName === "v-tag") return sum + 72;
            if (child.localName === "v-icon") return sum + 40;
            return sum + (child.querySelector("v-item") === null ? 140 : 170);
          },
          Math.max(0, this.childElementCount - 1) * 12,
        );
      const apply = () => {
        this.frame = 0;
        const width = this.clientWidth;
        if (width <= 0) return;
        const need = needed();
        const key = `${width}/${need}`;
        if (key === last) return;
        last = key;
        this.toggleAttribute("data-stack", width < need);
      };
      // 回调里改布局会触发 ResizeObserver 循环告警，切换挪到下一帧
      this.observer = new win.ResizeObserver(() => {
        if (this.frame === 0) this.frame = win.requestAnimationFrame(apply);
      });
      this.observer.observe(this);
      apply();
    }
    disconnectedCallback() {
      this.observer?.disconnect();
      this.observer = null;
      win.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  class VPlain extends win.HTMLElement {}

  registry.define("v-row", VRow);
  registry.define("v-box", VBox);
  registry.define("v-item", VItem);
  registry.define("v-icon", VIcon);
  registry.define("v-grid", VGrid);
  registry.define("v-arrow", VArrow);
  registry.define("v-tabs", VTabs);
  registry.define("v-steps", VSteps);
  for (const tag of ["v-col", "v-tag", "v-text", "v-note", "v-tab", "v-step"])
    registry.define(tag, class extends VPlain {});
}

/**
 * 自绘 SVG 按 viewBox 宽度作为实际像素宽度，窄屏等比缩小、不放大：
 * 未写宽度（或写 100%）的 SVG 默认撑满容器，文字会被一起放大。
 * 同样必须自包含，沙箱路径经 toString() 内联。
 */
export function fitVisualSvgs(root: ParentNode): void {
  for (const svg of Array.from(root.querySelectorAll("svg[viewBox]"))) {
    if (
      svg.parentElement?.closest("svg") ||
      svg.closest("v-icon, v-arrow, v-item, v-steps")
    )
      continue;
    const width = svg.getAttribute("width");
    if (width !== null && width.trim() !== "" && !width.trim().endsWith("%"))
      continue;
    const box = (svg.getAttribute("viewBox") ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const boxWidth = box[2];
    if (box.length !== 4 || boxWidth === undefined || !(boxWidth > 0)) continue;
    svg.setAttribute("width", String(boxWidth));
    svg.removeAttribute("height");
    (svg as SVGSVGElement).style.maxWidth = "100%";
    (svg as SVGSVGElement).style.height = "auto";
  }
}
