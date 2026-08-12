(() => {
  "use strict";

  const pageScaleRoot = document.querySelector(".aaw-page-scale");
  const baseViewportWidth = 1920;
  const maxPageScale = 2;
  let scaleFrame = 0;

  function updatePageScale() {
    if (!pageScaleRoot) return;

    const viewportWidth = document.documentElement.clientWidth;
    const scale = Math.min(maxPageScale, Math.max(1, viewportWidth / baseViewportWidth));

    pageScaleRoot.style.zoom = String(scale);
    pageScaleRoot.style.width = `${viewportWidth / scale}px`;
    pageScaleRoot.style.setProperty("--aaw-layout-height", `${window.innerHeight / scale}px`);
    document.documentElement.style.setProperty("--aaw-page-scale", String(scale));
  }

  function schedulePageScaleUpdate() {
    window.cancelAnimationFrame(scaleFrame);
    scaleFrame = window.requestAnimationFrame(updatePageScale);
  }

  updatePageScale();
  window.addEventListener("resize", schedulePageScaleUpdate, { passive: true });

  const nodeDetails = {
    "sr-init": {
      index: "01",
      type: "CONTEXT",
      title: "建立项目上下文",
      summary: "先把仓库的真实架构与工程约束沉淀下来，让后续设计不脱离现状。",
      input: "无需前置交付件；从当前仓库开始。",
      action: "调用 repo-init，梳理项目结构、架构边界与编码约束。",
      output: ".sdd/software_architecture.md（必需），并建立 SDD 工作区。",
      release: "用户必须确认初始化成果，才进入 SR 需求设计。",
      exception: "若架构文档已存在且仍然有效，可复用现有成果后直接放行。"
    },
    "sr-design": {
      index: "02",
      type: "SYSTEM REQUIREMENT",
      title: "SR 需求设计",
      summary: "把原始需求从一句话扩展成系统级、可讨论、可验证的需求设计。",
      input: "原始需求 original-requirement.md（必需）；软件架构上下文（可选但推荐）。",
      action: "澄清目标、范围、角色、流程、约束、异常与验收口径，形成系统需求决策。",
      output: ".sdd/<SR>/SR-design.md（必需）。",
      release: "成果完成后自动进入 SR 设计门禁。",
      exception: "原始需求缺失或与用户意图不一致时停止推进，先修正原文并重新确认。"
    },
    "sr-design-gate": {
      index: "03",
      type: "QUALITY GATE",
      title: "SR 设计门禁",
      summary: "用对抗式审查验证需求设计是否完整、无冲突，并且足以支持后续拆分。",
      input: "软件架构、原始需求、SR-design.md，三者共同构成审查依据。",
      action: "检查需求一致性、范围、边界、冲突、待决问题与阻塞项，并给出 pass / fail / blocked。",
      output: "门禁紧凑统计；发现问题或已有历史记录时维护 SR-design-gate.md。",
      release: "只有 pass 才可继续，且进入 AR 拆分前必须由用户确认。",
      exception: "fail 时原地修正 SR 设计后重审；blocked 时补齐必要输入或用户决策。不自动回滚。"
    },
    "ar-split": {
      index: "04",
      type: "DECISION",
      title: "选择 AR 拆分方式",
      summary: "决定一个 SR 是整体推进，还是拆成多个可独立追踪的 AR 变更。",
      input: "已通过门禁的 SR-design.md。",
      action: "向用户提出拆分建议；拆分时为每个 AR 确定稳定编号与可读标题。",
      output: "AR 列表，或 no_split 的整体推进决策；此节点不额外生成文档。",
      release: "拆分后为每个 AR 并行生成澄清链；不拆分则经用户确认进入模块边界设计。",
      exception: "AR 标识必须稳定，避免目录、追踪关系与后续产物发生漂移。"
    },
    "ar-init": {
      index: "AR",
      type: "DIRECT ENTRY",
      title: "AR 直接入口",
      summary: "当仓库已有架构基线和明确 AR 时，跳过 SR 链路，从变更澄清阶段接入。",
      input: ".sdd/software_architecture.md（必需），以及 SR、AR 编号和描述。",
      action: "确认 AR 身份；若用户提供原文、链接摘要或长描述，将其沉淀为来源材料。",
      output: ".sdd/<SR>/<AR>/AR-source.md（有原始材料时生成）。",
      release: "入口检查完成后自动汇入 AR 澄清。",
      exception: "没有架构基线时不能走 AR 入口，应先初始化仓库或改走 SR 入口。"
    },
    "ar-clarify": {
      index: "05",
      type: "CHANGE REQUIREMENT",
      title: "AR 需求澄清",
      summary: "把系统级需求收敛成一次具体变更的目标、范围与约束。",
      input: "AR 编号与描述；SR-design.md 或 AR-source.md 可作为来源上下文。",
      action: "结合需求来源与代码现状，明确本 AR 做什么、不做什么，以及已知差距与验收边界。",
      output: ".sdd/<SR>/<AR>/AR-clarify.md（必需）。",
      release: "用户必须确认澄清结果，才进入模块边界设计。",
      exception: "来源信息不足或范围仍有歧义时保持当前节点，继续澄清而不向下游转述猜测。"
    },
    "module-boundary-design": {
      index: "06",
      type: "BOUNDARY",
      title: "模块边界设计",
      summary: "确定哪些模块被影响、各自负责什么，以及它们如何协作。",
      input: "优先读取 AR-clarify.md；整体 SR 模式可直接使用 SR-design.md。",
      action: "识别受影响模块、职责分配、耦合关系、交互序列与关键边界，并进行对抗性检查。",
      output: ".sdd/<SR>/<AR>/module-boundary-design.md（必需）。",
      release: "默认请用户确认边界方案，再进入详细设计分组；自动确认模式可跳过询问。",
      exception: "职责重叠、交互不闭合或缺少必要模块时，在本节点调整边界后再推进。"
    },
    "module-detail-design-split": {
      index: "07",
      type: "FAN OUT",
      title: "模块设计分组",
      summary: "按耦合与交互关系，把受影响模块组织成可独立设计的模块组。",
      input: "module-boundary-design.md。",
      action: "提出每组 2—4 个模块的分组建议并请用户确认；小需求也必须形成至少一个组。",
      output: "module_groups 数据：中文模块目录名、模块列表和需求短名。",
      release: "为每个模块组并行创建独立的 AS-IS → TO-BE → 测试 → 门禁链。",
      exception: "分组不能割裂强耦合交互；若用户选择不拆分，则把全部模块放入同一组。"
    },
    "module-asis-analysis": {
      index: "08",
      type: "EVIDENCE",
      title: "AS-IS 事实分析",
      summary: "先证明系统现在是什么样，再讨论它应该变成什么样。",
      input: "已确认的 module-boundary-design.md。",
      action: "逆向分析代码、接口、数据与调用链，建立可引用的事实证据索引，不提前做 TO-BE 决策。",
      output: "<模块或模块组>/.context/详细设计上下文.md（必需）。",
      release: "事实上下文完整后自动进入 TO-BE 设计。",
      exception: "关键代码证据缺失时继续调查；不允许用推测填补事实，也不在此阶段修改正式设计。"
    },
    "module-tobe-design": {
      index: "09",
      type: "TARGET DESIGN",
      title: "TO-BE 目标设计",
      summary: "基于可核验的现状证据，形成明确、可实现的目标态方案。",
      input: "当前模块目录下的 .context/详细设计上下文.md。",
      action: "定义目标结构、接口、数据、流程、兼容策略、风险与工程落点；每项决策引用对应事实。",
      output: "<模块或模块组>/模块详细设计说明书.md（必需）。",
      release: "设计完成后自动进入测试用例设计。",
      exception: "发现现状证据不足时回补 AS-IS；存在未决方案时不把模糊选择继续传给开发。"
    },
    "module-test-design": {
      index: "10",
      type: "VERIFICATION",
      title: "测试用例设计",
      summary: "把设计决策翻译成可以执行、可以断言的验证方案。",
      input: "当前模块组的正式详细设计说明书。",
      action: "围绕目标行为、边界、异常、兼容与风险设计最小充分验证集，并标注优先级。",
      output: "<模块或模块组>/模块测试用例设计.md（必需）。",
      release: "测试设计完成后自动进入模块设计门禁。",
      exception: "设计不可测试或缺少预期结果时，问题回到 TO-BE 设计补齐，而不是留给开发猜测。"
    },
    "module-design-gate": {
      index: "11",
      type: "QUALITY GATE",
      title: "模块设计门禁",
      summary: "把事实、方案与验证放在一起审查，确认它们能形成闭环。",
      input: "AS-IS context、TO-BE 详细设计、测试用例设计，三份必需交付件。",
      action: "审查证据、边界、决策终局性、工程可执行性、验证覆盖与风险闭环，给出 pass / fail / blocked。",
      output: "<模块或模块组>/.context/模块设计门禁结果.md（必需）。",
      release: "只有 pass 才能进入任务拆分，且必须由用户确认这一实现边界。",
      exception: "fail 时原地修正 08—10 的成果并重新过闸；blocked 时补齐输入。除非用户明确要求，否则不回滚。"
    },
    "task-split": {
      index: "12",
      type: "EXECUTION PLAN",
      title: "有序任务拆分",
      summary: "把通过门禁的设计组织成薄任务计划，不复制或改写技术设计。",
      input: "正式详细设计、测试用例设计和结论为通过的模块设计门禁结果。",
      action: "按依赖关系生成 T1、T2…调度条目，只记录目标、范围、权威引用、依赖和状态。",
      output: "<模块或模块组>/tasks-overview.md；不生成独立 T<N> 任务文件。",
      release: "用户必须确认任务计划；随后按任务列表生成 task-dev，调度方式固定为串行。",
      exception: "任务列表为空、设计/测试覆盖不完整、存在 Open Questions 或编号被重复写入时拒绝推进。"
    },
    "task-dev": {
      index: "13",
      type: "SERIAL DELIVERY",
      title: "逐任务开发验证",
      summary: "每次只处理一个任务，由 CLI 持久化阶段和证据，压缩上下文后可从当前门禁恢复。",
      input: "任务计划、正式详细设计、测试设计、门禁结果和软件架构；规格与编码规范存在时一并继承。",
      action: "实现与测试后由两个只读 Reviewer 做语义审查；主 Agent 修复重验，再由单个 CodeCheck subAgent 完成门禁。",
      output: "工作区中的当前 Task 代码、候选 commit message，以及 tests / semantic_review / revalidation / codecheck / delivery 证据。",
      release: "只有语义 Review、重验和最终 CodeCheck 通过，且提交信息经 diff 核对后才允许 done；task-dev 不 add、不 commit。",
      exception: "任何门禁失败都停留或回退到 CLI 指定阶段；不得越阶段、跨 Task 或沿用失效证据。"
    }
  };

  const buttons = Array.from(document.querySelectorAll("[data-node]"));
  const fields = {
    index: document.getElementById("detailIndex"),
    type: document.getElementById("detailType"),
    title: document.getElementById("detailTitle"),
    code: document.getElementById("detailCode"),
    summary: document.getElementById("detailSummary"),
    input: document.getElementById("detailInput"),
    action: document.getElementById("detailAction"),
    output: document.getElementById("detailOutput"),
    release: document.getElementById("detailRelease"),
    exception: document.getElementById("detailException")
  };

  function selectNode(button) {
    const key = button.dataset.node;
    const detail = nodeDetails[key];
    if (!detail) return;

    buttons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });

    fields.index.textContent = detail.index;
    fields.type.textContent = detail.type;
    fields.title.textContent = detail.title;
    fields.code.textContent = key;
    fields.summary.textContent = detail.summary;
    fields.input.textContent = detail.input;
    fields.action.textContent = detail.action;
    fields.output.textContent = detail.output;
    fields.release.textContent = detail.release;
    fields.exception.textContent = detail.exception;
  }

  buttons.forEach((button, index) => {
    button.addEventListener("click", () => selectNode(button));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const next = buttons[(index + direction + buttons.length) % buttons.length];
      next.focus();
      selectNode(next);
    });
  });

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const original = button.textContent;
      try {
        await copyText(button.dataset.copy);
        button.textContent = "已复制";
        button.classList.add("is-copied");
      } catch {
        button.textContent = "复制失败";
      }
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove("is-copied");
      }, 1600);
    });
  });

  const terminalDemo = document.querySelector("[data-terminal-demo]");

  if (terminalDemo) {
    const input = terminalDemo.querySelector("[data-terminal-input]");
    const toggle = terminalDemo.querySelector("[data-terminal-toggle]");
    const replay = terminalDemo.querySelector("[data-terminal-replay]");
    const entryButtons = Array.from(terminalDemo.querySelectorAll("[data-terminal-entry]"));
    const entryReply = terminalDemo.querySelector("[data-terminal-entry-reply]");
    const resultLabel = terminalDemo.querySelector("[data-terminal-result-label]");
    const resultCheck = terminalDemo.querySelector("[data-terminal-result-check]");
    const resultTitle = terminalDemo.querySelector("[data-terminal-result-title]");
    const resultCopy = terminalDemo.querySelector("[data-terminal-result-copy]");
    const baseline = terminalDemo.querySelector("[data-terminal-baseline]");
    const commandText = "/aaw-workflow";
    const duration = 10500;
    const captureMode = new URLSearchParams(window.location.search).has("capture");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let activeEntry = "ar";
    let elapsed = captureMode || reducedMotion ? 8500 : 0;
    let lastTime = performance.now();
    let playing = !captureMode && !reducedMotion;
    let inView = true;
    let lastPhase = "";
    let lastInputValue = "";

    const entryContent = {
      ar: {
        reply: "AR入口",
        label: "已选择 AR 入口",
        check: "已发现软件架构基线，可直接复用",
        title: "准备执行 ar-init / ar-clarify",
        copy: "下一步：澄清本次变更的目标、范围与约束",
        baseline: "已发现软件架构基线"
      },
      sr: {
        reply: "SR入口",
        label: "已选择 SR 入口",
        check: "已接收原始需求，将原文保存为正式输入",
        title: "准备执行 sr-init",
        copy: "下一步：建立项目与架构上下文，进入 SR 设计",
        baseline: "已检查仓库基线与已有进度"
      }
    };

    function setEntry(entry) {
      activeEntry = entry;
      const content = entryContent[entry];
      terminalDemo.dataset.activeEntry = entry;
      entryButtons.forEach((button) => {
        const selected = button.dataset.terminalEntry === entry;
        button.setAttribute("aria-pressed", String(selected));
      });
      entryReply.textContent = content.reply;
      resultLabel.textContent = content.label;
      resultCheck.textContent = content.check;
      resultTitle.textContent = content.title;
      resultCopy.textContent = content.copy;
      baseline.textContent = content.baseline;
    }

    function phaseFor(time) {
      if (time < 1100) return "command-typing";
      if (time < 1450) return "command-sent";
      if (time < 2800) return "detecting";
      if (time < 3800) return "asking";
      if (time < 5000) return "entry-typing";
      if (time < 5350) return "entry-sent";
      if (time < 7000) return "launching";
      return "done";
    }

    function render() {
      const phase = phaseFor(elapsed);
      if (phase !== lastPhase) {
        terminalDemo.dataset.phase = phase;
        lastPhase = phase;
      }

      let inputValue = "";
      if (elapsed < 1100) {
        const length = Math.min(commandText.length, Math.floor((elapsed / 1100) * (commandText.length + 1)));
        inputValue = commandText.slice(0, length);
      } else if (elapsed >= 3800 && elapsed < 5000) {
        const reply = entryContent[activeEntry].reply;
        const length = Math.min(reply.length, Math.floor(((elapsed - 3800) / 1200) * (reply.length + 1)));
        inputValue = reply.slice(0, length);
      }
      if (inputValue !== lastInputValue) {
        input.textContent = inputValue;
        lastInputValue = inputValue;
      }
    }

    function updateToggle() {
      terminalDemo.dataset.playing = String(playing);
      toggle.querySelector("span").textContent = playing ? "Ⅱ" : "▶";
      toggle.querySelector("b").textContent = playing ? "暂停" : "继续";
      toggle.setAttribute("aria-label", playing ? "暂停演示" : "继续演示");
    }

    function tick(now) {
      if (playing && inView) {
        elapsed += Math.min(now - lastTime, 100);
        if (elapsed >= duration) {
          elapsed %= duration;
          lastPhase = "";
          lastInputValue = "";
        }
        render();
      }
      lastTime = now;
      window.requestAnimationFrame(tick);
    }

    entryButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setEntry(button.dataset.terminalEntry);
        elapsed = 0;
        playing = true;
        lastTime = performance.now();
        lastPhase = "";
        lastInputValue = "";
        updateToggle();
        render();
      });
    });

    toggle.addEventListener("click", () => {
      if (captureMode || reducedMotion) return;
      playing = !playing;
      lastTime = performance.now();
      updateToggle();
    });

    replay.addEventListener("click", () => {
      elapsed = 0;
      playing = !captureMode && !reducedMotion;
      lastTime = performance.now();
      lastPhase = "";
      lastInputValue = "";
      updateToggle();
      render();
    });

    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(([entry]) => {
        inView = entry.isIntersecting;
        lastTime = performance.now();
      }, { threshold: 0.08 });
      observer.observe(terminalDemo);
    }

    if (captureMode || reducedMotion) {
      toggle.disabled = true;
      toggle.setAttribute("aria-hidden", "true");
    }

    setEntry(activeEntry);
    updateToggle();
    render();
    window.requestAnimationFrame(tick);
  }

  const initial = document.querySelector('[data-node="sr-init"]');
  if (initial) selectNode(initial);
})();
