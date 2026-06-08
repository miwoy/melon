import type { AccountManager } from "../accounts/AccountManager.js";
import type { Ticker } from "../types.js";
import type { BotAccountRecord, BotContext } from "./types.js";
import { BotRegistry } from "./BotRegistry.js";

export class BotRuntime {
  private readonly runningAccounts = new Set<string>();

  constructor(
    private readonly accountManager: AccountManager,
    private readonly registry: BotRegistry
  ) {}

  definitions() {
    return this.registry.list();
  }

  async onTicker(ticker: Ticker) {
    const accounts = await this.accountManager.runningBotAccounts(ticker.symbol);
    for (const account of accounts) {
      await this.runAccount(account, ticker);
    }
  }

  private async runAccount(account: BotAccountRecord, ticker: Ticker) {
    if (this.runningAccounts.has(account.id)) return;
    this.runningAccounts.add(account.id);
    try {
      const definition = this.registry.get(account.botType);
      const context: BotContext = {
        accountId: account.id,
        config: account.botConfig,
        state: account.botState,
        ticker,
        now: Date.now(),
        getAccountSnapshot: () => this.accountManager.snapshotFor(account.id),
        getStats: () => this.accountManager.accountStats(account.id),
        placeOrder: (input) => this.accountManager.executePaper({ ...input, accountId: account.id }),
        cancelOrder: (orderId) => this.accountManager.cancelPaperOrderForAccount(account.id, orderId),
        updatePositionRisk: (input) => this.accountManager.updatePaperPositionRiskForAccount(account.id, input),
        updateState: async (nextState) => {
          context.state = nextState;
          await this.accountManager.updateBotState(account.id, nextState);
        },
        stop: async (reason) => {
          await this.accountManager.stopBot(account.id, reason, "ended");
        },
        log: async (message, data) => {
          console.log(`[bot:${account.id}] ${message}`, data ?? "");
        }
      };
      await definition.onTick(context);
    } finally {
      this.runningAccounts.delete(account.id);
    }
  }
}
