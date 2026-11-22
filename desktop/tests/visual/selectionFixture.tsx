import { useState } from "react";
import {
  Checkbox,
  Listbox,
  RadioDot,
  ToggleSwitch,
} from "../../src/shared/ui/controls.tsx";
import { SegmentedControl } from "../../src/shared/ui/SettingsPageParts.tsx";
import { QuestionChoices } from "../../src/plugins/project/interactions/ui/QuestionPanel.tsx";

const options = [
  { value: "one", label: "一" },
  { value: "two", label: "二" },
];

export function SelectionFixture({
  showLongList = false,
}: {
  readonly showLongList?: boolean;
}) {
  const [checked, setChecked] = useState(false);
  const [choice, setChoice] = useState("one");
  const [answer, setAnswer] = useState<string[]>([]);
  const [checks, setChecks] = useState<string[]>([]);
  return (
    <section
      aria-label="选择控件"
      className="grid gap-3 rounded-lg bg-surface p-4 text-ui-base text-ink"
    >
      <Checkbox label="复选" checked={checked} onChange={setChecked} />
      <Checkbox
        label="禁用复选"
        checked={checked}
        onChange={setChecked}
        disabled
      />
      <div className="flex gap-2">
        <Checkbox
          label="一"
          appearance="pill"
          accessibleName="圆形复选"
          checked={checked}
          onChange={setChecked}
        />
        <Checkbox
          label="二"
          appearance="pill"
          accessibleName="禁用圆形复选"
          checked={checked}
          onChange={setChecked}
          disabled
        />
      </div>
      {(["accent", "neutral"] as const).map((appearance) => (
        <div key={appearance} className="flex items-center gap-3">
          <ToggleSwitch
            label={appearance + " 开关"}
            checked={checked}
            onChange={setChecked}
          />
          <ToggleSwitch
            label={appearance + " 禁用开关"}
            checked={checked}
            onChange={setChecked}
            disabled
          />
          {options.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-1">
              <input
                type="radio"
                name={appearance}
                aria-label={appearance + label}
                className="peer sr-only"
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
              />
              <RadioDot checked={choice === value} appearance={appearance} />
              {label}
            </label>
          ))}
        </div>
      ))}
      {(["default", "quiet"] as const).map((appearance) => (
        <div key={appearance} className="flex gap-2">
          <Listbox
            appearance={appearance}
            label={appearance + " 列表"}
            value={choice}
            options={options}
            onChange={setChoice}
          />
          <Listbox
            appearance={appearance}
            label={appearance + " 禁用列表"}
            value={choice}
            options={options}
            onChange={setChoice}
            disabled
          />
        </div>
      ))}
      <SegmentedControl
        groupLabel="分段选择"
        options={options}
        value={choice}
        onChange={setChoice}
        warnValue="two"
      />
      {showLongList && (
        <Listbox
          appearance="quiet"
          label="可用工作区"
          value={choice}
          onChange={setChoice}
          options={Array.from({ length: 22 }, (_, index) => ({
            value: String(index + 1),
            label: `工作区 ${index + 1} · desktop-theme-selection-and-keyboard-regression-checks`,
            group: index < 11 ? "本地项目" : "归档项目",
          }))}
          fullWidth
          showSelectionMark
        />
      )}
      <fieldset className="min-w-0" aria-label="问答单选">
        <QuestionChoices
          options={options}
          selected={answer}
          onToggle={(value) =>
            setAnswer((current) => (current.includes(value) ? [] : [value]))
          }
        />
      </fieldset>
      <fieldset className="min-w-0" aria-label="问答多选">
        <QuestionChoices
          multi
          options={options}
          selected={checks}
          onToggle={(value) =>
            setChecks((current) =>
              current.includes(value)
                ? current.filter((item) => item !== value)
                : [...current, value],
            )
          }
        />
      </fieldset>
      <fieldset aria-label="正在提交" disabled>
        <QuestionChoices
          options={options}
          selected={answer}
          onToggle={() => {}}
        />
      </fieldset>
      <SegmentedControl
        groupLabel="分段页签"
        tabs
        options={options}
        value={choice}
        onChange={setChoice}
      />
    </section>
  );
}
