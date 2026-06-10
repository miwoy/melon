import type { BotDefinition, BotConfig, BotState } from "./types.js";
import type { BotDefinitionMeta, BotType } from "../types.js";

export class BotRegistry {
  private readonly definitions = new Map<BotType, BotDefinition>();

  register(definition: BotDefinition) {
    this.definitions.set(definition.type, definition);
  }

  get(type: BotType): BotDefinition<BotConfig, BotState> {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error(`未知机器人类型: ${type}`);
    return definition;
  }

  list(): BotDefinitionMeta[] {
    return [...this.definitions.values()].map(({ createInitialState: _createInitialState, onTick: _onTick, onOrderUpdate: _onOrderUpdate, onPositionUpdate: _onPositionUpdate, onStop: _onStop, ...meta }) => meta);
  }
}
