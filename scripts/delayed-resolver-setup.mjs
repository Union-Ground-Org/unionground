import { vi } from "vitest";
import { configuredResolverDelay, installDelayedResolvers } from "./lib/delayed-resolver-harness.mjs";

installDelayedResolvers(vi, configuredResolverDelay(process.env.DELAYED_RESOLVER_MS ?? process.env.LANE_TA_DELAY_MS));
