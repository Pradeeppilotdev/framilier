import { Config } from "../../src/config";
import { NetworkConfig } from "../../src/interfaces";
import {
  BundlingService,
  EntryPointService,
  EventsService,
  ExecutorEventBus,
  MempoolService,
  ReputationService,
  SubscriptionService,
  UserOpValidationService,
} from "../../src/services";
import { LocalDbController } from "../mocks/database";
import { ChainId } from "../constants";
import { logger } from "../mocks/logger";
import { Skandha } from "../../src/modules";

export async function getServices(
  config: Config,
  networkConfig: NetworkConfig
) {
  const publicClient = config.getPublicClient();
  const db = new LocalDbController("test");
  const reputationService = new ReputationService(
    db,
    config.chainId,
    networkConfig.minInclusionDenominator,
    networkConfig.throttlingSlack,
    networkConfig.banSlack,
    BigInt(networkConfig.minStake),
    networkConfig.minUnstakeDelay
  );

  const eventBus = new ExecutorEventBus();
  const subscriptionService = new SubscriptionService(eventBus, logger);

  const entryPointService = new EntryPointService(
    config.chainId,
    networkConfig,
    publicClient,
    db,
    logger
  );

  const mempoolService = new MempoolService(
    db,
    ChainId,
    entryPointService,
    reputationService,
    eventBus,
    networkConfig,
    logger
  );

  const skandha = new Skandha(
    mempoolService,
    entryPointService,
    ChainId,
    publicClient,
    config,
    logger
  );

  const userOpValidationService = new UserOpValidationService(
    skandha,
    publicClient,
    entryPointService,
    reputationService,
    mempoolService,
    ChainId,
    config,
    logger
  );

  const bundlingService = new BundlingService(
    ChainId,
    publicClient,
    entryPointService,
    mempoolService,
    userOpValidationService,
    reputationService,
    eventBus,
    config,
    logger,
    null,
    "classic"
  );

  const eventsService = new EventsService(
    ChainId,
    networkConfig,
    reputationService,
    mempoolService,
    entryPointService,
    publicClient,
    eventBus,
    db,
    logger
  );

  bundlingService.setBundlingMode("manual");

  return {
    skandha,
    reputationService,
    userOpValidationService,
    mempoolService,
    bundlingService,
    entryPointService,
    eventsService
  };
}
