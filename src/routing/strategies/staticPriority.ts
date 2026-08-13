import { RoutingStrategy } from "./types.js";

export class StaticPriorityStrategy implements RoutingStrategy {
  readonly name = "static_priority";

  constructor(private readonly priorityOrder: string[]) {}

  async orderProviders(available: string[]): Promise<string[]> {
    const inPriority = this.priorityOrder.filter((p) => available.includes(p));
    const rest = available.filter((p) => !this.priorityOrder.includes(p));
    return [...inPriority, ...rest];
  }
}
