export interface StorageScope {
  readonly agent?: string;
  readonly project?: string;
}

export interface StorageItem extends StorageScope {
  readonly key: string;
  readonly bytes: number;
  readonly revision: unknown;
  readonly protected?: boolean;
  readonly protectedReason?: string;
}

export interface StorageCategory {
  readonly id: string;
  readonly label: string;
  readonly risk: string;
  readonly exact?: boolean;
  readonly threshold?: string;
  readonly resetOnly?: boolean;
  readonly agentLabel?: (key: string) => string;
  readonly saveFailure?: {
    message(): string | undefined;
    retry?(): void | Promise<void>;
  };
  list(): StorageItem[] | Promise<StorageItem[]>;
  remove?(item: StorageItem): boolean | Promise<boolean>;
}

export interface StorageRow extends StorageScope {
  readonly agentLabel?: string;
  readonly resetOnly?: boolean;
  readonly protectedBytes?: number;
  readonly reasons?: readonly string[];
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly count: number;
  readonly protected: number;
  readonly exact?: boolean;
  readonly threshold?: string;
  readonly cleanable: boolean;
  readonly error?: string;
  readonly retryable?: boolean;
}

export interface CleanupPreview {
  readonly token: string;
  readonly count: number;
  readonly bytes: number;
  readonly skipped: number;
  readonly risk: string;
}

export interface CleanupResult {
  removed: number;
  skipped: number;
  failures: string[];
}

export type StorageRequest =
  | { action: "list" }
  | { action: "retry"; category: string }
  | {
      action: "preview";
      category: string;
      scope?: StorageScope;
      scopes?: StorageScope[];
    }
  | { action: "clean" | "cancel"; token: string };

export type StorageResponse = StorageRow[] | CleanupPreview | CleanupResult;

export function createStorageRegistry() {
  const categories = new Map<string, StorageCategory>();
  const plans = new Map<
    string,
    {
      expires: number;
      category: StorageCategory;
      items: StorageItem[];
      skipped: number;
    }
  >();
  let cleaning = false;

  async function request(input: StorageRequest): Promise<StorageResponse> {
    if (input.action === "retry") {
      const failure = categories.get(input.category)?.saveFailure;
      if (!failure?.retry) throw new Error("该分类没有可重试的保存操作");
      await failure.retry();
      return { removed: 0, skipped: 0, failures: [] };
    }
    if (input.action === "list") {
      return (
        await Promise.all(
          [...categories.values()].map(async (category) => {
            const base = {
              id: category.id,
              label: category.label,
              exact: category.exact,
              threshold: category.threshold,
              resetOnly: category.resetOnly,
            };
            try {
              const groups = new Map<string, StorageRow>();
              for (const item of await category.list()) {
                const key = JSON.stringify([item.agent, item.project]);
                const row = groups.get(key);
                groups.set(key, {
                  ...base,
                  agent: item.agent,
                  agentLabel: item.agent
                    ? category.agentLabel?.(item.agent)
                    : undefined,
                  protectedBytes:
                    (row?.protectedBytes ?? 0) +
                    (item.protected ? item.bytes : 0),
                  reasons: [
                    ...new Set([
                      ...(row?.reasons ?? []),
                      ...(item.protected
                        ? [item.protectedReason ?? "数据正在使用或归属待确认"]
                        : []),
                    ]),
                  ],
                  project: item.project,
                  bytes: (row?.bytes ?? 0) + item.bytes,
                  count: (row?.count ?? 0) + 1,
                  protected: (row?.protected ?? 0) + Number(!!item.protected),
                  cleanable: !!category.remove,
                });
              }
              const failure = category.saveFailure?.message();
              if (failure)
                return [
                  ...groups.values(),
                  {
                    ...base,
                    id: base.id + ":failure",
                    label: base.label,
                    bytes: 0,
                    count: 0,
                    protected: 0,
                    cleanable: false,
                    error: "未保存，关闭后可能丢失。 " + failure,
                    retryable: !!category.saveFailure?.retry,
                  },
                ];
              return [...groups.values()];
            } catch (error) {
              return [
                {
                  ...base,
                  bytes: 0,
                  count: 0,
                  protected: 0,
                  cleanable: false,
                  error: String(error),
                },
              ];
            }
          }),
        )
      ).flat();
    }

    if (input.action === "preview") {
      const category = categories.get(input.category);
      if (!category?.remove) throw new Error("该分类不可清理");
      const candidates = (await category.list()).filter((item) =>
        (input.scopes ?? (input.scope ? [input.scope] : [])).some(
          (scope) =>
            item.agent === scope.agent && item.project === scope.project,
        ),
      );
      const items = candidates.filter((item) => !item.protected);
      const skipped = candidates.length - items.length;
      const token = crypto.randomUUID();
      for (const [key, plan] of plans)
        if (plan.expires < Date.now()) plans.delete(key);
      if (plans.size >= 16) throw new Error("待确认的清理请求过多，请稍后重试");
      plans.set(token, {
        expires: Date.now() + 120_000,
        category,
        items,
        skipped,
      });
      return {
        token,
        count: items.length,
        bytes: category.resetOnly
          ? 0
          : items.reduce((sum, item) => sum + item.bytes, 0),
        skipped,
        risk: category.risk,
      };
    }

    if (input.action === "cancel") {
      plans.delete(input.token);
      return { removed: 0, skipped: 0, failures: [] };
    }
    if (input.action !== "clean" || cleaning)
      throw new Error("已有清理正在执行");
    const plan = plans.get(input.token);
    plans.delete(input.token);
    if (
      !plan ||
      plan.expires < Date.now() ||
      categories.get(plan.category.id) !== plan.category
    )
      throw new Error("清理确认已失效，请重新预览");
    const result: CleanupResult = {
      removed: 0,
      skipped: plan.skipped,
      failures: [],
    };
    cleaning = true;
    try {
      for (const item of plan.items) {
        try {
          if (
            categories.get(plan.category.id) !== plan.category ||
            !(await plan.category.remove?.(item))
          ) {
            // Owners report changed or protected records by returning false.
            result.skipped++;
          } else {
            result.removed++;
          }
        } catch (error) {
          result.failures.push(String(error));
        }
      }
      return result;
    } finally {
      cleaning = false;
    }
  }

  return {
    request,
    register(category: StorageCategory) {
      if (categories.has(category.id))
        throw new Error("存储分类重复：" + category.id);
      categories.set(category.id, category);
      return () => {
        categories.delete(category.id);
        for (const [key, plan] of plans)
          if (plan.category === category) plans.delete(key);
      };
    },
  };
}

export function settingsStorageCategory(
  id: string,
  label: string,
  read: () => object | null,
  reset: () => void,
  saveFailure?: StorageCategory["saveFailure"],
): StorageCategory {
  return {
    id,
    label,
    resetOnly: true,
    saveFailure,
    risk: "将这些 Desktop 设置恢复为默认值，保留登录状态。此操作用于重置偏好，预计不会释放空间。",
    list() {
      const values = read();
      if (!values || !Object.keys(values).length) return [];
      const revision = JSON.stringify(values);
      return [{ key: id, bytes: revision.length * 2, revision }];
    },
    remove(item) {
      if (JSON.stringify(read()) !== item.revision) return false;
      reset();
      return true;
    },
  };
}
