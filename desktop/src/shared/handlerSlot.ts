/**
 * 通用订阅登记（多播）：各回调可同时有多个订阅方——transport 内部
 * （连接层的断线唤醒）与外部观察者（崩溃侦测、测试断言）并存，谁也不能
 * 顶掉谁；退订只移除自己。
 */
export class HandlerSlot<T extends (...args: never[]) => void> {
  private readonly handlers = new Set<T>();

  set(handler: T): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(...args: Parameters<T>): void {
    for (const handler of [...this.handlers]) {
      handler(...args);
    }
  }

  get isSet(): boolean {
    return this.handlers.size > 0;
  }
}
