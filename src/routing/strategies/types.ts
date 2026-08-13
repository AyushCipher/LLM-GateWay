export interface RoutingStrategy {
  readonly name: string;
  orderProviders(available: string[]): Promise<string[]>;
}
