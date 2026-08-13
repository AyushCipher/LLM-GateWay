export interface RoutingStrategy {
  readonly name: string;
  /** Returns providers ordered best-first. The router tries them in this order, falling back on failure. */
  orderProviders(available: string[]): Promise<string[]>;
}
