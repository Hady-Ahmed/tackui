import { PersistentAgentRunner } from "./persistent-runner";

export const runner = new PersistentAgentRunner({
  dbPath: "./data/agent-state.db",
});
