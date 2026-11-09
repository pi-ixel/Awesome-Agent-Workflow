/** ACP v1 select configuration. Unknown option types remain unsupported. */
export interface SessionConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly currentValue: string;
  readonly options: readonly {
    value: string;
    name: string;
    description?: string;
  }[];
}
