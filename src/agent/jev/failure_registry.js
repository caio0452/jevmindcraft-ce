"use strict";

// Tracks which actions failed recently and when each may be retried.
//
// Failures use exponential backoff: 30s, 60s, 120s ... capped at 5 minutes.
// While an action is on cooldown, candidate builders skip it entirely.

import { FAILURE_COOLDOWN_BASE_TIME_MS } from './progression_constants.js';
import { formatRetryDelayInSeconds } from './status_describers.js';

const MAXIMUM_FAILURE_COOLDOWN_MS = 5 * 60_000;

export class FailureRegistry {
    constructor() {
        this.failureRecordsByActionId = new Map();
    }

    recordFailure(actionId, failureReason) {
        const previousRecord = this.failureRecordsByActionId.get(actionId);
        const previousFailureCount = previousRecord ? previousRecord.count : 0;
        const updatedFailureCount = previousFailureCount + 1;
        const exponentialBackoffMultiplier = (2 ** (updatedFailureCount - 1));
        const uncappedCooldown = FAILURE_COOLDOWN_BASE_TIME_MS * exponentialBackoffMultiplier;
        const cappedCooldown = Math.min(MAXIMUM_FAILURE_COOLDOWN_MS, uncappedCooldown);
        this.failureRecordsByActionId.set(actionId, {
            count: updatedFailureCount,
            reason: failureReason,
            retryAt: Date.now() + cappedCooldown
        });
    }

    isOnCooldown(actionId) {
        const failureRecord = this.failureRecordsByActionId.get(actionId);
        const hasNoRecord = !failureRecord;
        if (hasNoRecord) {
            return false;
        }
        const cooldownHasExpired = Date.now() >= failureRecord.retryAt;
        return !cooldownHasExpired;
    }

    clearFailure(actionId) {
        this.failureRecordsByActionId.delete(actionId);
    }

    summarizeActiveFailures() {
        const activeFailureSummaries = {};
        for (const [actionId, failureRecord] of this.failureRecordsByActionId) {
            const isStillCoolingDown = Date.now() < failureRecord.retryAt;
            if (!isStillCoolingDown) {
                continue;
            }
            const retryDelayInSeconds = formatRetryDelayInSeconds(failureRecord.retryAt);
            activeFailureSummaries[actionId] =
                `failed ${failureRecord.count}x (${failureRecord.reason}), retry in ${retryDelayInSeconds}s`;
        }
        return activeFailureSummaries;
    }
}
