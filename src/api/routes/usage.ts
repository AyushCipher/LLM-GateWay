import { Router as ExpressRouter, Request, Response } from "express";
import { CostTracker } from "../../cost/costTracker.js";
import { BudgetEnforcer, budgetPeriod } from "../../cost/budget.js";
import { asyncHandler } from "../asyncHandler.js";

export function createUsageRouter(deps: { costTracker: CostTracker; budgetEnforcer: BudgetEnforcer }): ExpressRouter {
  const { costTracker, budgetEnforcer } = deps;
  const router = ExpressRouter();

  router.get("/v1/usage", asyncHandler(async (req: Request, res: Response) => {
    const apiKey = req.apiKey!;
    const hours = Number(req.query.hours ?? 24 * 30);

    const [usage, currentSpend] = await Promise.all([
      costTracker.getUsage(apiKey.id, hours),
      budgetEnforcer.currentSpend(apiKey.id),
    ]);

    res.json({
      apiKeyId: apiKey.id,
      windowHours: hours,
      usage,
      budget: {
        capUsdMonthly: Number(apiKey.budget_usd_monthly),
        mode: apiKey.budget_mode,
        currentMonthSpendUsd: currentSpend,
        period: budgetPeriod(),
      },
    });
  }));

  return router;
}
