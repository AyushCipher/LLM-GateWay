import { TokenUsage } from "./types.js";

export interface StreamChunk {
  delta: string;
  usage?: TokenUsage;
}
