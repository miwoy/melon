import type { AccountSnapshot, AccountStats, BotDefinitionMeta, BotStatus, BotType, CreateOrderRequest, Order, Position, RandomBotConfig, RandomBotState, Ticker, UpdatePositionRiskRequest } from "../types.js";

export type BotConfig = RandomBotConfig;
export type BotState = RandomBotState;

export type BotAccountRecord = {
  id: string;
  name: string;
  botType: BotType;
  botStatus: BotStatus;
  botConfig: BotConfig;
  botState: BotState;
  stopReason?: string;
};

export type BotContext<TConfig extends BotConfig = BotConfig, TState extends BotState = BotState> = {
  accountId: string;
  config: TConfig;
  state: TState;
  ticker: Ticker;
  now: number;
  getAccountSnapshot(): Promise<AccountSnapshot>;
  getStats(): Promise<AccountStats>;
  placeOrder(input: CreateOrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<Order>;
  updatePositionRisk(input: UpdatePositionRiskRequest): Promise<AccountSnapshot>;
  updateState(nextState: TState): Promise<void>;
  stop(reason: string): Promise<void>;
  log(message: string, data?: unknown): Promise<void>;
};

export type BotDefinition<TConfig extends BotConfig = BotConfig, TState extends BotState = BotState> = BotDefinitionMeta & {
  createInitialState(config: TConfig): TState;
  onTick(ctx: BotContext<TConfig, TState>): Promise<void>;
  onOrderUpdate?(ctx: BotContext<TConfig, TState>, order: Order): Promise<void>;
  onPositionUpdate?(ctx: BotContext<TConfig, TState>, position: Position): Promise<void>;
  onStop?(ctx: BotContext<TConfig, TState>, reason: string): Promise<void>;
};
