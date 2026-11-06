export type SkandhaVersion = {
  /** "0.28.2" */
  version: string;
  commit: string;
};

export enum ReputationStatus {
  OK = 0,
  THROTTLED = 1,
  BANNED = 2,
}

export * from "./IWhitelistedEntities.js";
export * from "./entities/index.js";
